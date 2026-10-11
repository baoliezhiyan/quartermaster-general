"""Manual A2S1C4 rounds. Importing or showing never starts PPO."""
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

from scripts import ppo_train as ppo
from scripts import ppo_rounds as rounds
from scripts import ppo_combo_course_v2 as course
from scripts.ppo_combo_replay import record_course
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network

ROOT = ppo.ROOT / "PPO训练"
STATE = ROOT / ".state" / "A2S1C4"
OUTPUT = ROOT / "A2S1C4"
INITIAL = STATE / "initial.pt"
POOL = ROOT / ".state" / "A2S1C3" / "course-pool-merged-trigger-v1.json.gz"
PARENT = ROOT / ".state" / "A2S1C3" / "latest.pt"
PARENT_REPORT = ROOT / ".state" / "A2S1C3" / "training-report.json"
PARENT_SHA = "ed32ba1f9e6927be8a4cec739942533ff5d949137b39239429b53c9855b5c0b7"
POOL_SHA = "13ae0b722bf03bd2e0fedd613a51fc4e8ff2578e303d98b6dff32f97275f5cd6"
CHECKPOINT = STATE / "latest.pt"
REPORT = STATE / "training-report.json"
PLAN = STATE / "plan.json"
SEED = 20261011
WORKERS = 8


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _checked_parent():
    if sha(PARENT) != PARENT_SHA or sha(POOL) != POOL_SHA:
        raise ValueError("C3 update-20 checkpoint or reviewed pool changed")
    parent = torch.load(PARENT, map_location="cpu", weights_only=False)
    report = json.loads(PARENT_REPORT.read_text(encoding="utf-8"))
    if (parent.get("experimentId") != "A2S1C3" or parent.get("update") != 20 or
        parent.get("completedEpisodes") != 800 or parent.get("mode") != "A" or
        parent.get("cardSet") != "signals" or
        parent.get("networkArchitecture") != A2S1_ADAPTER or
        parent.get("rewardConfig") != ppo.reward_config("signals") or
        report.get("experimentId") != "A2S1C3" or len(report.get("updates", [])) != 20 or
        report["updates"][-1]["number"] != 20 or
        report.get("experimentConfigSha256") != parent.get("experimentConfigSha256")):
        raise ValueError("C3 parent checkpoint/report identity or completion differs")
    return parent


def create_initializer():
    if INITIAL.exists() or CHECKPOINT.exists() or REPORT.exists():
        raise FileExistsError("C4 initial or progress exists; refusing overwrite")
    parent = _checked_parent()
    c3_initial = torch.load(ROOT / ".state" / "A2S1C3" / "initial.pt",
                            map_location="cpu", weights_only=False)
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        model = make_network(A2S1_ADAPTER, encoder)
        model.load_state_dict(parent["modelState"], strict=True)
        weight_hash = ppo.model_weights_sha256(model)
        if (client.fingerprint != parent["buildFingerprint"] or
            parent["network"] != {"stateDim": encoder.state_dim,
                                  "candidateDim": encoder.candidate_dim} or
            parent["encoderVersion"] != ppo.encoder_version("signals") or
            c3_initial.get("buildFingerprint") != client.fingerprint or
            c3_initial.get("coursePoolSha256") != POOL_SHA):
            raise ValueError("C4 parent build, encoder or source pool differs")
        expected = course.pool_identity(client, c3_initial["sourceCheckpointSha256"],
                                         c3_initial["generatorWeightsSha256"])
        course.read_pool(POOL, expected)
        payload = {"format": "quartermaster-ppo-comparison-initial-v1",
            "experimentId": "A2S1C4", "sourceExperimentId": "A2S1C3",
            "sourceUpdate": 20, "sourceCompletedEpisodes": 800,
            "sourceC3CheckpointSha256": PARENT_SHA,
            "sourceCheckpointSha256": c3_initial["sourceCheckpointSha256"],
            "generatorWeightsSha256": c3_initial["generatorWeightsSha256"],
            "demonstrationAuditSha256": c3_initial["demonstrationAuditSha256"],
            "lineage": c3_initial["lineage"] + ["A2S1C3:update20:800-episodes",
                                                 "A2S1C4:update0"],
            "networkArchitecture": A2S1_ADAPTER, "network": parent["network"],
            "encoderVersion": parent["encoderVersion"],
            "buildFingerprint": parent["buildFingerprint"],
            "rewardConfig": parent["rewardConfig"], "resourceMode": "A",
            "coursePoolSha256": POOL_SHA,
            "optimizerMigration": "new-Adam-no-old-momentum",
            "weightsSha256": weight_hash,
            "modelState": {key: value.detach().cpu().clone()
                           for key, value in parent["modelState"].items()}}
        STATE.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(prefix=".initial-", suffix=".pt", dir=STATE,
                                         delete=False) as stream:
            temporary = Path(stream.name)
        try:
            torch.save(payload, temporary)
            check = torch.load(temporary, map_location="cpu", weights_only=False)
            verify = make_network(A2S1_ADAPTER, encoder)
            verify.load_state_dict(check["modelState"], strict=True)
            if ppo.model_weights_sha256(verify) != weight_hash:
                raise ValueError("C4 initial reload changed model weights")
            os.replace(temporary, INITIAL)
        finally:
            temporary.unlink(missing_ok=True)
        return sha(INITIAL)
    finally:
        client.close()


