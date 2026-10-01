"""Interactive ten-update PPO rounds: A first, then B, with two review files per round."""
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

from scripts import ppo_train as ppo

UPDATES_PER_ROUND = 10
EVALUATION_SEEDS = tuple(range(987650, 987670))
# Keep checkpoints from older rule builds separate from the v1.7.6 experiment.
DEFAULT_RESULTS = ppo.ROOT / "PPO训练"
WEIGHTS_NAME = "模型.pt"
RECORD_NAME = "AI训练记录.jsonl"


def selected_game(training_seed: int, mode: str, round_number: int) -> tuple[int, str]:
    rng = random.Random((training_seed << 8) ^ (round_number << 1) ^
                        (0xA55A if mode == "A" else 0xB66B))
    return rng.choice(EVALUATION_SEEDS), rng.choice(("axis", "allies"))


def checkpoint_update(path: Path, mode: str, training_seed: int) -> int:
    if not path.exists():
        return 0
    saved = torch.load(path, map_location="cpu", weights_only=False)
    if (saved.get("mode") != mode or saved.get("cardSet") != "events" or
        saved.get("trainingSeed") != training_seed or
        saved.get("episodesPerUpdate") != 40 or
        saved.get("completedEpisodes") != 40 * saved.get("update", -1)):
        raise ValueError(f"检查点课程、种子或完整局数不符：{path}")
    return saved["update"]


def validate_record(path: Path, expected_decisions: int, seed: int) -> str:
    counts = {"header": 0, "state": 0, "decision": 0, "result": 0}
    digest = hashlib.sha256()
    first = last = None
    with path.open("rb") as stream:
        for raw in stream:
            if not raw.endswith(b"\n"):
                raise ValueError("训练记录存在未完成的末行")
            digest.update(raw)
            row = json.loads(raw)
            first = row if first is None else first
            last = row
            kind = row.get("recordType", row.get("type"))
            if kind == "AI训练记录":
                counts["header"] += 1
            elif kind == "state":
                counts["state"] += 1
            elif kind == "ppo-decision":
                counts["decision"] += 1
            elif kind == "result":
                counts["result"] += 1
    if (not first or first.get("recordType") != "AI训练记录" or
        first.get("logFormat") != "quartermaster-ppo-training-jsonl-v2" or
        first.get("seed") != seed or
        counts != {"header": 1, "state": expected_decisions + 1,
                   "decision": expected_decisions, "result": 1} or
        not last or last.get("termination") != "natural"):
        raise ValueError(f"训练记录不完整：{counts}，预期决策 {expected_decisions}")
    return digest.hexdigest()


def export_weights(checkpoint: Path, target: Path, mode: str,
                   round_number: int, training_seed: int) -> str:
    saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
    if saved["update"] != round_number * UPDATES_PER_ROUND:
        raise ValueError("检查点不是本轮结束时的模型")
    payload = {"format": "quartermaster-ppo-weights-v1", "mode": mode,
               "round": round_number, "policyVersion": saved["policyVersion"],
               "trainingSeed": training_seed, "completedEpisodes": saved["completedEpisodes"],
               "completedDecisions": saved["completedDecisions"],
               "buildFingerprint": saved["buildFingerprint"],
               "trainerSourceSha256": saved["trainerSourceSha256"],
               "observationSchemaVersion": saved["observationSchemaVersion"],
               "actionSchemaVersion": saved["actionSchemaVersion"],
               "encoderVersion": saved["encoderVersion"],
               "network": saved["network"], "modelState": saved["modelState"]}
    torch.save(payload, target)
    digest = hashlib.sha256()
    with target.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def record_game(checkpoint: Path, target: Path, mode: str, round_number: int,
                training_seed: int, model_sha256: str, max_decisions: int = 3000):
    seed, learner_side = selected_game(training_seed, mode, round_number)
    raw_target = target.with_name(".training-raw.jsonl")
    client = ppo.ArenaClient(log_path=raw_target, log_snapshots=True)
    try:
        encoder = ppo.Encoder(client.schema)
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        model = ppo.PpoNetwork(encoder.state_dim, encoder.candidate_dim).to(device)
        optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
        saved = ppo.restore_checkpoint(checkpoint, model, optimizer, encoder, client,
                                       mode, random.Random(), "events",
                                       training_seed=training_seed)
        if saved["update"] != round_number * UPDATES_PER_ROUND:
            raise ValueError("记录所用模型与目标轮数不符")
        model.eval()
        metadata = {"round": round_number, "policyVersion": saved["policyVersion"],
                    "trainingSeed": training_seed, "evaluationSeed": seed,
                    "evaluationSeedSet": list(EVALUATION_SEEDS),
                    "learnerSide": learner_side,
                    "opponent": "frozen-weighted-legal-baseline-v1",
                    "actionSampling": "stochastic-per-game-seed", "modelSha256": model_sha256,
                    "recordScope": "full-training-scene-replay-v1"}
        result = ppo.play_episode(client, encoder, model, device, mode, seed,
                                  max_decisions, trace="full",
                                  baseline_side="allies" if learner_side == "axis" else "axis",
                                  rng=random.Random(seed + 19), card_set="events",
                                  record_metadata=metadata)
    finally:
        client.close()
    if result["outcome"]["termination"] != "natural":
        raise RuntimeError("抽样评估局未自然结束；不输出本轮结果")
    digest = validate_record(raw_target, result["decisions"], seed)
    summary = {"recordType": "trainingSummary", "round": round_number,
               "seed": seed, "learnerSide": learner_side,
               "decisions": result["decisions"], "countryTurns": result["countryTurns"],
               "winner": result["outcome"]["winner"],
               "allianceScores": result["outcome"]["allianceScores"],
               "sha256OfPriorLines": digest}
    with raw_target.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(summary, ensure_ascii=False, separators=(",", ":")) + "\n")
    subprocess.run(["node", "scripts/ppo-export-training-replay.mjs", str(raw_target),
                    str(target)], cwd=ppo.ROOT, check=True)
    raw_target.unlink()
    return summary


