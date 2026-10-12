"""One bounded off-policy closure audit; never starts a PPO collection/update."""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_auto_archive import ExplorationArchive
from scripts.ppo_auto_behavior import probe as behavior_probe
from scripts.ppo_auto_explore import (VERSION, FrozenPolicy, capture_roots,
    capture_sentinels, explore_pairs, review_routes)
from scripts.ppo_auto_imitate import auxiliary_update
from scripts.ppo_auto_semantic_migrate import POOL, REVIEW, ROOT

ARCHIVE = ROOT / "short-closure-v1.sqlite"
REPORT = ROOT / "short-closure-v1.json"


def run(archive_path=ARCHIVE, report_path=REPORT):
    clients = [ppo.ArenaClient(card_set="signals") for _ in range(2)]
    started = time.perf_counter()
    try:
        policy = FrozenPolicy(ROOT / "initial.pt", clients[0], device="cpu")
        parent = FrozenPolicy(REVIEW, clients[0], device="cpu")
        if policy.weight_hash == parent.weight_hash:
            raise ValueError("Independent review source is identical to candidate")
        identity = {"buildFingerprint": clients[0].fingerprint,
                    "encoderVersion": ppo.encoder_version("signals"),
                    "rewardConfig": ppo.reward_config("signals"),
                    "explorerVersion": VERSION,
                    "scope": "A2AUTO2-bounded-closure-v1"}
        with ExplorationArchive(archive_path, identity) as archive:
            p2_deadline = archive.phase_deadline("p2", 1200)
            capture = capture_roots(clients[0], policy, archive, 20261012,
                max_roots=12, max_decisions=240, deadline=p2_deadline)
            heldout = capture_sentinels(clients[0], policy, archive, 20261012+82_000_000,
                deadline=p2_deadline, course_pool=POOL)
            exploration = explore_pairs(clients, policy, archive, max_pairs=2,
                max_steps=6000, wall_seconds=1200, seed=20261012)
            if archive.routes("candidate"):
                review = review_routes(clients, policy, parent, archive,
                    max_routes=3, max_steps=20_000, wall_seconds=1800,
                    seed=20261012)
            else:
                review = {"reviewed": [], "steps": 0,
                          "remainingCandidates": 0, "reason": "no_qualified_candidate"}
            demonstrations = archive.demonstration_batch(64, seed=20261012)
            all_sentinels = archive.sentinels()
            sentinels = all_sentinels[:4] + [item for item in all_sentinels[4:]
                if item["seed"] >= 10**9][:3]
            if demonstrations:
                def check(model):
                    return behavior_probe(clients[0], model, policy.encoder,
                        torch.device("cpu"), sentinels, archive,
                        source_hash=policy.file_hash)
                imitation = auxiliary_update(policy.model, policy.encoder,
                    demonstrations, [item["observation"] for item in sentinels],
                    torch.device("cpu"), behavior_check=check, seed=20261012)
                imitation.pop("optimizerState", None)
            else:
                imitation = {"status": "empty_qualified_library_no_learning",
                             "minibatches": 0}
            report = {"format": "auto-closed-loop-short-v1",
                "scope": "off-policy-only-no-PPO-training",
                "identity": identity,
                "sourceInitialSha256": policy.file_hash,
                "sourceWeightsSha256": policy.weight_hash,
                "capture": capture, "heldout": heldout,
                "exploration": {key: value for key, value in exploration.items()
                                if key != "branches"},
                "review": review, "qualifiedDemonstrations": len(demonstrations),
                "imitation": imitation,
                "budgets": {"p2EngineSteps": archive.counter("p2_engine_steps"),
                    "p3EngineSteps": archive.counter("p3_engine_steps"),
                    "p2Limit": 6000, "p3Limit": 20_000,
                    "p2DeadlineEpoch": archive.phase_deadline("p2", 1200),
                    "p3DeadlineEpoch": archive.phase_deadline("p3", 1800)
                        if archive.routes() else None},
                "archiveStats": archive.stats(),
                "inference": policy.timing,
                "wallSeconds": time.perf_counter()-started}
        report_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = report_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, report_path)
        return report
    finally:
        for client in clients:
            client.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, default=ARCHIVE)
    parser.add_argument("--report", type=Path, default=REPORT)
    args = parser.parse_args()
    result = run(args.archive, args.report)
    print(json.dumps({key: result[key] for key in (
        "scope", "sourceInitialSha256", "exploration", "review",
        "qualifiedDemonstrations", "imitation", "budgets", "wallSeconds")},
        ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
