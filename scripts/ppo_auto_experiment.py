"""Explicit migration and bounded orchestration for automatic-exploration PPO.

The old C4 checkpoint and course pool are read only. A formal plan is never
started merely by importing this module or showing configuration.
"""
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
from scripts import ppo_combo_course_v2 as course
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network

ROOT = ppo.ROOT / "PPO训练"
PARENT = (Path(r"C:\Users\1\.codex\worktrees\training-sync-v182\战场军需官") /
          "PPO训练/.state/A2S1C4/latest.pt")
PARENT_SHA = "165152a554bc68ee2a97bdbd4ab338537e21037190c6c091aec61288ebdc2e70"
PARENT_WEIGHTS = "c42540437629886d33d83449ad2ced090a02bba2eed13036f73a05bf75aa5752"
POOL = ROOT / ".state/A2自动探索试验01/course-pool-replayed-final.json.gz"
SOURCE_POOL_SHA = "13ae0b722bf03bd2e0fedd613a51fc4e8ff2578e303d98b6dff32f97275f5cd6"
EXPERIMENTS = ("A2AUTOBASE", "A2AUTOCAND", "A2AUTO", "A2AUTO2")
SEED = 20261011
WORKERS = 8


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pool_path(experiment):
    if experiment == "A2AUTO2":
        from scripts.ppo_auto_semantic_migrate import POOL as potential_pool
        return potential_pool
    return POOL


def _parent_model(client):
    if not PARENT.is_file() or sha(PARENT) != PARENT_SHA:
        raise ValueError("Completed C4 parent checkpoint is missing or changed")
    parent = torch.load(PARENT, map_location="cpu", weights_only=False)
    if (parent.get("experimentId") != "A2S1C4" or parent.get("update") != 20 or
        parent.get("completedEpisodes") != 800 or parent.get("mode") != "A" or
        parent.get("cardSet") != "signals" or
        parent.get("networkArchitecture") != A2S1_ADAPTER or
        parent.get("encoderVersion") != ppo.encoder_version("signals") or
        parent.get("rewardConfig", {}).get("actionWasteVersion") !=
            "complete-action-settled-benefit-v3"):
        raise ValueError("C4 parent model identity differs")
    encoder = ppo.Encoder(client.schema)
    if parent["network"] != {"stateDim": encoder.state_dim,
                             "candidateDim": encoder.candidate_dim}:
        raise ValueError("C4 parent network input dimensions differ")
    model = make_network(A2S1_ADAPTER, encoder)
    model.load_state_dict(parent["modelState"], strict=True)
    if ppo.model_weights_sha256(model) != PARENT_WEIGHTS:
        raise ValueError("C4 parent weights differ")
    return parent, encoder, model


def pool_identity(client, experiment=None):
    selected = pool_path(experiment)
    if not selected.is_file():
        raise FileNotFoundError("Replayed course pool is missing; run explicit pool migration")
    with __import__("gzip").open(selected, "rt", encoding="utf-8") as stream:
        payload = json.load(stream)
    migration = payload.get("migration", {})
    source_sha = sha(POOL) if experiment == "A2AUTO2" else SOURCE_POOL_SHA
    if migration.get("sourcePoolSha256") != source_sha:
        raise ValueError("Course pool was not legally replayed from the reviewed source")
    old = migration["sourceIdentity"]
    expected = course.pool_identity(client, old["parentCheckpointSha256"],
                                    old["generatorWeightsSha256"])
    course.read_pool(selected, expected)
    return expected, sha(selected), len(payload["entries"])


def initialize(experiment):
    if experiment not in EXPERIMENTS:
        raise ValueError(experiment)
    if experiment == "A2AUTO2":
        from scripts.ppo_auto_semantic_migrate import initialize as migrate
        return migrate()
    state = ROOT / ".state" / experiment
    initial = state / "initial.pt"
    if initial.exists() or (state / "latest.pt").exists():
        raise FileExistsError(f"Existing {experiment} initializer or progress is protected")
    client = ppo.ArenaClient(card_set="signals")
    try:
        parent, encoder, model = _parent_model(client)
        pool, pool_sha, count = pool_identity(client)
        if count != 114:
            raise ValueError("Replayed course pool entry count differs")
        payload = {"format": "quartermaster-ppo-comparison-initial-v1",
            "experimentId": experiment, "sourceExperimentId": "A2S1C4",
            "sourceUpdate": 20, "sourceCompletedEpisodes": 800,
            "sourceC4CheckpointSha256": PARENT_SHA,
            "sourceCheckpointSha256": pool["parentCheckpointSha256"],
            "generatorWeightsSha256": pool["generatorWeightsSha256"],
            "demonstrationAuditSha256": parent["comboCourseConfig"]["demonstrationAuditSha256"],
            "lineage": ["A2S1C1:update30", "A2S1C2", "three-course-BC",
                        "A2S1C3:update20", "A2S1C4:update20", experiment+":update0"],
            "networkArchitecture": A2S1_ADAPTER, "network": parent["network"],
            "encoderVersion": parent["encoderVersion"],
            "buildFingerprint": client.fingerprint,
            "rewardConfig": ppo.reward_config("signals"), "resourceMode": "A",
            "coursePoolSha256": pool_sha,
            "optimizerMigration": "new-Adam-no-old-momentum",
            "weightsSha256": ppo.model_weights_sha256(model),
            "modelState": {key: value.detach().cpu().clone()
                           for key, value in parent["modelState"].items()}}
        state.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=state, prefix=".initial-", suffix=".pt",
                                         delete=False) as stream:
            temporary = Path(stream.name)
        try:
            torch.save(payload, temporary)
            check = torch.load(temporary, map_location="cpu", weights_only=False)
            restored = make_network(A2S1_ADAPTER, encoder)
            restored.load_state_dict(check["modelState"], strict=True)
            if ppo.model_weights_sha256(restored) != PARENT_WEIGHTS:
                raise ValueError("Initializer reload changed model weights")
            os.replace(temporary, initial)
        finally:
            temporary.unlink(missing_ok=True)
        return {"experiment": experiment, "initialFileSha256": sha(initial),
                "initialWeightsSha256": payload["weightsSha256"],
                "buildFingerprint": client.fingerprint,
                "reward": payload["rewardConfig"], "poolSha256": pool_sha,
                "sourceC4CheckpointSha256": PARENT_SHA}
    finally:
        client.close()


