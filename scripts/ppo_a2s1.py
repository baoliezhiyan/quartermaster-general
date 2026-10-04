"""Manual A2S1 round driver. Importing this module never trains."""
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
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network

ROOT = ppo.ROOT / "PPO训练"
STATE = ROOT / ".state" / "A2S1"
INITIAL = STATE / "initial.pt"
CHECKPOINT = STATE / "latest.pt"
REPORT = STATE / "training-report.json"
PLAN = STATE / "plan.json"
OUTPUT = ROOT / "A2S1"
SEED = 20266930
WORKERS = 8
FIXED_EVAL_SEEDS = (20600001, 20600002)
UPDATE1_SHA256 = "6d3833a41b39b2b78f762fd4d694188e728ecf898e608c9793324211309dd3c6"


def initial():
    if not INITIAL.is_file():
        raise FileNotFoundError("先运行 python -m scripts.ppo_a2s1_migrate 创建A2S1起点")
    value = torch.load(INITIAL, map_location="cpu", weights_only=False)
    if (value.get("format") != "quartermaster-ppo-comparison-initial-v1" or
        value.get("experimentId") != "A2S1" or
        value.get("networkArchitecture") != A2S1_ADAPTER or
        value.get("encoderVersion") != ppo.A2S1_ENCODER_VERSION):
        raise ValueError("A2S1起点身份或编码版本不匹配")
    return value


def progress(start):
    if not CHECKPOINT.exists():
        return 0
    saved = torch.load(CHECKPOINT, map_location="cpu", weights_only=False)
    if (saved.get("experimentId") != "A2S1" or saved.get("cardSet") != "signals" or
        saved.get("mode") != "A" or saved.get("networkArchitecture") != A2S1_ADAPTER or
        saved.get("initialWeightsSha256") != start["weightsSha256"] or
        saved.get("trainingSeed") != SEED or saved.get("episodesPerUpdate") != 40 or
        saved.get("completedEpisodes") != 40 * saved.get("update", -1)):
        raise ValueError("A2S1检查点身份、课程或完整局数不一致")
    return saved["update"]


def read_plan():
    return json.loads(PLAN.read_text(encoding="utf-8")) if PLAN.exists() else None


def save_plan(value):
    PLAN.parent.mkdir(parents=True, exist_ok=True)
    temporary = PLAN.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, PLAN)


def completed_rounds():
    result = 0
    while (OUTPUT / f"第{result+1:03d}轮" / rounds.WEIGHTS_NAME).is_file() and \
          (OUTPUT / f"第{result+1:03d}轮" / rounds.RECORD_NAME).is_file():
        result += 1
    return result


def show(start, plan, updates):
    print(f"A2S1：资源A，熵0.01，40完整局/更新，10更新/轮，{WORKERS}环境。")
    print(f"父模型 {start['sourceModelSha256']}，A2S1起点权重 {start['weightsSha256']}。")
    print(f"当前已完成更新 {updates}，成果轮次 {completed_rounds()}。")
    if plan:
        print(f"未完成计划：从第{plan['fromRound']}轮新增{plan['addedRounds']}轮，目标第{plan['targetRound']}轮。")
        print(f"恢复预览：已完成{updates}次更新/{updates*40}局；目标{plan['targetRound']*10}次更新；"
              f"还需{plan['targetRound']*10-updates}次更新/"
              f"{(plan['targetRound']*10-updates)*40}局。未完成的更新将重新采集。")


def evaluate(checkpoint, start, target):
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        model = make_network(A2S1_ADAPTER, encoder)
        reference = make_network(A2S1_ADAPTER, encoder)
        reference.load_state_dict(start["modelState"])
        saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
        model.load_state_dict(saved["modelState"])
        device = torch.device("cpu")
        model.eval();reference.eval()
        games = []
        for seed in FIXED_EVAL_SEEDS:
            for reference_team in ("axis", "allies"):
                result = ppo.play_episode(client, encoder, model, device, "A", seed, 3000,
                    trace="none", rng=random.Random((seed << 2) ^ (0 if reference_team == "axis" else 1)),
                    card_set="signals", reference_model=reference, reference_team=reference_team)
                if result["outcome"]["termination"] != "natural":
                    raise RuntimeError("固定评估局未自然结束")
                games.append({"seed": seed, "referenceTeam": reference_team,
                              "learnerTeam": "allies" if reference_team == "axis" else "axis",
                              "winner": result["outcome"]["winner"],
                              "scores": result["outcome"]["allianceScores"],
                              "round": result["outcome"]["round"],
                              "decisions": result["decisions"],
                              "openingWhitePlan": result["openingWhitePlan"],
                              "passes": result["passes"]})
                del result
        target.write_text(json.dumps({"format": "quartermaster-a2s1-evaluation-v1",
            "reference": "frozen-migrated-a2s1-initial",
            "referenceLimitation": "same-course interface, but no new-card PPO training; not a strong-play benchmark",
            "seeds": FIXED_EVAL_SEEDS, "games": games}, ensure_ascii=False, indent=2),
            encoding="utf-8")
    finally:
        client.close()