def run_training(mode: str, update_count: int, resume: bool, workers: int,
                 seed: int, checkpoint: Path, report: Path):
    command = [sys.executable, "scripts/ppo_train.py", "--mode", mode,
               "--card-set", "events", "--workers", str(workers),
               "--updates", str(update_count), "--seed", str(seed),
               "--checkpoint", str(checkpoint), "--report", str(report),
               "--eval-seeds", str(len(EVALUATION_SEEDS))]
    if resume:
        command.append("--resume")
    subprocess.run(command, cwd=ppo.ROOT, check=True)


def complete_round(mode: str, number: int, args) -> None:
    course_root = args.result_root / mode
    state_dir = args.result_root / ".state" / mode
    checkpoint = state_dir / "latest.pt"
    report = state_dir / "training-report.json"
    output = course_root / f"第{number:03d}轮"
    finished = checkpoint_update(checkpoint, mode, args.seed)
    target = number * UPDATES_PER_ROUND
    if output.exists():
        if ((output / WEIGHTS_NAME).is_file() and (output / RECORD_NAME).is_file()
                and finished >= target):
            print(f"{mode} 第 {number} 轮已有完整结果，跳过。", flush=True)
            return
        raise RuntimeError(f"结果目录不完整，需人工检查：{output}")
    if finished > target:
        raise RuntimeError(f"检查点已超过第 {number} 轮，但对应结果缺失，不能重造旧权重：{checkpoint}")
    if args.dry_run:
        print(f"{mode} 第 {number} 轮：从更新 {finished} 到 {target}；结果 {output}")
        return
    if finished < target:
        state_dir.mkdir(parents=True, exist_ok=True)
        print(f"{mode} 第 {number} 轮：执行 {target - finished} 次更新，{args.workers} 个环境共享模型。",
              flush=True)
        run_training(mode, target - finished, finished > 0, args.workers,
                     args.seed, checkpoint, report)
    course_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".stage-{mode}-{number:03d}-",
                                     dir=course_root) as temporary:
        stage = Path(temporary)
        model_sha256 = export_weights(checkpoint, stage / WEIGHTS_NAME,
                                      mode, number, args.seed)
        summary = record_game(checkpoint, stage / RECORD_NAME, mode, number,
                              args.seed, model_sha256)
        os.replace(stage, output)
    print(f"{mode} 第 {number} 轮完成：{output}\n"
          f"  {WEIGHTS_NAME}\n  {RECORD_NAME}"
          f"（记录种子 {summary['seed']}，{summary['decisions']} 次决策）", flush=True)


def main():
    parser = argparse.ArgumentParser(description="先 A 后 B，每轮 10 次 PPO 更新")
    parser.add_argument("--rounds", type=int, default=None,
                        help="目标总轮数；省略时启动后交互输入")
    parser.add_argument("--workers", type=int, default=10)
    parser.add_argument("--seed", type=int, default=20260930)
    parser.add_argument("--result-root", type=Path, default=DEFAULT_RESULTS)
    parser.add_argument("--dry-run", action="store_true", help="只显示计划，不训练或写文件")
    args = parser.parse_args()
    if args.rounds is None:
        args.rounds = int(input("请输入目标总轮数（每轮 10 次更新；已有进度会续训）：").strip())
    if args.rounds < 1 or args.workers < 1 or args.seed < 0:
        parser.error("轮数、环境数必须为正，种子不能为负")
    if not args.dry_run and not torch.cuda.is_available():
        raise RuntimeError("未检测到 CUDA GPU；为避免误开长时间 CPU 训练，入口已停止")
    for mode in ("A", "B"):
        for number in range(1, args.rounds + 1):
            complete_round(mode, number, args)
    print("A、B 两种课程均已达到目标轮数。", flush=True)


if __name__ == "__main__":
    main()