def validate(experiment):
    if experiment == "A2AUTO2":
        state = ROOT / ".state" / experiment
        initial_file = state / "initial.pt"
        if not initial_file.is_file():
            raise FileNotFoundError("A2AUTO2 has no explicit potential-signal initializer")
        initial = torch.load(initial_file, map_location="cpu", weights_only=False)
        client = ppo.ArenaClient(card_set="signals")
        try:
            encoder = ppo.Encoder(client.schema)
            pool_file = pool_path(experiment)
            with __import__("gzip").open(pool_file, "rt", encoding="utf-8") as stream:
                pool = json.load(stream)
            old = pool["migration"]["sourceIdentity"]
            expected = course.pool_identity(client, old["parentCheckpointSha256"],
                                            old["generatorWeightsSha256"])
            course.read_pool(pool_file, expected)
            if (initial.get("experimentId") != experiment or
                initial.get("sourceC4CheckpointSha256") != PARENT_SHA or
                initial.get("encoderVersion") != ppo.encoder_version("signals") or
                initial.get("buildFingerprint") != client.fingerprint or
                initial.get("network") != {"stateDim": encoder.state_dim,
                                           "candidateDim": encoder.candidate_dim} or
                initial.get("coursePoolSha256") != sha(pool_file) or
                initial.get("rewardConfig") != ppo.reward_config("signals") or
                initial.get("optimizerMigration") != "new-Adam-no-old-momentum"):
                raise ValueError("A2AUTO2 migrated initializer identity differs")
            model = make_network(A2S1_ADAPTER, encoder)
            model.load_state_dict(initial["modelState"], strict=True)
            if ppo.model_weights_sha256(model) != initial["weightsSha256"]:
                raise ValueError("A2AUTO2 migrated weights changed")
            return initial, {"fileSha256": sha(initial_file),
                             "weightsSha256": initial["weightsSha256"],
                             "buildFingerprint": client.fingerprint,
                             "poolSha256": sha(pool_file)}
        finally:
            client.close()
    state = ROOT / ".state" / experiment
    initial_file = state / "initial.pt"
    if not initial_file.is_file():
        raise FileNotFoundError(f"{experiment} has no initializer")
    initial = torch.load(initial_file, map_location="cpu", weights_only=False)
    client = ppo.ArenaClient(card_set="signals")
    try:
        _, encoder, model = _parent_model(client)
        pool, pool_sha, _ = pool_identity(client)
        if (initial.get("experimentId") != experiment or
            initial.get("sourceC4CheckpointSha256") != PARENT_SHA or
            initial.get("sourceUpdate") != 20 or
            initial.get("buildFingerprint") != client.fingerprint or
            initial.get("rewardConfig") != ppo.reward_config("signals") or
            initial.get("encoderVersion") != ppo.encoder_version("signals") or
            initial.get("coursePoolSha256") != pool_sha or
            initial.get("sourceCheckpointSha256") != pool["parentCheckpointSha256"] or
            initial.get("generatorWeightsSha256") != pool["generatorWeightsSha256"] or
            initial.get("optimizerMigration") != "new-Adam-no-old-momentum"):
            raise ValueError("Automatic exploration initializer identity differs")
        model.load_state_dict(initial["modelState"], strict=True)
        if ppo.model_weights_sha256(model) != initial["weightsSha256"]:
            raise ValueError("Initializer weights differ")
        return initial, {"fileSha256": sha(initial_file),
                         "weightsSha256": initial["weightsSha256"],
                         "buildFingerprint": client.fingerprint,
                         "poolSha256": pool_sha}
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("initialize", "show"))
    parser.add_argument("experiment", choices=EXPERIMENTS)
    args = parser.parse_args()
    result = initialize(args.experiment) if args.command == "initialize" else validate(args.experiment)[1]
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