def identity():
    if not INITIAL.exists():
        raise SystemExit("缺少 C4 initial.pt；先执行显式初始化。")
    initial = torch.load(INITIAL, map_location="cpu", weights_only=False)
    parent = _checked_parent()
    if (initial.get("format") != "quartermaster-ppo-comparison-initial-v1" or
        initial.get("experimentId") != "A2S1C4" or
        initial.get("sourceExperimentId") != "A2S1C3" or
        initial.get("sourceUpdate") != 20 or
        initial.get("sourceCompletedEpisodes") != 800 or
        initial.get("sourceC3CheckpointSha256") != PARENT_SHA or
        initial.get("coursePoolSha256") != POOL_SHA or
        initial.get("resourceMode") != "A" or
        initial.get("networkArchitecture") != A2S1_ADAPTER or
        initial.get("encoderVersion") != parent["encoderVersion"] or
        initial.get("rewardConfig") != parent["rewardConfig"] or
        initial.get("optimizerMigration") != "new-Adam-no-old-momentum"):
        raise ValueError("C4 initializer lineage/configuration differs")
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        model = make_network(A2S1_ADAPTER, encoder)
        model.load_state_dict(initial["modelState"], strict=True)
        if (client.fingerprint != initial["buildFingerprint"] or
            initial["network"] != {"stateDim": encoder.state_dim,
                                   "candidateDim": encoder.candidate_dim} or
            ppo.model_weights_sha256(model) != initial["weightsSha256"]):
            raise ValueError("C4 initial model, build or encoding differs")
        expected = course.pool_identity(client, initial["sourceCheckpointSha256"],
                                         initial["generatorWeightsSha256"])
        entries = course.read_pool(POOL, expected)["entries"]
        from scripts.ppo_combo_metrics import C4_VERSION as metrics_version
        from scripts.ppo_combo_c3_metrics import C4_VERSION as detail_version
        from scripts.ppo_combo_sampler_v2 import VERSION as sampler_version
        configuration = {"version": course.VERSION,
            "mix": {"normal": 20, "positivePreparation": 9,
                    "controlPreparation": 3, "positivePayoff": 6, "controlPayoff": 2},
            "poolIdentitySha256": expected["identitySha256"],
            "poolFileSha256": sha(POOL),
            "metricsVersion": metrics_version + "-c4",
            "samplerVersion": sampler_version,
            "detailMetricsVersion": detail_version,
            "demonstrationAuditSha256": initial["demonstrationAuditSha256"]}
        return initial, entries, configuration
    finally:
        client.close()


def progress(initial, config):
    if not CHECKPOINT.exists():
        if REPORT.exists():
            raise ValueError("Training report exists without a complete A2S1C4 checkpoint")
        return 0
    saved = torch.load(CHECKPOINT, map_location="cpu", weights_only=False)
    if (saved.get("format") != "quartermaster-ppo-checkpoint-v1" or
        saved.get("experimentId") != "A2S1C4" or saved.get("mode") != "A" or
        saved.get("cardSet") != "signals" or
        saved.get("networkArchitecture") != A2S1_ADAPTER or
        saved.get("initialWeightsSha256") != initial["weightsSha256"] or
        saved.get("buildFingerprint") != initial["buildFingerprint"] or
        saved.get("encoderVersion") != initial["encoderVersion"] or
        saved.get("rewardConfig") != initial["rewardConfig"] or
        saved.get("optimizerConfig", {}).get("entropy") != 0.01 or
        saved.get("experimentConfigSha256") != ppo.experiment_config_sha256(
            "A2S1C4", "A", .01, initial["weightsSha256"], SEED,
            initial["buildFingerprint"], "signals", A2S1_ADAPTER, None, config) or
        saved.get("comboCourseConfig") != config or
        saved.get("trainingSeed") != SEED or
        saved.get("completedEpisodes") != 40 * saved.get("update", -1) or
        not isinstance(saved.get("optimizerState"), dict) or
        not isinstance(saved.get("modelState"), dict)):
        raise ValueError("A2S1C4 checkpoint does not match its plan or complete batches")
    if REPORT.exists():
        report = json.loads(REPORT.read_text(encoding="utf-8"))
        if (report.get("experimentId") != "A2S1C4" or
            report.get("experimentConfigSha256") != saved["experimentConfigSha256"] or
            len(report.get("updates", [])) != saved["update"] or
            report["updates"][-1]["number"] != saved["update"]):
            raise ValueError("A2S1C4 report and complete checkpoint disagree")
    return saved["update"]


