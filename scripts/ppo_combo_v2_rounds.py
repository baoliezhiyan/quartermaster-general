"""Manual A2S1C2 rounds. Importing or showing never starts PPO."""
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
STATE = ROOT / ".state" / "A2S1C2"
OUTPUT = ROOT / "A2S1C2"
INITIAL = STATE / "initial.pt"
POOL = STATE / "course-pool-v8.json.gz"
CHECKPOINT = STATE / "latest.pt"
REPORT = STATE / "training-report.json"
PLAN = STATE / "plan.json"
SEED = 20261005
WORKERS = 8


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def identity():
    if not INITIAL.exists():
        raise SystemExit("A2S1C2 尚未通过九模板课程和示范验收；缺少正式 initial.pt，训练未启动。")
    initial = torch.load(INITIAL, map_location="cpu", weights_only=False)
    if (initial.get("experimentId") != "A2S1C2" or
        initial.get("sourceExperimentId") != "A2S1C1" or initial.get("sourceUpdate") != 30 or
        initial.get("sourceCompletedEpisodes") != 1200 or
        initial.get("networkArchitecture") != A2S1_ADAPTER or
        initial.get("rewardConfig") != ppo.reward_config("signals") or
        initial.get("optimizerMigration") != "new-Adam-no-old-momentum"):
        raise ValueError("A2S1C2 initializer is not the reviewed update-30 BC migration")
    if sha(STATE / "demonstration-audit.json") != initial.get("demonstrationAuditSha256"):
        raise ValueError("A2S1C2 imitation audit differs from the initializer")
    audit = json.loads((STATE / "demonstration-audit.json").read_text(encoding="utf-8"))
    if (not audit.get("independentAcceptance", {}).get("accepted") or
            audit.get("selectedWeightsSha256") != initial.get("weightsSha256") or
            audit.get("adaptation", {}).get("selectedStep") is None or
            not initial.get("postDemonstrationFileSha256") or
            sha(STATE / "post-demonstration.pt") !=
            initial["postDemonstrationFileSha256"] or
            sha(ROOT / ".state" / "A2S1C1" / "latest.pt") !=
            initial.get("sourceCheckpointSha256")):
        raise ValueError("A2S1C2 independent acceptance or saved model binding differs")
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        model = make_network(A2S1_ADAPTER, encoder)
        model.load_state_dict(initial["modelState"], strict=True)
        if (client.fingerprint != initial["buildFingerprint"] or
            initial["network"] != {"stateDim": encoder.state_dim,
                                    "candidateDim": encoder.candidate_dim} or
            ppo.model_weights_sha256(model) != initial["weightsSha256"]):
            raise ValueError("A2S1C2 initializer build, encoding or weights differ")
        expected = course.pool_identity(client, initial["sourceCheckpointSha256"],
                                         initial["generatorWeightsSha256"])
        entries = course.read_pool(POOL, expected)["entries"]
        required = {f"{t.key}:{v}:{layer}" for t in course.TEMPLATES
                    for v in ("positive", "control") for layer in ("payoff", "preparation")}
        actual = {f"{e['template']}:{e['variant']}:{e['layer']}" for e in entries}
        if not required <= actual or not any(e["split"] == "evaluation" for e in entries):
            raise ValueError("A2S1C2 pool lacks required train/evaluation starts")
        from scripts.ppo_combo_metrics import VERSION as metrics_version
        configuration = {"version": course.VERSION, "mix": course.MIX,
            "poolIdentitySha256": expected["identitySha256"],
            "poolFileSha256": sha(POOL), "metricsVersion": metrics_version + "-c2",
            "demonstrationAuditSha256": initial["demonstrationAuditSha256"]}
        return initial, entries, configuration
    finally:
        client.close()


