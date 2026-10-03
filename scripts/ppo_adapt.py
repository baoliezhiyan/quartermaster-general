"""Explicit A1 round-12 -> action-semantics adaptation; never resumes old A1."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

import torch

from scripts import ppo_rounds as rounds
from scripts import ppo_train as ppo

EXPERIMENT = "A1S1"
ENTROPY = 0.01
WORKERS = 8
TRAINING_SEED = 20265730  # A1's 120 complete updates consumed seeds 20260930..20265729.
BASELINE_ROUND = 12
PLAN_NAME = "adaptation-plan-A1S1.json"
INITIAL_NAME = "adapt-initial-A1S1.pt"


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def baseline(root):
    path = root / "A1" / f"第{BASELINE_ROUND:03d}轮" / rounds.WEIGHTS_NAME
    if not path.is_file():
        raise ValueError(f"缺少 A1 第12轮原始权重：{path}")
    saved = torch.load(path, map_location="cpu", weights_only=False)
    if (saved.get("format") != "quartermaster-ppo-weights-v1" or
        saved.get("experimentId") != "A1" or saved.get("round") != BASELINE_ROUND or
        saved.get("entropyCoefficient") != ENTROPY or saved.get("mode") != "A" or
        saved.get("encoderVersion") != "ppo-vector-v5-repeat-build"):
        raise ValueError("A1 第12轮权重身份与预期不符")
    return path, saved, sha256_file(path)


def migrate_model(saved, encoder):
    old = saved["network"]
    if old["stateDim"] > encoder.state_dim or old["candidateDim"] >= encoder.candidate_dim:
        raise ValueError("适应迁移要求状态与候选编码仅追加新字段")
    model = ppo.PpoNetwork(encoder.state_dim, encoder.candidate_dim)
    target = model.state_dict()
    for name, tensor in saved["modelState"].items():
        if name == "state_net.0.weight":
            if tensor.shape[0] != target[name].shape[0]:
                raise ValueError("状态层输出维度不符")
            target[name][:, :old["stateDim"]] = tensor
            target[name][:, old["stateDim"]:] = 0
        elif name == "candidate_net.0.weight":
            if tensor.shape[0] != target[name].shape[0]:
                raise ValueError("候选层输出维度不符")
            target[name][:, :old["candidateDim"]] = tensor
            target[name][:, old["candidateDim"]:] = 0
        elif name in target and target[name].shape == tensor.shape:
            target[name] = tensor
        else:
            raise ValueError(f"A1 权重无法逐层迁移：{name}")
    model.load_state_dict(target)
    return model


def initial_weights(root, create):
    base_path, old, base_hash = baseline(root)
    path = root / ".state" / INITIAL_NAME
    if not create and not path.exists():
        return path, None, base_hash
    client = ppo.ArenaClient()
    try:
        encoder = ppo.Encoder(client.schema)
        if path.exists():
            initial = torch.load(path, map_location="cpu", weights_only=False)
            if (initial.get("format") != "quartermaster-ppo-comparison-initial-v1" or
                initial.get("sourceModelSha256") != base_hash or
                initial.get("buildFingerprint") != client.fingerprint or
                initial.get("network") != {"stateDim": encoder.state_dim,
                                           "candidateDim": encoder.candidate_dim}):
                raise ValueError("适应初始权重与 A1 原件或当前训练构建不符")
            model = ppo.PpoNetwork(encoder.state_dim, encoder.candidate_dim)
            model.load_state_dict(initial["modelState"])
            digest = ppo.model_weights_sha256(model)
            if digest != initial.get("weightsSha256"):
                raise ValueError("适应初始权重哈希不符")
            return path, digest, base_hash
        model = migrate_model(old, encoder)
        digest = ppo.model_weights_sha256(model)
        payload = {"format": "quartermaster-ppo-comparison-initial-v1",
                   "seed": TRAINING_SEED, "sourceExperiment": "A1",
                   "sourceRound": BASELINE_ROUND, "sourceModelSha256": base_hash,
                   "migration": "candidate-input-prefix-copy-new-columns-zero-v1",
                   "buildFingerprint": client.fingerprint,
                   "network": {"stateDim": encoder.state_dim,
                               "candidateDim": encoder.candidate_dim},
                   "weightsSha256": digest, "modelState": model.state_dict()}
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        torch.save(payload, temporary)
        os.replace(temporary, path)
        return path, digest, base_hash
    finally:
        client.close()


def progress(root, initial_hash):
    checkpoint = root / ".state" / EXPERIMENT / "latest.pt"
    report = checkpoint.with_name("training-report.json")
    outputs = sorted((root / EXPERIMENT).glob("第*轮")) if (root / EXPERIMENT).exists() else []
    if not checkpoint.exists():
        if report.exists() or outputs:
            raise ValueError("适应成果存在但检查点丢失")
        return 0, 0
    saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
    if (saved.get("experimentId") != EXPERIMENT or saved.get("mode") != "A" or
        saved.get("encoderVersion") != ppo.ENCODER_VERSION or
        saved.get("rewardConfig") != ppo.REWARD_CONFIG or
        saved.get("optimizerConfig", {}).get("entropy") != ENTROPY or
        saved.get("trainingSeed") != TRAINING_SEED or
        saved.get("initialWeightsSha256") != initial_hash or
        saved.get("completedEpisodes") != 40 * saved.get("update", -1) or
        saved.get("nextSeed") != TRAINING_SEED + 40 * saved.get("update", -1)):
        raise ValueError("适应检查点身份、预算或配置不符")
    if not report.is_file():
        raise ValueError("适应检查点有报告缺失")
    content = json.loads(report.read_text(encoding="utf-8"))
    if (content.get("experimentId") != EXPERIMENT or
        len(content.get("updates", [])) != saved["update"]):
        raise ValueError("适应报告与检查点不符")
    for number, output in enumerate(outputs, 1):
        if output.name != f"第{number:03d}轮" or not all(
                (output / name).is_file() for name in (rounds.WEIGHTS_NAME, rounds.RECORD_NAME)):
            raise ValueError(f"适应轮次成果不完整：{output}")
    if saved["update"] < len(outputs) * 10 or saved["update"] > (len(outputs) + 1) * 10:
        raise ValueError("适应轮次与更新数不一致")
    return len(outputs), saved["update"]


def run_round(root, number, initial_path, initial_hash, dry_run):
    complete, update = progress(root, initial_hash) if initial_hash else (0, 0)
    if complete >= number:
        return
    target = number * 10
    output = root / EXPERIMENT / f"第{number:03d}轮"
    print(f"{EXPERIMENT}（资源A/熵0.01/惩罚-0.01）：第{number}轮，更新 {update}→{target}；"
          f"{(target-update)*40}局；8环境。", flush=True)
    if dry_run:
        return
    checkpoint = root / ".state" / EXPERIMENT / "latest.pt"
    report = checkpoint.with_name("training-report.json")
    if update < target:
        command = [sys.executable, "scripts/ppo_train.py", "--mode", "A",
                   "--experiment-id", EXPERIMENT, "--entropy-coefficient", str(ENTROPY),
                   "--initial-weights", str(initial_path), "--expected-initial-hash", initial_hash,
                   "--card-set", "events", "--workers", str(WORKERS), "--updates", str(target-update),
                   "--seed", str(TRAINING_SEED), "--checkpoint", str(checkpoint),
                   "--report", str(report)]
        if update:
            command.append("--resume")
        subprocess.run(command, cwd=ppo.ROOT, check=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".stage-{EXPERIMENT}-{number:03d}-",
                                     dir=output.parent) as temporary:
        stage = Path(temporary)
        digest = rounds.export_weights(checkpoint, stage / rounds.WEIGHTS_NAME,
                                       "A", number, TRAINING_SEED, experiment_id=EXPERIMENT)
        rounds.record_game(checkpoint, stage / rounds.RECORD_NAME, "A", number,
            TRAINING_SEED, digest, experiment_id=EXPERIMENT,
            entropy_coefficient=ENTROPY, initial_weights_sha256=initial_hash)
        os.replace(stage, output)
    print(f"{EXPERIMENT} 第{number}轮成果完成：{output}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="从保留的 A1 第12轮迁移，手动运行语义适应训练")
    parser.add_argument("--rounds", type=int)
    parser.add_argument("--continue-plan", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--result-root", type=Path, default=rounds.DEFAULT_RESULTS)
    args = parser.parse_args()
    if args.rounds is not None and args.rounds < 1:
        parser.error("轮数必须为正整数")
    if args.rounds is not None and args.continue_plan:
        parser.error("新增轮数与继续计划不能同时指定")
    root = args.result_root.resolve()
    old_plan = root / ".state" / "comparison-plan.json"
    if old_plan.exists() and json.loads(old_plan.read_text(encoding="utf-8")).get("status") == "pending":
        raise ValueError("旧 A1/A2 对照计划未完成；不能静默覆盖或继续 A2")
    plan_path = root / ".state" / PLAN_NAME
    existing = json.loads(plan_path.read_text(encoding="utf-8")) if plan_path.exists() else None
    pending = existing and existing.get("status") == "pending"
    if pending:
        if args.rounds is not None:
            parser.error("已有未完成适应计划；请用 --continue-plan")
        if not args.continue_plan and not args.dry_run:
            if input("已有未完成 A1S1 计划。输入 C 继续：").strip().upper() != "C":
                raise SystemExit("原计划未改变")
        plan = existing
    else:
        if args.continue_plan:
            parser.error("没有未完成的适应计划")
        if args.rounds is None:
            raw = input("本次新增 A1S1 适应轮数（建议先 1～2，正整数）：").strip()
            if not raw.isdecimal() or int(raw) < 1:
                parser.error("轮数必须为正整数")
            args.rounds = int(raw)
        initial_path, initial_hash, base_hash = initial_weights(root, create=False)
        completed, _ = progress(root, initial_hash) if initial_hash else (0, 0)
        plan = {"format": "quartermaster-ppo-adaptation-plan-v1", "status": "pending",
                "experimentId": EXPERIMENT, "resourceMode": "A", "entropyCoefficient": ENTROPY,
                "workers": WORKERS, "seed": TRAINING_SEED, "baselineRound": BASELINE_ROUND,
                "baselineModelSha256": base_hash, "initialWeightsSha256": initial_hash,
                "baseRounds": completed, "addedRounds": args.rounds,
                "targetRounds": completed + args.rounds,
                "rewardConfig": ppo.REWARD_CONFIG, "encoderVersion": ppo.ENCODER_VERSION}
        if not args.dry_run:
            if not torch.cuda.is_available():
                raise RuntimeError("没有 CUDA GPU，未启动适应训练")
            initial_path, initial_hash, base_hash = initial_weights(root, create=True)
            plan["initialWeightsSha256"] = initial_hash
            atomic_json(plan_path, plan)
    base_path, _, base_hash = baseline(root)
    if plan["baselineModelSha256"] != base_hash or plan["rewardConfig"] != ppo.REWARD_CONFIG or \
            plan["encoderVersion"] != ppo.ENCODER_VERSION or plan["entropyCoefficient"] != ENTROPY:
        raise ValueError("适应计划与 A1 第12轮原件或当前实验语义不符")
    initial_path = root / ".state" / INITIAL_NAME
    if plan["initialWeightsSha256"]:
        _, actual_hash, _ = initial_weights(root, create=False)
        if actual_hash != plan["initialWeightsSha256"]:
            raise ValueError("适应初始权重与计划不符")
    print(f"计划：只训练 {EXPERIMENT}，资源模式A、熵0.01；从 A1 第12轮迁移。"
          f"本次新增 {plan['addedRounds']}轮={plan['addedRounds']*10}次更新="
          f"{plan['addedRounds']*400}局；不启动 A2/B。", flush=True)
    print(f"A1 原始权重保留：{base_path}；结果：{root / EXPERIMENT}", flush=True)
    if args.dry_run and not plan["initialWeightsSha256"]:
        for number in range(plan["baseRounds"] + 1, plan["targetRounds"] + 1):
            print(f"预览：{EXPERIMENT} 第{number}轮，10次更新、400局")
        return
    for number in range(plan["baseRounds"] + 1, plan["targetRounds"] + 1):
        run_round(root, number, initial_path, plan["initialWeightsSha256"], args.dry_run)
    if not args.dry_run:
        plan["status"] = "completed"
        atomic_json(plan_path, plan)


if __name__ == "__main__":
    main()
