"""Explicit bounded archive/branch interface smoke, separate from PPO."""
from __future__ import annotations

import json
from pathlib import Path

from scripts import ppo_train as ppo
from scripts import ppo_auto_experiment as exp
from scripts.ppo_auto_archive import ExplorationArchive
from scripts.ppo_auto_explore import VERSION, FrozenPolicy, capture_roots, explore_pairs


def main():
    clients = [ppo.ArenaClient(card_set="signals") for _ in range(2)]
    try:
        policy = FrozenPolicy(exp.PARENT, clients[0])
        archive_path = exp.ROOT / ".state/A2AUTO/short-smoke.sqlite"
        identity = {"sourceCheckpointSha256": policy.file_hash,
            "sourceWeightsSha256": policy.weight_hash,
            "buildFingerprint": clients[0].fingerprint,
            "encoderVersion": ppo.encoder_version("signals"),
            "rewardConfig": ppo.reward_config("signals"),
            "explorerVersion": VERSION, "scope": "manual-interface-smoke"}
        with ExplorationArchive(archive_path, identity) as archive:
            roots = capture_roots(clients[0], policy, archive, 20261919,
                                  max_roots=4, max_decisions=80)
            branches = explore_pairs(clients, policy, archive,
                max_pairs=max(0, 2-archive.branch_pairs()),
                max_steps=600, wall_seconds=120, seed=20261919)
            stats = archive.stats()
        print(json.dumps({"scope": "off-policy-only-no-PPO-update",
            "roots": roots, "branchPairs": branches["pairs"],
            "branchSteps": branches["steps"], "archive": stats,
            "path": str(archive_path)}, ensure_ascii=False, indent=2))
    finally:
        for client in clients:
            client.close()


if __name__ == "__main__":
    main()