def progress(initial, config):
    if not CHECKPOINT.exists():
        return 0
    saved = torch.load(CHECKPOINT, map_location="cpu", weights_only=False)
    if (saved.get("experimentId") != "A2S1C2" or saved.get("mode") != "A" or
        saved.get("cardSet") != "signals" or
        saved.get("networkArchitecture") != A2S1_ADAPTER or
        saved.get("initialWeightsSha256") != initial["weightsSha256"] or
        saved.get("comboCourseConfig") != config or
        saved.get("trainingSeed") != SEED or
        saved.get("completedEpisodes") != 40 * saved.get("update", -1)):
        raise ValueError("A2S1C2 checkpoint does not match its plan or complete batches")
    return saved["update"]


def output_rounds():
    count = 0
    while all((OUTPUT / f"第{count + 1:03d}轮" / name).is_file() for name in
              (rounds.WEIGHTS_NAME, rounds.RECORD_NAME, "正常开局-概率抽样.jsonl",
               "课程保留评估.json", "评估概览.json")):
        count += 1
    return count


def show(initial, config, done, plan):
    print("A2S1C2 第二版连携：资源A；熵0.01；8环境；每次40局=正常28＋课程12；每轮10更新。")
    print(f"父模型 A2S1C1 更新30：{initial['sourceCheckpointSha256']}；"
          f"示范后起点权重：{initial['weightsSha256']}。")
    print(f"规则 {initial['buildFingerprint']}；课程 {config['version']}；池 {config['poolFileSha256']}。")
    print(f"完成更新 {done}（{done * 40}局）；完整输出 {output_rounds()}轮。")
    if plan:
        print(f"现有计划目标 {plan['targetRound']}轮/{plan['targetRound'] * 10}更新；"
              f"还需 {max(0, plan['targetRound'] * 10 - done)}更新。")


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
            print(f"A2S1C2 第{number}轮完整，跳过。")
            return
        raise RuntimeError(f"Existing incomplete output is protected: {destination}")
    if current > target:
        raise RuntimeError("Checkpoint passed a missing round; cannot reconstruct historical model")
    print(f"A2S1C2 第{number}轮：更新 {current}→{target}；还需 {(target-current)*40}局。")
    if dry_run:
        return
    if current < target:
        command = [sys.executable, "scripts/ppo_train.py", "--mode", "A",
            "--experiment-id", "A2S1C2", "--architecture", A2S1_ADAPTER,
            "--entropy-coefficient", "0.01", "--initial-weights", str(INITIAL),
            "--expected-initial-hash", initial["weightsSha256"],
            "--combo-pool", str(POOL), "--card-set", "signals", "--workers", str(WORKERS),
            "--updates", str(target-current), "--seed", str(SEED),
            "--checkpoint", str(CHECKPOINT), "--report", str(REPORT)]
        if current:
            command.append("--resume")
        subprocess.run(command, cwd=ppo.ROOT, check=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".c2-round-{number:03d}-", dir=OUTPUT) as folder:
        stage = Path(folder)
        digest = rounds.export_weights(CHECKPOINT, stage / rounds.WEIGHTS_NAME,
                                       "A", number, SEED, experiment_id="A2S1C2")
        normal = []
        for name, seed, deterministic in (
                (rounds.RECORD_NAME, 20620001, True),
                ("正常开局-概率抽样.jsonl", 20620002, False)):
            normal.append({"name": name, "seed": seed, "result": rounds.record_game(
                CHECKPOINT, stage / name, "A", number, SEED, digest,
                experiment_id="A2S1C2", entropy_coefficient=.01,
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
                experiment_id="A2S1C2", entropy_coefficient=.01,
                initial_weights_sha256=initial["weightsSha256"],
                architecture=A2S1_ADAPTER, course_config=config)
            course_reports = []
            for template in ("G2", "U2", "J2", "U4"):
                entry = next(e for e in entries if e["split"] == "evaluation" and
                             e["template"] == template and e["variant"] == "positive" and
                             e["layer"] == "preparation")
                name = f"课程保留-{template}.jsonl"
                course_reports.append(record_course(model, encoder, entry, stage / name,
                    {"experimentId": "A2S1C2", "round": number,
                     "policyVersion": target, "modelSha256": digest,
                     "courseConfig": config, "holdout": True}, deterministic=True))
            (stage / "课程保留评估.json").write_text(json.dumps(course_reports,
                ensure_ascii=False, indent=2), encoding="utf-8")
            (stage / "评估概览.json").write_text(json.dumps({"normal": normal,
                "holdoutCourse": course_reports,
                "limitation": "Diagnostic self-play; holdout starts do not establish overall strength."},
                ensure_ascii=False, indent=2), encoding="utf-8")
        finally:
            client.close()
        os.replace(stage, destination)
    print(f"A2S1C2 第{number}轮完成：{destination}")


def run(args):
    initial, entries, config = identity()
    done = progress(initial, config)
    plan = json.loads(PLAN.read_text(encoding="utf-8")) if PLAN.exists() else None
    if args.command == "show":
        show(initial, config, done, plan)
        return
    if args.command == "new":
        if plan:
            raise RuntimeError("Continue the saved plan before adding another budget")
        if args.rounds is None or args.rounds <= 0:
            raise ValueError("Added rounds must be a positive integer")
        finished = output_rounds()
        if done != finished * 10:
            raise RuntimeError("Completed update lacks its round output; inspect before planning")
        plan = {"format": "a2s1c2-round-plan-v1", "fromRound": finished + 1,
                "targetRound": finished + args.rounds,
                "initialWeightsSha256": initial["weightsSha256"],
                "courseConfigSha256": hashlib.sha256(json.dumps(config,
                    sort_keys=True).encode()).hexdigest(), "trainingSeed": SEED}
        if not args.dry_run:
            save_plan(plan)
    elif args.command == "continue":
        if not plan:
            raise RuntimeError("No saved A2S1C2 plan")
    else:
        raise ValueError(args.command)
    if (plan["initialWeightsSha256"] != initial["weightsSha256"] or
        plan["courseConfigSha256"] != hashlib.sha256(json.dumps(config,
            sort_keys=True).encode()).hexdigest() or plan["trainingSeed"] != SEED):
        raise ValueError("Saved plan has a different model, course or seed")
    show(initial, config, done, plan)
    for number in range(plan["fromRound"], plan["targetRound"] + 1):
        complete_round(number, initial, entries, config, dry_run=args.dry_run)
    if not args.dry_run:
        archive = STATE / "plan-history"
        archive.mkdir(parents=True, exist_ok=True)
        os.replace(PLAN, archive /
                   f"round-{plan['fromRound']:03d}-{plan['targetRound']:03d}.json")


def main():
    parser = argparse.ArgumentParser(description="Manual A2S1C2 course rounds")
    parser.add_argument("command", choices=("show", "new", "continue", "interactive"))
    parser.add_argument("rounds", type=int, nargs="?")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not INITIAL.is_file():
        print("A2S1C2 示范尚未通过保留局面对照；未生成可续训 initial.pt。"
              "课程池及失败诊断保留在 PPO训练/.state/A2S1C2；不会启动正式训练。")
        raise SystemExit(2)
    if args.command == "interactive":
        initial, entries, config = identity()
        plan = json.loads(PLAN.read_text(encoding="utf-8")) if PLAN.exists() else None
        show(initial, config, progress(initial, config), plan)
        if plan:
            choice = input("输入 C 继续现有计划，D 预览，其他键退出：").strip().upper()
            if choice not in ("C", "D"):
                return
            args.command, args.dry_run = "continue", choice == "D"
        else:
            value = input("输入本次新增轮数（正整数；D 只预览1轮）：").strip()
            args.command, args.dry_run = "new", value.upper() == "D"
            args.rounds = 1 if args.dry_run else int(value)
    run(args)


if __name__ == "__main__":
    main()