def output_rounds():
    count = 0
    while all((OUTPUT / f"第{count + 1:03d}轮" / name).is_file() for name in
              (rounds.WEIGHTS_NAME, rounds.RECORD_NAME, "正常开局-概率抽样.jsonl",
               "课程保留评估.json", "固定评估.json", "轮次统计摘要.json")):
        count += 1
    return count


def show(initial, config, done, plan):
    print("A2S1C4：资源A；熵0.01；8环境；每次40局=正常20＋正准备9＋反准备3＋正兑现6＋反兑现2；每轮10更新。")
    print(f"父模型 C3 更新20 文件：{PARENT_SHA}；权重：{initial['weightsSha256']}。")
    print("C1更新30 → C2 → 三课程示范候选 → C3更新20 → C4更新0；新Adam，无BC辅助。")
    print(f"规则/构建 {initial['buildFingerprint']}；九模板课程 {config['version']}；池 {config['poolFileSha256']}；采样 {config['samplerVersion']}。")
    print(f"完成更新 {done}（{done * 40}局）；完整输出 {output_rounds()}轮；"
          f"目录 {OUTPUT}；检查点 {CHECKPOINT}。")
    if plan:
        print(f"现有计划目标 {plan['targetRound']}轮/{plan['targetRound'] * 10}更新；"
              f"还需 {max(0, plan['targetRound'] * 10 - done)}更新。")