def complete_round(number, start, dry_run=False):
    target_update = number * 10
    current = progress(start)
    output = OUTPUT / f"第{number:03d}轮"
    if output.exists():
        if all((output / name).is_file() for name in (rounds.WEIGHTS_NAME,
            rounds.RECORD_NAME, "概率抽样-1.jsonl", "概率抽样-2.jsonl", "固定评估.json")) and current >= target_update:
            print(f"第{number}轮已有完整结果，跳过。")
            return
        raise RuntimeError(f"A2S1轮次结果不完整，拒绝覆盖：{output}")
    if current > target_update:
        raise RuntimeError("检查点已越过缺失的轮次，不能用新权重重造旧成果")
    print(f"A2S1 第{number}轮：更新 {current}→{target_update}，{(target_update-current)*40}局。")
    if dry_run:
        return
    if current < target_update:
        command = [sys.executable, "scripts/ppo_train.py", "--mode", "A",
                   "--experiment-id", "A2S1", "--architecture", A2S1_ADAPTER,
                   "--entropy-coefficient", "0.01", "--initial-weights", str(INITIAL),
                   "--expected-initial-hash", start["weightsSha256"], "--card-set", "signals",
                   "--workers", str(WORKERS), "--updates", str(target_update-current),
                   "--seed", str(SEED), "--checkpoint", str(CHECKPOINT), "--report", str(REPORT)]
        if current:
            command.append("--resume")
        if current == 1:
            if hashlib.sha256(CHECKPOINT.read_bytes()).hexdigest() != UPDATE1_SHA256:
                raise ValueError("更新1恢复点哈希变化，拒绝自动迁移")
            command += ["--approved-resume-parent-sha256", UPDATE1_SHA256]
        subprocess.run(command, cwd=ppo.ROOT, check=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".a2s1-round-{number:03d}-", dir=OUTPUT) as temporary:
        stage = Path(temporary)
        digest = rounds.export_weights(CHECKPOINT, stage / rounds.WEIGHTS_NAME,
                                       "A", number, SEED, experiment_id="A2S1")
        for name, seed, greedy in ((rounds.RECORD_NAME, 20600000, True),
                                   ("概率抽样-1.jsonl", FIXED_EVAL_SEEDS[0], False),
                                   ("概率抽样-2.jsonl", FIXED_EVAL_SEEDS[1], False)):
            rounds.record_game(CHECKPOINT, stage / name, "A", number, SEED, digest,
                experiment_id="A2S1", entropy_coefficient=.01,
                initial_weights_sha256=start["weightsSha256"], architecture=A2S1_ADAPTER,
                card_set="signals", deterministic=greedy, seed_override=seed)
        evaluate(CHECKPOINT, start, stage / "固定评估.json")
        os.replace(stage, output)
    print(f"A2S1 第{number}轮完成：{output}")


def run(args):
    start = initial()
    updates = progress(start)
    plan = read_plan()
    if args.command == "show":
        show(start, plan, updates)
        return
    if args.command == "new":
        if plan:
            raise RuntimeError("尚有未完成计划；请先继续原计划，不可静默叠加预算")
        if args.rounds is None or args.rounds <= 0:
            raise ValueError("新增轮数必须是正整数")
        current = completed_rounds()
        if updates > current * 10:
            raise RuntimeError("已有未完成轮次，请先恢复，不能建立新计划")
        plan = {"format": "quartermaster-a2s1-plan-v1", "fromRound": current + 1,
                "addedRounds": args.rounds, "targetRound": current + args.rounds,
                "initialWeightsSha256": start["weightsSha256"], "trainingSeed": SEED}
        if not args.dry_run:
            save_plan(plan)
    elif args.command in ("continue", "resume-original"):
        if not plan:
            raise RuntimeError("没有未完成的A2S1计划")
        if args.command == "resume-original" and (updates != 1 or plan["targetRound"] != 2 or
                hashlib.sha256(CHECKPOINT.read_bytes()).hexdigest() != UPDATE1_SHA256):
            raise RuntimeError("原两轮计划的更新1恢复点不匹配；不会新增训练预算")
    else:
        raise ValueError("Unknown command")
    if plan["initialWeightsSha256"] != start["weightsSha256"] or plan["trainingSeed"] != SEED:
        raise ValueError("运行计划与A2S1起点不一致")
    show(start, plan, updates)
    if args.dry_run:
        projected_update = updates
        for number in range(plan["fromRound"], plan["targetRound"] + 1):
            target_update = number * 10
            print(f"A2S1 第{number}轮：更新 {projected_update}→{target_update}，"
                  f"{max(0, target_update-projected_update)*40}局（预览，不启动）。")
            projected_update = max(projected_update, target_update)
        return
    for number in range(plan["fromRound"], plan["targetRound"] + 1):
        complete_round(number, start)
    archive = STATE / "plan-history"
    archive.mkdir(parents=True, exist_ok=True)
    os.replace(PLAN, archive / f"round-{plan['fromRound']:03d}-{plan['targetRound']:03d}.json")


def main():
    parser = argparse.ArgumentParser(description="A2S1 course, manual round driver")
    parser.add_argument("command", choices=["show", "new", "continue", "resume-original", "interactive"])
    parser.add_argument("rounds", type=int, nargs="?")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.command == "interactive":
        start = initial()
        plan = read_plan()
        current_update = progress(start)
        show(start, plan, current_update)
        if plan:
            if current_update == 1:
                prompt = "输入 R 从第1次更新恢复原两轮计划（到第20次更新），D 只预览，其他键退出："
                continue_choice = "R"
            else:
                prompt = "输入 C 从最近完整更新继续原计划，D 只预览，其他键退出："
                continue_choice = "C"
            choice = input(prompt).strip().upper()
            if choice not in (continue_choice, "D"):
                return
            args.command = "resume-original" if current_update == 1 else "continue"
            args.dry_run = choice == "D"
        else:
            text = input("本次新增轮数（默认2；输入 D 预览2轮）：").strip()
            args.command = "new";args.dry_run = text.upper() == "D"
            args.rounds = 2 if not text or args.dry_run else int(text)
    run(args)


if __name__ == "__main__":
    main()
