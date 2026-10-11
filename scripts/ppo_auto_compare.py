"""One explicit, bounded 40+40 game control/candidate implementation comparison."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from scripts import ppo_auto_experiment as exp
from scripts import ppo_auto_rounds as rounds
from scripts.ppo_network_factory import A2S1_ADAPTER

OUTPUT = exp.ROOT / ".state/A2自动探索试验01/short-comparison.json"


def run_arm(name, pairs, review_seconds):
    initial, evidence, config = rounds.identity(name, pairs, review_seconds)
    state, checkpoint, report, _, _ = rounds.paths(name)
    if checkpoint.exists() or report.exists():
        raise FileExistsError(f"Existing {name} comparison output is protected")
    command = [sys.executable, "scripts/ppo_train.py", "--mode", "A",
        "--experiment-id", name, "--architecture", A2S1_ADAPTER,
        "--entropy-coefficient", "0.01", "--initial-weights", str(state/"initial.pt"),
        "--expected-initial-hash", initial["weightsSha256"],
        "--combo-pool", str(exp.POOL), "--card-set", "signals",
        "--workers", "8", "--updates", "1", "--seed", str(exp.SEED),
        "--checkpoint", str(checkpoint), "--report", str(report),
        "--background-performance"]
    if pairs:
        if exp.sha(rounds.REVIEW_PARENT) != rounds.REVIEW_PARENT_SHA:
            raise ValueError("Frozen review parent changed")
        command.extend(["--auto-exploration-pairs", str(pairs),
            "--auto-exploration-root", str(state/"exploration"),
            "--auto-review-parent", str(rounds.REVIEW_PARENT),
            "--auto-review-seconds", str(review_seconds)])
    started = time.perf_counter()
    subprocess.run(command, cwd=exp.ppo.ROOT, check=True)
    wall = time.perf_counter()-started
    if rounds.progress(name, initial, config) != 1:
        raise RuntimeError("Short comparison did not finish exactly one complete update")
    row = json.loads(report.read_text(encoding="utf-8"))["updates"][0]
    return {"experimentId": name, "initialWeightsSha256": evidence["weightsSha256"],
        "completedEpisodes": row["episodeCount"],
        "completedDecisions": row["completedDecisions"],
        "courseIds": [task.get("courseId") for task in row["tasks"] if task.get("courseId")],
        "taskSeeds": [task["seed"] for task in row["tasks"]],
        "wallSeconds": wall, "collectionSeconds": row["collection"]["collectionSeconds"],
        "optimizationSeconds": row["optimizationSeconds"],
        "exploration": row.get("automaticExploration"),
        "imitation": row.get("automaticImitation"),
        "checkpointSha256": exp.sha(checkpoint),
        "reportPath": str(report), "checkpointPath": str(checkpoint)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--pairs", type=int, default=2)
    parser.add_argument("--review-seconds", type=int, default=120)
    args = parser.parse_args()
    if not args.execute:
        print("Dry-run only: same C4 parent, same seeds, 36 normal + 4 course, "
              "one 40-game update per arm; candidate additionally explores "
              f"{args.pairs} branch pairs with <= {args.review_seconds}s review.")
        return
    if OUTPUT.exists():
        raise FileExistsError("Short comparison audit already exists")
    if args.pairs < 1 or args.pairs > 10 or not 1 <= args.review_seconds <= 1800:
        parser.error("Short comparison needs 1..10 pairs and 1..1800 review seconds")
    baseline = run_arm("A2AUTOBASE", 0, args.review_seconds)
    candidate = run_arm("A2AUTOCAND", args.pairs, args.review_seconds)
    if (baseline["initialWeightsSha256"] != candidate["initialWeightsSha256"] or
        baseline["taskSeeds"] != candidate["taskSeeds"] or
        baseline["courseIds"] != candidate["courseIds"]):
        raise ValueError("Matched short comparison inputs differ")
    report = {"format": "auto-exploration-short-comparison-v1",
        "scope": "one-complete-update-per-arm-no-long-term-strength-claim",
        "sourceC4CheckpointSha256": exp.PARENT_SHA,
        "sourceWeightsSha256": exp.PARENT_WEIGHTS,
        "poolSha256": exp.sha(exp.POOL),
        "samePerformanceConfig": "process-local-execution-speed-opt-out",
        "baseline": baseline, "candidate": candidate,
        "extraWallSeconds": candidate["wallSeconds"]-baseline["wallSeconds"]}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, OUTPUT)
    print(json.dumps({"report": str(OUTPUT), "baselineSeconds": baseline["wallSeconds"],
                      "candidateSeconds": candidate["wallSeconds"],
                      "candidateDemonstrations": (candidate["exploration"] or {}).get(
                          "archiveStats", {}).get("demonstrationDecisions")},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
