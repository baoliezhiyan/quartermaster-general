"""Manual A2S1C1 combo-course rounds; importing never starts training."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import torch

from scripts import ppo_rounds as rounds
from scripts import ppo_train as ppo
from scripts.ppo_combo_course import MIX, VERSION, pool_identity, read_pool
from scripts.ppo_combo_metrics import VERSION as COMBO_METRICS_VERSION
from scripts.ppo_combo_replay import record_course
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network

ROOT = ppo.ROOT / "PPO训练"
STATE = ROOT / ".state" / "A2S1C1"
INITIAL = STATE / "initial.pt"
POOL = STATE / "course-pool-v1.json.gz"
CHECKPOINT = STATE / "latest.pt"
REPORT = STATE / "training-report.json"
PLAN = STATE / "plan.json"
OUTPUT = ROOT / "A2S1C1"
SEED = 20261004
WORKERS = 8


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def identity():
    initial = torch.load(INITIAL, map_location="cpu", weights_only=False)
    if (initial.get("experimentId") != "A2S1C1" or
            initial.get("sourceExperimentId") != "A2S1" or
            initial.get("networkArchitecture") != A2S1_ADAPTER or
            initial.get("rewardConfig") != ppo.reward_config("signals") or
            initial.get("optimizerMigration") != "new-Adam-no-old-momentum"):
        raise ValueError("A2S1C1 initial model has the wrong identity or reward migration")
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        model = make_network(A2S1_ADAPTER, encoder)
        model.load_state_dict(initial["modelState"], strict=True)
        if (client.fingerprint != initial["buildFingerprint"] or
                ppo.model_weights_sha256(model) != initial["weightsSha256"]):
            raise ValueError("A2S1C1 initial build or weight fingerprint differs")
        expected = pool_identity(client, initial["sourceCheckpointSha256"],
                                 initial["weightsSha256"])
        entries = read_pool(POOL, expected)["entries"]
        if len(entries) != 32:
            raise ValueError("Course pool is incomplete")
        course_config = {"version": VERSION, "mix": MIX,
            "poolIdentitySha256": expected["identitySha256"],
            "poolFileSha256": sha(POOL), "metricsVersion": COMBO_METRICS_VERSION}
        return initial, entries, course_config
    finally:
        client.close()


def progress(initial, course_config):
    if not CHECKPOINT.exists():
        return 0
    saved = torch.load(CHECKPOINT, map_location="cpu", weights_only=False)
    if (saved.get("experimentId") != "A2S1C1" or saved.get("mode") != "A" or
            saved.get("cardSet") != "signals" or
            saved.get("networkArchitecture") != A2S1_ADAPTER or
            saved.get("initialWeightsSha256") != initial["weightsSha256"] or
            saved.get("comboCourseConfig") != course_config or
            saved.get("rewardConfig") != ppo.reward_config("signals") or
            saved.get("trainingSeed") != SEED or
            saved.get("completedEpisodes") != saved.get("update", -1) * 40):
        raise ValueError("A2S1C1 checkpoint identity or complete-batch count differs")
    return saved["update"]


def output_rounds():
    number = 0
    while all((OUTPUT / f"第{number + 1:03d}轮" / filename).is_file() for filename in
              (rounds.WEIGHTS_NAME, rounds.RECORD_NAME, "正常开局-概率抽样.jsonl",
               "课程-G2.jsonl", "课程-U2.jsonl", "课程-J2.jsonl", "评估概览.json")):
        number += 1
    return number


def save_plan(plan):
    PLAN.parent.mkdir(parents=True, exist_ok=True)
    temporary = PLAN.with_suffix(".tmp")
    temporary.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, PLAN)


def show(initial, course_config, updates, plan):
    print("A2S1C1 连携课程：资源A，熵0.01，8环境，每次40局（正常28＋课程12），10更新/轮。")
    print(f"父模型 A2S1 更新{initial['sourceUpdate']}，权重 {initial['weightsSha256']}。")
    print(f"规则指纹 {initial['buildFingerprint']}；奖励 {initial['rewardConfig']['actionWasteVersion']}。")
    print(f"课程 {course_config['version']}；池 {course_config['poolFileSha256']}。")
    print(f"已完成更新 {updates}（{updates * 40}局）；完整输出轮次 {output_rounds()}。")
    if plan:
        print(f"未完成计划目标：{plan['targetRound']}轮/{plan['targetRound'] * 10}更新；"
              f"还需 {max(0, plan['targetRound'] * 10 - updates)} 更新。")


def complete_round(number, initial, entries, course_config, dry_run=False):
    target_update = number * 10
    current = progress(initial, course_config)
    output = OUTPUT / f"第{number:03d}轮"
    if output.exists():
        if number <= output_rounds() and current >= target_update:
            print(f"A2S1C1 第{number}轮已有完整产物，跳过。")
            return
        raise RuntimeError(f"Existing incomplete round cannot be overwritten: {output}")
    if current > target_update:
        raise RuntimeError("Checkpoint passed a missing round; old weights cannot be reconstructed")
    print(f"A2S1C1 第{number}轮：更新 {current}→{target_update}，"
          f"还需 {(target_update - current) * 40} 局。")
    if dry_run:
        return
    if current < target_update:
        command = [sys.executable, "scripts/ppo_train.py", "--mode", "A",
            "--experiment-id", "A2S1C1", "--architecture", A2S1_ADAPTER,
            "--entropy-coefficient", "0.01", "--initial-weights", str(INITIAL),
            "--expected-initial-hash", initial["weightsSha256"],
            "--combo-pool", str(POOL), "--card-set", "signals", "--workers", str(WORKERS),
            "--updates", str(target_update - current), "--seed", str(SEED),
            "--checkpoint", str(CHECKPOINT), "--report", str(REPORT)]
        if current:
            command.append("--resume")
        subprocess.run(command, cwd=ppo.ROOT, check=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".combo-round-{number:03d}-", dir=OUTPUT) as temporary:
        stage = Path(temporary)
        digest = rounds.export_weights(CHECKPOINT, stage / rounds.WEIGHTS_NAME,
                                       "A", number, SEED, experiment_id="A2S1C1")
        normal_report = []
        for filename, seed, deterministic in (
                (rounds.RECORD_NAME, 20610001, True),
                ("正常开局-概率抽样.jsonl", 20610002, False)):
            normal_report.append({"filename": filename, "seed": seed,
                "deterministic": deterministic, "result": rounds.record_game(
                CHECKPOINT, stage / filename, "A", number, SEED, digest,
                experiment_id="A2S1C1", entropy_coefficient=.01,
                initial_weights_sha256=initial["weightsSha256"],
                architecture=A2S1_ADAPTER, card_set="signals", deterministic=deterministic,
                seed_override=seed, course_config=course_config)})
        client = ppo.ArenaClient(card_set="signals")
        try:
            encoder = ppo.Encoder(client.schema)
            model = make_network(A2S1_ADAPTER, encoder)
            optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
            ppo.restore_checkpoint(CHECKPOINT, model, optimizer, encoder, client, "A",
                __import__("random").Random(), "signals", training_seed=SEED,
                experiment_id="A2S1C1", entropy_coefficient=.01,
                initial_weights_sha256=initial["weightsSha256"], architecture=A2S1_ADAPTER,
                course_config=course_config)
            course_report = []
            for template in ("G2", "U2", "J2"):
                entry = next(item for item in entries if item["template"] == template and
                             item["variant"] == "positive" and item["layer"] == "preparation")
                course_report.append(record_course(model, encoder, entry,
                    stage / f"课程-{template}.jsonl", {"experimentId": "A2S1C1",
                    "round": number, "policyVersion": number * 10,
                    "modelSha256": digest, "courseConfig": course_config}, deterministic=True))
            (stage / "课程回放说明.json").write_text(json.dumps(course_report,
                ensure_ascii=False, indent=2), encoding="utf-8")
            (stage / "评估概览.json").write_text(json.dumps({
                "normalStarts": normal_report, "courseStarts": course_report,
                "interpretation": "Same-policy self-play and course continuation are interface/behavior diagnostics; not a strength benchmark."},
                ensure_ascii=False, indent=2), encoding="utf-8")
        finally:
            client.close()
        os.replace(stage, output)
    print(f"A2S1C1 第{number}轮完成：{output}")


def run(args):
    initial, entries, course_config = identity()
    updates = progress(initial, course_config)
    plan = json.loads(PLAN.read_text(encoding="utf-8")) if PLAN.exists() else None
    if args.command == "show":
        show(initial, course_config, updates, plan)
        return
    if args.command == "new":
        if plan:
            raise RuntimeError("Existing plan must be resumed before adding a new budget")
        if not args.rounds or args.rounds <= 0:
            raise ValueError("New round count must be a positive integer")
        finished = output_rounds()
        if updates != finished * 10:
            raise RuntimeError("A completed update lacks its round output; inspect before starting a new plan")
        plan = {"format": "quartermaster-a2s1c1-plan-v1", "fromRound": finished + 1,
                "targetRound": finished + args.rounds, "initialWeightsSha256": initial["weightsSha256"],
                "courseConfigSha256": hashlib.sha256(json.dumps(course_config,
                     sort_keys=True).encode()).hexdigest(), "trainingSeed": SEED}
        if not args.dry_run:
            save_plan(plan)
    elif args.command == "continue":
        if not plan:
            raise RuntimeError("No saved A2S1C1 plan")
    else:
        raise ValueError(args.command)
    if (plan["initialWeightsSha256"] != initial["weightsSha256"] or
            plan["courseConfigSha256"] != hashlib.sha256(json.dumps(course_config,
                sort_keys=True).encode()).hexdigest() or plan["trainingSeed"] != SEED):
        raise ValueError("Saved plan has a different course, source model, or seed")
    show(initial, course_config, updates, plan)
    if args.dry_run:
        for number in range(plan["fromRound"], plan["targetRound"] + 1):
            complete_round(number, initial, entries, course_config, dry_run=True)
        return
    for number in range(plan["fromRound"], plan["targetRound"] + 1):
        complete_round(number, initial, entries, course_config)
    archive = STATE / "plan-history"
    archive.mkdir(parents=True, exist_ok=True)
    os.replace(PLAN, archive / f"round-{plan['fromRound']:03d}-{plan['targetRound']:03d}.json")


def main():
    parser = argparse.ArgumentParser(description="A2S1C1 reachable combo-course round launcher")
    parser.add_argument("command", choices=("show", "new", "continue", "interactive"))
    parser.add_argument("rounds", type=int, nargs="?")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.command == "interactive":
        initial, entries, course_config = identity()
        plan = json.loads(PLAN.read_text(encoding="utf-8")) if PLAN.exists() else None
        show(initial, course_config, progress(initial, course_config), plan)
        if plan:
            selection = input("输入 C 继续现有计划，D 仅预览，其他键退出：").strip().upper()
            if selection not in ("C", "D"):
                return
            args.command = "continue"
            args.dry_run = selection == "D"
        else:
            value = input("输入本次新增轮数（正整数，推荐先1；D 只预览1轮）：").strip()
            args.command = "new"
            args.dry_run = value.upper() == "D"
            args.rounds = 1 if args.dry_run else int(value)
    run(args)


if __name__ == "__main__":
    main()