def ensure_baseline(initial, entries):
    target = OUTPUT / "第000轮" / "固定评估.json"
    if target.exists():
        saved = json.loads(target.read_text(encoding="utf-8"))
        if (saved.get("experimentId") != "A2S1C4" or
            saved.get("weightsSha256") != initial["weightsSha256"]):
            raise ValueError("Existing round-zero evaluation belongs to a different model")
        return
    if target.parent.exists():
        raise FileExistsError("Incomplete round-zero evaluation exists; inspect before retry")
    from scripts.ppo_combo_c3_eval import fixed_evaluation
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        model = make_network(A2S1_ADAPTER, encoder)
        model.load_state_dict(initial["modelState"], strict=True)
        evaluated = fixed_evaluation(model, encoder, entries)
    finally:
        client.close()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".c4-baseline-", dir=OUTPUT) as folder:
        stage = Path(folder)
        (stage / "固定评估.json").write_text(json.dumps({"experimentId": "A2S1C4",
            "round": 0, "weightsSha256": initial["weightsSha256"],
            "evaluation": evaluated}, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(stage, target.parent)
    print(f"A2S1C4 第0轮固定评估已保存：{target}")


def save_plan(plan):
    PLAN.parent.mkdir(parents=True, exist_ok=True)
    temporary = PLAN.with_suffix(".tmp")
    temporary.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, PLAN)


def complete_round(number, initial, entries, config, dry_run=False):
    current, target = progress(initial, config), number * 10
    destination = OUTPUT / f"第{number:03d}轮"
    if destination.exists():
        if number <= output_rounds() and current >= target:
            print(f"A2S1C4 第{number}轮完整，跳过。")
            return
        raise RuntimeError(f"Existing incomplete output is protected: {destination}")
    if current > target:
        raise RuntimeError("Checkpoint passed a missing round; cannot reconstruct historical model")
    displayed = max(current, (number - 1) * 10) if dry_run else current
    print(f"A2S1C4 第{number}轮：更新 {displayed}→{target}；"
          f"还需 {(target-displayed)*40}局。")
    if dry_run:
        return
    if current < target:
        command = [sys.executable, "scripts/ppo_train.py", "--mode", "A",
            "--experiment-id", "A2S1C4", "--architecture", A2S1_ADAPTER,
            "--entropy-coefficient", "0.01", "--initial-weights", str(INITIAL),
            "--expected-initial-hash", initial["weightsSha256"],
            "--combo-pool", str(POOL), "--card-set", "signals", "--workers", str(WORKERS),
            "--updates", str(target-current), "--seed", str(SEED),
            "--checkpoint", str(CHECKPOINT), "--report", str(REPORT)]
        if current:
            command.append("--resume")
        subprocess.run(command, cwd=ppo.ROOT, check=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".c4-round-{number:03d}-", dir=OUTPUT) as folder:
        stage = Path(folder)
        digest = rounds.export_weights(CHECKPOINT, stage / rounds.WEIGHTS_NAME,
                                       "A", number, SEED, experiment_id="A2S1C4")
        normal = []
        for name, seed, deterministic in (
                (rounds.RECORD_NAME, 20630001, True),
                ("正常开局-概率抽样.jsonl", 20630002, False)):
            normal.append({"name": name, "seed": seed, "result": rounds.record_game(
                CHECKPOINT, stage / name, "A", number, SEED, digest,
                experiment_id="A2S1C4", entropy_coefficient=.01,
                initial_weights_sha256=initial["weightsSha256"],
                architecture=A2S1_ADAPTER, card_set="signals",
                deterministic=deterministic, seed_override=seed, course_config=config)})
        client = ppo.ArenaClient(card_set="signals")
        try:
            encoder = ppo.Encoder(client.schema)
            model = make_network(A2S1_ADAPTER, encoder)
            optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
            ppo.restore_checkpoint(CHECKPOINT, model, optimizer, encoder, client, "A",
                __import__("random").Random(), "signals", training_seed=SEED,
                experiment_id="A2S1C4", entropy_coefficient=.01,
                initial_weights_sha256=initial["weightsSha256"],
                architecture=A2S1_ADAPTER, course_config=config)
            from scripts.ppo_combo_c3_eval import fixed_evaluation
            evaluated = fixed_evaluation(model, encoder, entries, include_normal=False)
            evaluated["normalGames"] = normal
            (stage / "固定评估.json").write_text(json.dumps({"experimentId": "A2S1C4",
                "round": number, "weightsSha256": ppo.model_weights_sha256(model),
                "evaluation": evaluated}, ensure_ascii=False, indent=2), encoding="utf-8")
            template = ("G1", "U4", "J1")[(number - 1) % 3]
            entry = next(e for e in entries if e["split"] == "evaluation" and
                         e["template"] == template and e["variant"] == "positive" and
                         e["layer"] == "preparation")
            course_reports = [record_course(model, encoder, entry,
                stage / f"课程保留-{template}.jsonl",
                {"experimentId": "A2S1C4", "round": number,
                 "policyVersion": target, "modelSha256": digest,
                 "courseConfig": config, "holdout": True}, deterministic=True)]
            (stage / "课程保留评估.json").write_text(json.dumps(course_reports,
                ensure_ascii=False, indent=2), encoding="utf-8")
            report = json.loads(REPORT.read_text(encoding="utf-8"))
            updates = report["updates"][target - 10:target]
            if len(updates) != 10 or [item["number"] for item in updates] != list(
                    range(target - 9, target + 1)):
                raise ValueError("Round report lacks ten consecutive completed updates")
            from scripts.ppo_combo_c3_metrics import merge_update_summaries
            combo_totals = merge_update_summaries(
                [item["comboDetailSummary"] for item in updates])
            (stage / "轮次统计摘要.json").write_text(json.dumps({
                "实验": "A2S1C4", "轮次": number, "更新范围": [target - 9, target],
                "训练对局数": sum(item["episodeCount"] for item in updates),
                "训练决策数": sum(item["completedDecisions"] for item in updates),
                "每次更新课程配额": [item["courseQuota"] for item in updates],
                "每次更新分层课程统计": [item["courseStrataSummary"] for item in updates],
                "连携统计汇总": combo_totals,
                "每次更新连携统计": [item["comboDetailSummary"] for item in updates],
                "每次更新九模板既有统计": [item["comboCourseSummary"] for item in updates],
                "说明": "正常开局、准备层及兑现层分列；固定评估不计入训练样本。"},
                ensure_ascii=False, indent=2), encoding="utf-8")
        finally:
            client.close()
        os.replace(stage, destination)
    print(f"A2S1C4 第{number}轮完成：{destination}")


def run(args):
    if args.command == "init":
        print(f"A2S1C4 initial.pt created: {create_initializer()}")
        return
    initial, entries, config = identity()
    done = progress(initial, config)
    plan = json.loads(PLAN.read_text(encoding="utf-8")) if PLAN.exists() else None
    if args.command == "show":
        show(initial, config, done, plan)
        return
    if args.command in ("new", "add"):
        if plan:
            raise RuntimeError("现有计划尚未结束；先恢复原计划，不能静默追加轮数")
        if args.rounds is None or args.rounds <= 0:
            raise ValueError("Added rounds must be a positive integer")
        finished = output_rounds()
        if args.command == "new" and (done or finished):
            raise RuntimeError("新实验只能从候选更新0创建；已有进度请使用追加轮数")
        if args.command == "add" and not finished:
            raise RuntimeError("尚无完整轮次；请先创建新实验或恢复中断计划")
        if done != finished * 10:
            raise RuntimeError("Completed update lacks its round output; inspect before planning")
        plan = {"format": "a2s1c4-round-plan-v1", "fromRound": finished + 1,
                "targetRound": finished + args.rounds,
                "initialWeightsSha256": initial["weightsSha256"],
                "courseConfigSha256": hashlib.sha256(json.dumps(config,
                    sort_keys=True).encode()).hexdigest(), "trainingSeed": SEED}
        if not args.dry_run:
            save_plan(plan)
    elif args.command == "continue":
        if not plan:
            raise RuntimeError("No saved A2S1C4 plan")
    else:
        raise ValueError(args.command)
    if (plan["initialWeightsSha256"] != initial["weightsSha256"] or
        plan["courseConfigSha256"] != hashlib.sha256(json.dumps(config,
            sort_keys=True).encode()).hexdigest() or plan["trainingSeed"] != SEED):
        raise ValueError("Saved plan has a different model, course or seed")
    show(initial, config, done, plan)
    if not args.dry_run:
        ensure_baseline(initial, entries)
    for number in range(plan["fromRound"], plan["targetRound"] + 1):
        complete_round(number, initial, entries, config, dry_run=args.dry_run)
    if not args.dry_run:
        archive = STATE / "plan-history"
        archive.mkdir(parents=True, exist_ok=True)
        os.replace(PLAN, archive /
                   f"round-{plan['fromRound']:03d}-{plan['targetRound']:03d}.json")


def main():
    parser = argparse.ArgumentParser(description="Manual A2S1C4 course rounds")
    parser.add_argument("command", choices=("init", "show", "new", "add", "continue", "interactive"))
    parser.add_argument("rounds", type=int, nargs="?")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.command == "interactive":
        initial, entries, config = identity()
        plan = json.loads(PLAN.read_text(encoding="utf-8")) if PLAN.exists() else None
        done = progress(initial, config)
        print("\n1 查看模型、配置与当前进度（不训练）")
        print("2 从候选开始新实验，输入计划轮数（首次建议1）")
        print("3 恢复未完成计划；若无计划则追加轮数")
        print("4 退出")
        choice = input("请选择 1-4：").strip()
        if choice == "4":
            return
        if choice == "1":
            args.command = "show"
        elif choice == "2":
            if plan or done:
                raise RuntimeError("已经有计划或训练进度，不能重新从候选开始")
            value = input("计划训练几轮？请输入正整数（1轮=400局）：").strip()
            args.command, args.rounds = "new", int(value)
        elif choice == "3":
            if plan:
                args.command = "continue"
                print("恢复原计划，不增加预算；未完成批次从最近完整更新重新采集。")
            else:
                if done != output_rounds() * 10 or not done:
                    raise RuntimeError("没有可追加的完整轮次；先新建或检查缺失的轮末输出")
                value = input("本次额外追加几轮？请输入正整数：").strip()
                args.command, args.rounds = "add", int(value)
        else:
            raise ValueError("菜单必须选择1、2、3或4")
        if args.command != "show":
            show(initial, config, done, plan)
            added = args.rounds if args.command in ("new", "add") else 0
            target = plan["targetRound"] if plan else output_rounds() + added
            print(f"目标第{target}轮/第{target * 10}次更新；输出 {OUTPUT}。")
            if input("输入 YES 确认开始，其他输入取消：").strip().upper() != "YES":
                return
    run(args)


if __name__ == "__main__":
    main()
