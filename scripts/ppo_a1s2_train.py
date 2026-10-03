"""Explicit, resumable A1S2 adapted-PPO entry; never trains on import/prepare."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import torch

from scripts import ppo_rounds as rounds
from scripts import ppo_train as ppo
from scripts.ppo_a1s2_adapt import OUTPUT, load_parent
from scripts.ppo_auxiliary import config as auxiliary_config, load as load_auxiliary, sha256
from scripts.ppo_network_factory import ADAPTED_MAP, make_network

ROOT = ppo.ROOT / "PPO训练"
STATE = ROOT / ".state" / "A1S2-adapted"
INITIAL = STATE / "initial.pt"
CHECKPOINT = STATE / "latest.pt"
REPORT = STATE / "training-report.json"
PLAN = STATE / "run-plan.json"
RESULTS = ROOT / "A1S2" / "适应后PPO"
AUXILIARY = OUTPUT / "辅助示范.pt"
SEED = 20266930
WORKERS = 8


def read_initial():
    if not INITIAL.is_file():
        raise FileNotFoundError("请先显式运行 prepare；没有自动创建训练起点")
    initial = torch.load(INITIAL, map_location="cpu", weights_only=False)
    derived = torch.load(OUTPUT / "模型.pt", map_location="cpu", weights_only=False)
    client = ppo.ArenaClient()
    try:
        encoder, _, parent = load_parent(client)
        model = make_network(ADAPTED_MAP, encoder)
        model.load_state_dict(initial["modelState"])
        digest = ppo.model_weights_sha256(model)
        if (initial.get("format") != "quartermaster-ppo-comparison-initial-v1" or
            initial.get("experimentId") != "A1S2" or
            initial.get("networkArchitecture") != ADAPTED_MAP or
            initial.get("network") != {"stateDim": encoder.state_dim,
                                       "candidateDim": encoder.candidate_dim} or
            initial.get("buildFingerprint") != client.fingerprint or
            initial.get("parent") != parent or
            initial.get("sourceModelFileSha256") != sha256(OUTPUT / "模型.pt") or
            digest != derived.get("weightsSha256") != initial.get("weightsSha256")):
            raise ValueError("A1S2 adapted initial, source or current build differs")
        aux = auxiliary_config(AUXILIARY, initial["auxiliaryInitialWeight"],
                               initial["auxiliaryDecayUpdates"])
        load_auxiliary(AUXILIARY, digest, client.fingerprint, encoder)
        return initial, aux
    finally:
        client.close()


def prepare(weight=0.05, decay_updates=20):
    if not 0 <= weight <= 1 or decay_updates < 1:
        raise ValueError("Invalid auxiliary configuration")
    if INITIAL.exists():
        initial, _ = read_initial()
        if initial["auxiliaryInitialWeight"] != weight or initial["auxiliaryDecayUpdates"] != decay_updates:
            raise ValueError("现有初始化的辅助配置不同；不得无声覆盖")
        return initial
    if CHECKPOINT.exists() or PLAN.exists():
        raise ValueError("已有检查点或运行计划，但没有初始化；请检查实验状态")
    client = ppo.ArenaClient()
    try:
        encoder, _, parent = load_parent(client)
        derived = torch.load(OUTPUT / "模型.pt", map_location="cpu", weights_only=False)
        model = make_network(ADAPTED_MAP, encoder)
        model.load_state_dict(derived["modelState"])
        digest = ppo.model_weights_sha256(model)
        if (derived.get("weightsSha256") != digest or derived.get("parent") != parent or
            derived.get("buildFingerprint") != client.fingerprint):
            raise ValueError("派生模型与父模型或构建不符")
        load_auxiliary(AUXILIARY, digest, client.fingerprint, encoder)
        initial = {"format": "quartermaster-ppo-comparison-initial-v1",
                   "experimentId": "A1S2", "networkArchitecture": ADAPTED_MAP,
                   "network": {"stateDim": encoder.state_dim,
                               "candidateDim": encoder.candidate_dim},
                   "buildFingerprint": client.fingerprint,
                   "encoderVersion": ppo.ENCODER_VERSION, "resourceMode": "A",
                   "entropyCoefficient": 0.01, "weightsSha256": digest,
                   "sourceModelFileSha256": sha256(OUTPUT / "模型.pt"),
                   "parent": parent, "auxiliaryDataSha256": sha256(AUXILIARY),
                   "auxiliaryInitialWeight": weight, "auxiliaryDecayUpdates": decay_updates,
                   "optimizerInitialization": "new-Adam-no-S2MAP-momentum",
                   "modelState": model.state_dict()}
        STATE.mkdir(parents=True, exist_ok=True)
        temporary = INITIAL.with_suffix(".tmp")
        torch.save(initial, temporary)
        os.replace(temporary, INITIAL)
        return initial
    finally:
        client.close()


def progress(initial):
    if not CHECKPOINT.exists():
        if REPORT.exists():
            raise ValueError("报告存在但检查点缺失")
        return 0
    saved = torch.load(CHECKPOINT, map_location="cpu", weights_only=False)
    if (saved.get("experimentId") != "A1S2" or
        saved.get("networkArchitecture") != ADAPTED_MAP or
        saved.get("initialWeightsSha256") != initial["weightsSha256"] or
        saved.get("completedEpisodes") != saved.get("update", -1) * 40 or
        saved.get("trainingSeed") != SEED or
        saved.get("nextSeed") != SEED + saved.get("update", -1) * 40):
        raise ValueError("A1S2 adapted checkpoint progress differs")
    if not REPORT.exists():
        raise ValueError("检查点存在但报告缺失")
    report = json.loads(REPORT.read_text(encoding="utf-8"))
    if (report.get("experimentId") != "A1S2" or
        report.get("experimentConfigSha256") != saved.get("experimentConfigSha256") or
        not report.get("updates") or report["updates"][-1]["number"] != saved["update"]):
        raise ValueError("A1S2 adapted checkpoint/report boundary differs")
    return saved["update"]


def save_plan(plan):
    STATE.mkdir(parents=True, exist_ok=True)
    temporary = PLAN.with_suffix(".tmp")
    temporary.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, PLAN)


def complete_round(number, initial, aux, dry_run):
    current = progress(initial)
    target = number * 10
    output = RESULTS / f"第{number:03d}轮"
    if output.exists():
        if all((output / name).is_file() for name in
               (rounds.WEIGHTS_NAME, rounds.RECORD_NAME, "评估.json")) and current >= target:
            return
        raise ValueError(f"已有不完整结果：{output}")
    if current > target:
        raise ValueError("检查点已越过无成果的轮次，不能用新权重伪造旧轮")
    print(f"A1S2 适应后PPO第{number}轮：更新 {current}→{target}，"
          f"{(target-current)*40}局，资源A，熵0.01，8环境；辅助损失另计")
    if dry_run:
        return
    if current < target:
        command = [sys.executable, "scripts/ppo_train.py", "--mode", "A",
                   "--experiment-id", "A1S2", "--architecture", ADAPTED_MAP,
                   "--entropy-coefficient", "0.01", "--initial-weights", str(INITIAL),
                   "--expected-initial-hash", initial["weightsSha256"],
                   "--auxiliary-data", str(AUXILIARY),
                   "--auxiliary-weight", str(initial["auxiliaryInitialWeight"]),
                   "--auxiliary-decay-updates", str(initial["auxiliaryDecayUpdates"]),
                   "--card-set", "events", "--workers", str(WORKERS),
                   "--updates", str(target-current), "--seed", str(SEED),
                   "--checkpoint", str(CHECKPOINT), "--report", str(REPORT)]
        if current:
            command.append("--resume")
        subprocess.run(command, cwd=ppo.ROOT, check=True)
    RESULTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".A1S2-{number:03d}-", dir=RESULTS) as directory:
        stage = Path(directory)
        digest = rounds.export_weights(CHECKPOINT, stage / rounds.WEIGHTS_NAME,
                                       "A", number, SEED, experiment_id="A1S2")
        rounds.record_game(CHECKPOINT, stage / rounds.RECORD_NAME, "A", number,
            SEED, digest, experiment_id="A1S2", entropy_coefficient=0.01,
            initial_weights_sha256=initial["weightsSha256"],
            architecture=ADAPTED_MAP, auxiliary_config=aux)
        # Fixed, separate evaluation does not enter PPO trajectories.
        client = ppo.ArenaClient()
        try:
            encoder = ppo.Encoder(client.schema)
            model = make_network(ADAPTED_MAP, encoder)
            model.load_state_dict(torch.load(CHECKPOINT, map_location="cpu",
                                             weights_only=False)["modelState"])
            rows = ppo.evaluation(client, encoder, model, torch.device("cpu"),
                                  "A", list(range(20700000, 20700005)), 3000)
            (stage / "评估.json").write_text(json.dumps({"fixedSeeds": list(range(20700000, 20700005)),
                "reference": "existing-frozen-rule-opponent-not-a-strength-benchmark",
                "games": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
        finally:
            client.close()
        os.replace(stage, output)


def train(rounds_to_add=None, continue_plan=False, dry_run=False):
    initial, aux = read_initial()
    current = progress(initial)
    plan = json.loads(PLAN.read_text(encoding="utf-8")) if PLAN.exists() else None
    if plan and plan["status"] == "pending":
        if rounds_to_add is not None or not continue_plan and not dry_run:
            raise ValueError("未完成计划存在；使用 --continue-plan，不重复增加预算")
    else:
        if continue_plan:
            raise ValueError("没有未完成计划")
        if rounds_to_add is None or rounds_to_add < 1:
            raise ValueError("新增轮数必须为正整数")
        if current % 10:
            raise ValueError("上次停在轮内；请先恢复原计划")
        plan = {"format": "quartermaster-a1s2-adapted-plan-v1", "status": "pending",
                "baseRound": current // 10, "addedRounds": rounds_to_add,
                "targetRound": current // 10 + rounds_to_add,
                "initialWeightsSha256": initial["weightsSha256"],
                "initialFileSha256": sha256(INITIAL),
                "auxiliaryConfig": aux, "mode": "A", "entropy": 0.01,
                "workers": WORKERS, "trainingSeed": SEED}
        if not dry_run:
            save_plan(plan)
    if (plan["initialWeightsSha256"] != initial["weightsSha256"] or
        plan["initialFileSha256"] != sha256(INITIAL) or
        plan["auxiliaryConfig"] != aux or plan["trainingSeed"] != SEED):
        raise ValueError("运行计划的模型、示范或种子身份不符")
    for number in range(plan["baseRound"] + 1, plan["targetRound"] + 1):
        complete_round(number, initial, aux, dry_run)
    if not dry_run:
        plan["status"] = "completed"
        save_plan(plan)


def main():
    parser = argparse.ArgumentParser(description="A1S2 adapted PPO; explicit train only")
    parser.add_argument("stage", choices=["verify", "prepare", "train"])
    parser.add_argument("--rounds", type=int)
    parser.add_argument("--continue-plan", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.stage == "prepare":
        print(json.dumps({k: v for k, v in prepare().items() if k != "modelState"},
                         ensure_ascii=False, indent=2))
    elif args.stage == "verify":
        initial, aux = read_initial()
        print(json.dumps({"source": str(OUTPUT / "模型.pt"), "initial": str(INITIAL),
                          "modelWeightsSha256": initial["weightsSha256"],
                          "checkpointUpdates": progress(initial),
                          "auxiliary": aux, "plan": str(PLAN) if PLAN.exists() else None},
                         ensure_ascii=False, indent=2))
    else:
        train(args.rounds, args.continue_plan, args.dry_run)


if __name__ == "__main__":
    main()
