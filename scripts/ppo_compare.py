"""Sequential A1/A2 comparison plans; both experiments use arena resource mode A."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

import torch

from scripts import ppo_rounds as rounds
from scripts import ppo_train as ppo
from scripts import ppo_repeat_build_probe as probe

EXPERIMENTS = {"A1": 0.01, "A2": 0.02}
RESOURCE_MODE = "A"
PLAN_NAME = "comparison-plan.json"
INITIAL_NAME = "comparison-initial.pt"
EVALUATION_SEEDS = (20261021, 20261022)


def fingerprint(seed, workers, initial_hash):
    orchestration_hash = hashlib.sha256(Path(__file__).read_bytes() +
        Path(rounds.__file__).read_bytes()).hexdigest()
    config = {"resourceMode": RESOURCE_MODE, "experiments": EXPERIMENTS,
              "trainerSourceSha256": ppo.TRAINER_SOURCE_HASH,
              "orchestrationSourceSha256": orchestration_hash,
              "rewardConfig": ppo.REWARD_CONFIG, "optimizerOther": {
                  k: v for k, v in ppo.OPTIMIZER_CONFIG.items() if k != "entropy"},
              "encoder": ppo.ENCODER_VERSION, "seed": seed, "workers": workers,
              "initialWeightsSha256": initial_hash, "evaluationSeeds": EVALUATION_SEEDS,
              "episodesPerUpdate": 40, "updatesPerRound": 10}
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()


def atomic_json(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def initial_weights(root, seed, create):
    path = root / ".state" / INITIAL_NAME
    if path.exists():
        saved = torch.load(path, map_location="cpu", weights_only=False)
        if saved.get("format") != "quartermaster-ppo-comparison-initial-v1" or saved.get("seed") != seed:
            raise ValueError(f"对照初始化文件来源不符：{path}")
        model = ppo.PpoNetwork(saved["network"]["stateDim"], saved["network"]["candidateDim"])
        model.load_state_dict(saved["modelState"])
        digest = ppo.model_weights_sha256(model)
        if digest != saved.get("weightsSha256"):
            raise ValueError("对照初始化文件权重哈希不符")
        return path, digest
    if not create:
        return path, None
    client = ppo.ArenaClient()
    try:
        encoder = ppo.Encoder(client.schema)
        torch.manual_seed(seed)
        model = ppo.PpoNetwork(encoder.state_dim, encoder.candidate_dim)
        digest = ppo.model_weights_sha256(model)
        payload = {"format": "quartermaster-ppo-comparison-initial-v1", "seed": seed,
                   "buildFingerprint": client.fingerprint,
                   "network": {"stateDim": encoder.state_dim,
                               "candidateDim": encoder.candidate_dim},
                   "weightsSha256": digest, "modelState": model.state_dict()}
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        torch.save(payload, temporary)
        os.replace(temporary, path)
        return path, digest
    finally:
        client.close()


def progress(root, experiment, seed, initial_hash):
    entropy = EXPERIMENTS[experiment]
    directory = root / ".state" / experiment
    checkpoint = directory / "latest.pt"
    if not checkpoint.exists():
        if (directory / "training-report.json").exists():
            raise ValueError(f"{experiment} 有报告却没有检查点")
        if (root / experiment).exists() and list((root / experiment).glob("第*轮")):
            raise ValueError(f"{experiment} 有轮次成果却没有检查点")
        return 0, 0
    saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
    expected = {"experimentId": experiment, "mode": RESOURCE_MODE, "cardSet": "events",
                "trainingSeed": seed, "initialWeightsSha256": initial_hash,
                "rewardConfig": ppo.REWARD_CONFIG, "encoderVersion": ppo.ENCODER_VERSION,
                "episodesPerUpdate": 40}
    expected["experimentConfigSha256"] = ppo.experiment_config_sha256(experiment,
        RESOURCE_MODE, entropy, initial_hash, seed, saved.get("buildFingerprint"))
    if any(saved.get(key) != value for key, value in expected.items()) or \
            saved.get("optimizerConfig") != {**ppo.OPTIMIZER_CONFIG, "entropy": entropy}:
        raise ValueError(f"{experiment} 检查点实验配置不符：{checkpoint}")
    update = saved.get("update")
    if not isinstance(update, int) or update < 0 or saved.get("completedEpisodes") != 40 * update or \
            saved.get("policyVersion") != update or saved.get("nextSeed") != seed + 40 * update:
        raise ValueError(f"{experiment} 检查点更新/完整对局计数不符")
    report_path = directory / "training-report.json"
    if not report_path.is_file():
        raise ValueError(f"{experiment} 有检查点却没有训练报告")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if (report.get("experimentId") != experiment or report.get("mode") != RESOURCE_MODE or
        report.get("entropyCoefficient") != entropy or
        report.get("initialWeightsSha256") != initial_hash or
        report.get("experimentConfigSha256") != expected["experimentConfigSha256"] or
        len(report.get("updates", [])) != update or
        (update and report["updates"][-1]["number"] != update)):
        raise ValueError(f"{experiment} 报告与检查点不一致")
    complete = 0
    for output in sorted((root / experiment).glob("第*轮")) if (root / experiment).exists() else []:
        expected_name = f"第{complete + 1:03d}轮"
        if output.name != expected_name or not (output / rounds.WEIGHTS_NAME).is_file() or \
                not (output / rounds.RECORD_NAME).is_file() or update < (complete + 1) * 10:
            raise ValueError(f"{experiment} 轮次成果与检查点不一致：{output}")
        complete += 1
    if update > (complete + 1) * 10:
        raise ValueError(f"{experiment} 检查点超过未发布轮次；请人工检查")
    return complete, update


def fixed_preferences(model):
    client = ppo.ArenaClient()
    try:
        encoder = ppo.Encoder(client.schema)
        soviet = probe.scene(client, "soviet_union", [{"id": "probe:ukraine",
            "country": "soviet_union", "type": "army", "regionId": "ukraine"}])
        soviet_result = probe.preference(model, encoder, soviet,
            lambda c: c.get("definitionId") == "build_army" and
            (c.get("choices") or [{}])[0].get("regionId") == "ukraine")
        client.request(op="reset", seed=871, mode="A", cardSet="events")
        snapshot = client.request(op="snapshot")["snapshot"]
        state = snapshot["state"]
        state.update(activeSeat="japan", operatorSeat="japan", viewSeat="japan",
                     phase="PLAY", status="PLAYING", resolution=None)
        state["units"] = [u for u in state["units"] if u["regionId"] != "eastern_china"]
        state["units"].extend([
            {"id": "probe:japan:east", "country": "japan", "type": "army", "regionId": "eastern_china"},
            {"id": "probe:japan:near", "country": "japan", "type": "army", "regionId": "western_china"}])
        state["turnFlags"] = {"protected": [], "battleProtected": [],
                              "supplied": ["probe:japan:east", "probe:japan:near"],
                              "supplyCountries": [], "supplyRegions": [], "suppressed": [],
                              "noAirDefense": False}
        japanese = client.request(op="restore", snapshot=snapshot)["observation"]
        japan_result = probe.preference(model, encoder, japanese,
            lambda c: c.get("definitionId") == "build_army" and
            (c.get("choices") or [{}])[0].get("regionId") == "eastern_china")
        return {"sceneSeed": 871, "sovietUkraineRepeated": soviet_result,
                "japanEasternChinaRepeated": japan_result}
    finally:
        client.close()


def review_round(checkpoint, initial_path, experiment, seed, number, initial_hash):
    entropy = EXPERIMENTS[experiment]
    client = ppo.ArenaClient()
    try:
        encoder = ppo.Encoder(client.schema)
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        learner = ppo.PpoNetwork(encoder.state_dim, encoder.candidate_dim).to(device)
        optimizer = torch.optim.Adam(learner.parameters(), lr=3e-4)
        ppo.restore_checkpoint(checkpoint, learner, optimizer, encoder, client, RESOURCE_MODE,
            random.Random(), "events", training_seed=seed, experiment_id=experiment,
            entropy_coefficient=entropy, initial_weights_sha256=initial_hash)
        initial = torch.load(initial_path, map_location="cpu", weights_only=False)
        if initial.get("buildFingerprint") != client.fingerprint:
            raise ValueError("固定参考权重的竞技场构建指纹不符")
        reference = ppo.PpoNetwork(encoder.state_dim, encoder.candidate_dim).to(device)
        reference.load_state_dict(initial["modelState"])
        if ppo.model_weights_sha256(reference) != initial_hash:
            raise ValueError("固定参考权重哈希不符")
        learner.eval(); reference.eval()
        preferences = fixed_preferences(learner)
        games = []
        for game_seed in EVALUATION_SEEDS:
            for learner_team in ("axis", "allies"):
                opponent_team = "allies" if learner_team == "axis" else "axis"
                episode = ppo.play_episode(client, encoder, learner, device, RESOURCE_MODE,
                    game_seed, 3000, rng=random.Random(game_seed + 19), card_set="events",
                    deterministic=True, reference_model=reference, reference_team=opponent_team)
                end = episode["outcome"]
                if end["termination"] != "natural":
                    raise RuntimeError("固定参考评估局未自然结束")
                games.append({"seed": game_seed, "learnerTeam": learner_team,
                              "referenceTeam": opponent_team, "winner": end["winner"],
                              "round": end["round"], "decisions": end["decisions"],
                              "allianceScores": end["allianceScores"]})
        return {"round": number, "experimentId": experiment,
                "reference": "fresh-untrained-frozen-initial-policy; diagnostic-only",
                "referenceWeightsSha256": initial_hash,
                "evaluationSeeds": EVALUATION_SEEDS, "games": games,
                "fixedScenePreferences": preferences}
    finally:
        client.close()


def complete_round(root, experiment, number, seed, workers, initial_path, initial_hash, dry_run):
    completed, update = progress(root, experiment, seed, initial_hash)
    if completed >= number:
        print(f"{experiment} 第 {number} 轮已有成果，跳过。", flush=True)
        return
    target = number * 10
    if update > target:
        raise ValueError(f"{experiment} 检查点已越过轮次 {number}")
    entropy = EXPERIMENTS[experiment]
    checkpoint = root / ".state" / experiment / "latest.pt"
    report = checkpoint.with_name("training-report.json")
    output = root / experiment / f"第{number:03d}轮"
    print(f"{experiment}（资源A，熵{entropy:.2f}）：第 {number} 轮，更新 {update}→{target}；"
          f"训练局 {(target-update)*40}；结果 {output}", flush=True)
    if dry_run:
        return
    if update < target:
        command = [sys.executable, "scripts/ppo_train.py", "--mode", RESOURCE_MODE,
                   "--experiment-id", experiment, "--entropy-coefficient", str(entropy),
                   "--initial-weights", str(initial_path), "--expected-initial-hash", initial_hash,
                   "--card-set", "events", "--workers", str(workers), "--updates", str(target-update),
                   "--seed", str(seed), "--checkpoint", str(checkpoint), "--report", str(report)]
        if update:
            command.append("--resume")
        subprocess.run(command, cwd=ppo.ROOT, check=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".stage-{experiment}-{number:03d}-", dir=output.parent) as temporary:
        stage = Path(temporary)
        digest = rounds.export_weights(checkpoint, stage / rounds.WEIGHTS_NAME,
                                       RESOURCE_MODE, number, seed, experiment_id=experiment)
        rounds.record_game(checkpoint, stage / rounds.RECORD_NAME, RESOURCE_MODE,
            number, seed, digest, experiment_id=experiment,
            entropy_coefficient=entropy, initial_weights_sha256=initial_hash)
        current = json.loads(report.read_text(encoding="utf-8"))
        reviews = current.setdefault("roundReviews", [])
        prior_review = next((item for item in reviews if item["round"] == number), None)
        if prior_review:
            if prior_review.get("experimentId") != experiment or \
                    prior_review.get("referenceWeightsSha256") != initial_hash:
                raise ValueError("已有轮次评估与本实验不符")
        else:
            reviews.append(review_round(checkpoint, initial_path, experiment, seed,
                                        number, initial_hash))
        atomic_json(report, current)
        os.replace(stage, output)
    print(f"{experiment} 第 {number} 轮完成。", flush=True)


def run_plan(root, plan, initial_path, dry_run):
    for experiment in EXPERIMENTS:
        target = plan["targets"][experiment]
        completed = (progress(root, experiment, plan["seed"], plan["initialWeightsSha256"])[0]
                     if plan["initialWeightsSha256"] else 0)
        if completed < plan["bases"][experiment] or completed > target:
            raise ValueError(f"{experiment} 进度超出当前计划")
        for number in range(completed + 1, target + 1):
            complete_round(root, experiment, number, plan["seed"], plan["workers"],
                           initial_path, plan["initialWeightsSha256"], dry_run)


def main():
    parser = argparse.ArgumentParser(description="A1/A2 对照：每组新增 N 轮，顺序训练")
    parser.add_argument("--rounds", type=int, default=None, help="每组新增 N 轮，正整数")
    parser.add_argument("--continue-plan", action="store_true", help="继续未完成运行计划")
    parser.add_argument("--dry-run", action="store_true", help="只展示计划，不运行或写文件")
    parser.add_argument("--workers", type=int, default=None)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--result-root", type=Path, default=rounds.DEFAULT_RESULTS)
    args = parser.parse_args()
    if (args.rounds is not None and args.rounds < 1 or
        args.workers is not None and args.workers < 1 or
        args.seed is not None and args.seed < 0):
        parser.error("轮数和环境数必须为正整数，种子不能为负")
    if args.rounds is not None and args.continue_plan:
        parser.error("新增轮数与继续旧计划不能同时指定")
    root = args.result_root.resolve()
    plan_path = root / ".state" / PLAN_NAME
    old = json.loads(plan_path.read_text(encoding="utf-8")) if plan_path.exists() else None
    pending = old is not None and old["status"] == "pending"
    if pending:
        if args.rounds is not None:
            parser.error("存在未完成计划；请用 --continue-plan，不能覆盖或增加预算")
        if not args.continue_plan and not args.dry_run:
            answer = input("存在未完成 A1/A2 计划。输入 C 继续；取消请直接关闭：").strip().upper()
            if answer != "C":
                raise SystemExit("未改变原计划")
        plan = old
        if args.seed is not None and plan["seed"] != args.seed or \
                args.workers is not None and plan["workers"] != args.workers:
            raise ValueError("继续计划的种子或环境数量不同")
        initial_path, initial_hash = initial_weights(root, plan["seed"], create=False)
        if initial_hash != plan["initialWeightsSha256"] or \
                fingerprint(plan["seed"], plan["workers"], initial_hash) != plan["configFingerprint"]:
            raise ValueError("未完成计划的初始化或配置已变化")
    else:
        if args.continue_plan:
            parser.error("没有可继续的未完成计划")
        if args.rounds is None:
            raw = input("本次每组新增轮数 N（正整数；A1 N 轮后 A2 N 轮）：").strip()
            if not raw.isdecimal() or int(raw) < 1:
                parser.error("N 必须为正整数")
            args.rounds = int(raw)
        args.seed = 20260930 if args.seed is None else args.seed
        args.workers = 8 if args.workers is None else args.workers
        if not args.dry_run and not torch.cuda.is_available():
            raise RuntimeError("未检测到 CUDA GPU；不启动长期 CPU 训练")
        initial_path, initial_hash = initial_weights(root, args.seed, create=not args.dry_run)
        if initial_hash is None:
            if any((root / ".state" / experiment / "latest.pt").exists() or
                   (root / experiment).exists() and list((root / experiment).glob("第*轮"))
                   for experiment in EXPERIMENTS):
                raise ValueError("已有对照检查点但初始化文件丢失")
            # Dry-run from a fresh output tree must not write or launch an arena.
            bases = {experiment: 0 for experiment in EXPERIMENTS}
        else:
            bases = {experiment: progress(root, experiment, args.seed, initial_hash)[0]
                     for experiment in EXPERIMENTS}
        if bases["A1"] != bases["A2"]:
            raise ValueError("两组已完成轮数不同；应继续先前计划，不能新建不公平预算")
        plan = {"format": "quartermaster-ppo-comparison-plan-v1", "status": "pending",
                "seed": args.seed, "workers": args.workers, "addedRounds": args.rounds,
                "bases": bases, "targets": {k: v + args.rounds for k, v in bases.items()},
                "initialWeightsSha256": initial_hash,
                "configFingerprint": fingerprint(args.seed, args.workers, initial_hash)}
        if not args.dry_run:
            atomic_json(plan_path, plan)
    n = plan["addedRounds"]
    print(f"计划：A1（资源A/熵0.01/惩罚-0.01）新增 {n} 轮，随后 "
          f"A2（资源A/熵0.02/惩罚-0.01）新增 {n} 轮；合计新增 {2*n} 轮，不运行 B。")
    print(f"每组 {n*10} 次更新、{n*400} 局；{plan['workers']} 环境共享模型；"
          f"初始权重 SHA256: {plan['initialWeightsSha256'] or 'dry-run未生成'}。")
    if not args.dry_run and not torch.cuda.is_available():
        raise RuntimeError("未检测到 CUDA GPU；不启动长期 CPU 训练")
    run_plan(root, plan, initial_path, args.dry_run)
    if not args.dry_run:
        plan["status"] = "completed"
        atomic_json(plan_path, plan)
        print("A1、A2 本次计划均已完成。", flush=True)


if __name__ == "__main__":
    main()
