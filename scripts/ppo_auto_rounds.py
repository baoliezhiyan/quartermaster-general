"""Manual, isolated rounds for the C4-derived automatic exploration experiment."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts import ppo_rounds as rounds
from scripts import ppo_auto_experiment as experiment
from scripts.ppo_combo_course_v2 import VERSION as COURSE_VERSION
from scripts.ppo_combo_metrics import C4_VERSION as METRICS_VERSION
from scripts.ppo_combo_c3_metrics import C4_VERSION as DETAIL_VERSION
from scripts.ppo_combo_sampler_v2 import VERSION as SAMPLER_VERSION
from scripts.ppo_network_factory import A2S1_ADAPTER

REVIEW_PARENT = (Path(r"C:\Users\1\.codex\worktrees\training-sync-v182\战场军需官") /
                 "PPO训练/.state/A2S1C3/latest.pt")
REVIEW_PARENT_SHA = "ed32ba1f9e6927be8a4cec739942533ff5d949137b39239429b53c9855b5c0b7"
# No P3 demonstration qualified within the pre-registered three-route budget.
# The fourth-route audit is retained separately and deliberately not enabled.
FROZEN_LIBRARY = None


def review_source(name):
    if name == "A2AUTO2":
        from scripts.ppo_auto_semantic_migrate import REVIEW
        return REVIEW
    return REVIEW_PARENT


def review_hash(name):
    return experiment.sha(review_source(name)) if name == "A2AUTO2" else REVIEW_PARENT_SHA


def paths(name):
    state = experiment.ROOT / ".state" / name
    return state, state / "latest.pt", state / "training-report.json", \
        state / "plan.json", experiment.ROOT / name


def identity(name, pairs=0, review_seconds=120):
    initial, evidence = experiment.validate(name)
    frozen_sha = None
    config = {"version": COURSE_VERSION,
        "mix": {"normal": 36, "handWrittenCourse": 4}}
    client = ppo.ArenaClient(card_set="signals")
    try:
        pool, _, _ = experiment.pool_identity(client, name)
        config["poolIdentitySha256"] = pool["identitySha256"]
    finally:
        client.close()
    config.update({"poolFileSha256": evidence["poolSha256"],
        "metricsVersion": METRICS_VERSION + "-auto-v1",
        "samplerVersion": SAMPLER_VERSION,
        "detailMetricsVersion": DETAIL_VERSION,
        "demonstrationAuditSha256": initial["demonstrationAuditSha256"],
        "automaticExploration": {
            "version": "auto-exploration-experiment-archive-v2" if name == "A2AUTO2" else
                "auto-exploration-per-complete-batch-v1",
            "pairsPerUpdate": pairs, "reviewMaxSeconds": review_seconds,
            "reviewParentSha256": review_hash(name) if pairs else None,
            "frozenLibrarySha256": frozen_sha,
            "imitation": "reviewed-only-max2x64-independent-holdout-persistent-pause-v2"
                if name == "A2AUTO2" else "reviewed-only-max2x64-lr1e-5-sentinel-kl-0.01"}})
    return initial, evidence, config


def progress(name, initial, config):
    _, checkpoint, report_path, _, _ = paths(name)
    if not checkpoint.is_file():
        if report_path.exists():
            raise ValueError("Report exists without a complete checkpoint")
        return 0
    saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
    expected = ppo.experiment_config_sha256(name, "A", .01,
        initial["weightsSha256"], experiment.SEED, initial["buildFingerprint"],
        "signals", A2S1_ADAPTER, None, config)
    if (saved.get("experimentId") != name or saved.get("mode") != "A" or
        saved.get("cardSet") != "signals" or
        saved.get("initialWeightsSha256") != initial["weightsSha256"] or
        saved.get("experimentConfigSha256") != expected or
        saved.get("rewardConfig") != initial["rewardConfig"] or
        saved.get("buildFingerprint") != initial["buildFingerprint"] or
        saved.get("comboCourseConfig") != config or
        saved.get("completedEpisodes") != saved.get("update", -1) * 40):
        raise ValueError("Experiment checkpoint does not match the current frozen plan")
    if report_path.is_file():
        report = json.loads(report_path.read_text(encoding="utf-8"))
        if (report.get("experimentConfigSha256") != expected or
            report.get("experimentId") != name or
            len(report.get("updates", ())) != saved["update"]):
            raise ValueError("Report and checkpoint disagree")
    return saved["update"]


def read_plan(path):
    if not path.exists():
        return None
    plan = json.loads(path.read_text(encoding="utf-8"))
    if plan.get("format") != "auto-exploration-round-plan-v1":
        raise ValueError("Unknown run plan version")
    return plan


def write_plan(path, plan):
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_suffix(".tmp")
    staged.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(staged, path)


def show(name, pairs=0, review_seconds=120):
    initial, evidence, config = identity(name, pairs, review_seconds)
    _, checkpoint, report, plan_path, output = paths(name)
    done = progress(name, initial, config)
    plan = read_plan(plan_path)
    print(f"实验 {name}；父模型 A2S1C4 更新20/800局；文件 {experiment.PARENT_SHA}。")
    print(f"初始权重 {evidence['weightsSha256']}；构建 {evidence['buildFingerprint']}；"
          f"奖励 {initial['rewardConfig']['actionWasteVersion']}。")
    print(f"资源A，熵0.01；每更新40局（正常36＋手写课程4）；8环境；10更新/轮。")
    print(f"课程池 {evidence['poolSha256']}；新Adam；完整更新 {done}，累计 {40*done}局。")
    print(f"模型及报告：{checkpoint}；{report}；轮次成果：{output}。")
    if plan:
        print(f"已有计划目标 {plan['targetUpdates']}更新；还需 "
              f"{max(0,plan['targetUpdates']-done)}更新；探索每更新 "
              f"{plan['explorationPairsPerUpdate']}对。")
    return done, plan


def complete_round(name, number, initial, config, *, pairs=0, review_seconds=120,
                   background_performance=False,
                   dry_run=False):
    state, checkpoint, report_path, _, output = paths(name)
    done = progress(name, initial, config)
    target = number * 10
    destination = output / f"第{number:03d}轮"
    if destination.exists():
        if done >= target and all((destination / file).is_file() for file in
                (rounds.WEIGHTS_NAME, rounds.RECORD_NAME, "概率抽样.jsonl", "轮次摘要.json")):
            return
        raise FileExistsError(f"Partial or conflicting round output is protected: {destination}")
    print(f"{name} 第{number}轮：更新 {done}→{target}，还需 {(target-done)*40}局。")
    if dry_run:
        return
    if done < target:
        command = [sys.executable, "scripts/ppo_train.py", "--mode", "A",
            "--experiment-id", name, "--architecture", A2S1_ADAPTER,
            "--entropy-coefficient", "0.01", "--initial-weights", str(state/"initial.pt"),
            "--expected-initial-hash", initial["weightsSha256"],
            "--combo-pool", str(experiment.pool_path(name)), "--card-set", "signals",
            "--workers", str(experiment.WORKERS), "--updates", str(target-done),
            "--seed", str(experiment.SEED), "--checkpoint", str(checkpoint),
            "--report", str(report_path)]
        if done:
            command.append("--resume")
        if background_performance:
            command.append("--background-performance")
        if pairs:
            reference = review_source(name)
            if not reference.is_file() or experiment.sha(reference) != review_hash(name):
                raise ValueError("Frozen review policy source changed")
            command.extend(["--auto-exploration-pairs", str(pairs),
                "--auto-exploration-root", str(state/"exploration"),
                "--auto-review-parent", str(reference),
                "--auto-review-seconds", str(review_seconds)])
        subprocess.run(command, cwd=ppo.ROOT, check=True)
    if progress(name, initial, config) != target:
        raise RuntimeError("Round checkpoint did not reach the expected update")
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".auto-round-{number:03d}-",dir=output) as folder:
        stage = Path(folder)
        model_hash = rounds.export_weights(checkpoint, stage/rounds.WEIGHTS_NAME,
                                           "A", number, experiment.SEED, name)
        common = {"experiment_id": name, "entropy_coefficient": .01,
                  "initial_weights_sha256": initial["weightsSha256"],
                  "architecture": A2S1_ADAPTER, "card_set": "signals",
                  "course_config": config}
        greedy = rounds.record_game(checkpoint, stage/rounds.RECORD_NAME,
            "A", number, experiment.SEED, model_hash, deterministic=True, **common)
        sampled = rounds.record_game(checkpoint, stage/"概率抽样.jsonl",
            "A", number, experiment.SEED, model_hash, deterministic=False,
            seed_override=experiment.SEED + 100_000 + number, **common)
        report = json.loads(report_path.read_text(encoding="utf-8"))
        summary = {"experimentId": name, "round": number,
            "sourceC4CheckpointSha256": experiment.PARENT_SHA,
            "initialWeightsSha256": initial["weightsSha256"],
            "rewardConfig": initial["rewardConfig"],
            "modelFileSha256": model_hash,
            "updates": [{k: row.get(k) for k in
                ("number", "episodeCount", "completedDecisions", "collection",
                 "optimizationSeconds", "actionWaste", "comboCourseSummary", "courseQuota")}
                for row in report["updates"][(number-1)*10:number*10]],
            "normalGreedy": greedy, "normalSampled": sampled}
        (stage/"轮次摘要.json").write_text(json.dumps(summary, ensure_ascii=False,
            indent=2), encoding="utf-8")
        os.replace(stage, destination)
    print(f"第{number}轮成果：{destination}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("show", "plan", "resume", "add"))
    parser.add_argument("--experiment", choices=experiment.EXPERIMENTS, default="A2AUTO")
    parser.add_argument("--rounds", type=int)
    parser.add_argument("--exploration-pairs-per-update", type=int)
    parser.add_argument("--review-seconds", type=int, default=120)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--background-performance", action="store_true")
    args = parser.parse_args()
    state, _, _, plan_path, _ = paths(args.experiment)
    existing = read_plan(plan_path)
    pairs = (existing["explorationPairsPerUpdate"] if existing else
             args.exploration_pairs_per_update or 0)
    review_seconds = existing.get("reviewMaxSeconds", 120) if existing else args.review_seconds
    initial, _, config = identity(args.experiment, pairs, review_seconds)
    done, existing = show(args.experiment, pairs, review_seconds)
    if args.command == "show":
        return
    if args.command == "plan":
        if args.rounds is None or args.rounds < 1:
            parser.error("A new plan requires a positive round count")
        if args.exploration_pairs_per_update is None or args.exploration_pairs_per_update < 0:
            parser.error("Explicit exploration budget is required; use 0 for a PPO-only control")
        if existing and done < existing["targetUpdates"]:
            raise ValueError("Finish or resume the incomplete plan before adding rounds")
        if existing and args.exploration_pairs_per_update != pairs:
            raise ValueError("Changing exploration budget requires a new experiment identity")
        plan = {"format": "auto-exploration-round-plan-v1",
                "experimentId": args.experiment,
                "startUpdate": done, "targetUpdates": done + args.rounds*10,
                "explorationPairsPerUpdate": args.exploration_pairs_per_update,
                "reviewMaxSeconds": review_seconds,
                "sourceC4CheckpointSha256": experiment.PARENT_SHA,
                "initialWeightsSha256": initial["weightsSha256"],
                "buildFingerprint": initial["buildFingerprint"],
                "rewardConfig": initial["rewardConfig"],
                "poolSha256": experiment.sha(experiment.pool_path(args.experiment))}
        if not args.dry_run:
            write_plan(plan_path, plan)
    elif args.command == "add":
        if args.rounds is None or args.rounds < 1:
            parser.error("Adding a plan requires a positive round count")
        if existing and done < existing["targetUpdates"]:
            raise ValueError("Resume the incomplete plan before appending budget")
        if not existing:
            raise ValueError("No original plan exists; create a new plan first")
        plan = {**existing, "startUpdate": done, "targetUpdates": done+args.rounds*10}
        if not args.dry_run:
            write_plan(plan_path, plan)
    else:
        if not existing:
            raise ValueError("No saved run plan to resume")
        plan = existing
    if any(plan.get(key) != expected for key, expected in (
        ("experimentId", args.experiment), ("initialWeightsSha256", initial["weightsSha256"]),
        ("buildFingerprint", initial["buildFingerprint"]),
        ("rewardConfig", initial["rewardConfig"]),
        ("poolSha256", experiment.sha(experiment.pool_path(args.experiment))))):
        raise ValueError("Saved plan identity differs")
    print(f"Plan: update {done}→{plan['targetUpdates']}；remaining "
          f"{max(0,plan['targetUpdates']-done)*40} complete games；"
          f"exploration {plan['explorationPairsPerUpdate']} pairs/update.")
    for round_no in range(done//10+1, (plan["targetUpdates"]+9)//10+1):
        complete_round(args.experiment, round_no, initial, config,
                       pairs=plan["explorationPairsPerUpdate"],
                       review_seconds=plan["reviewMaxSeconds"],
                       background_performance=args.background_performance,
                       dry_run=args.dry_run)


if __name__ == "__main__":
    main()
