"""Explicit, one-way weights migration to the revised A2S1 waste reward.

This never edits the old A2S1 checkpoint or report and never starts PPO.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network

SOURCE = ppo.ROOT / "PPO训练" / ".state" / "A2S1" / "latest.pt"
DESTINATION = ppo.ROOT / "PPO训练" / ".state" / "A2S1W1" / "initial.pt"
OLD_REWARD = "complete-action-and-deferred-target-v2"
NEW_REWARD = "complete-action-settled-benefit-v3"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect(source: Path = SOURCE):
    if not source.is_file():
        raise FileNotFoundError(source)
    original = torch.load(source, map_location="cpu", weights_only=False)
    if (original.get("format") != "quartermaster-ppo-checkpoint-v1" or
            original.get("experimentId") != "A2S1" or
            original.get("mode") != "A" or original.get("cardSet") != "signals" or
            original.get("networkArchitecture") != A2S1_ADAPTER or
            original.get("encoderVersion") != ppo.A2S1_ENCODER_VERSION or
            original.get("optimizerConfig", {}).get("entropy") != .01 or
            original.get("rewardConfig", {}).get("actionWasteVersion") != OLD_REWARD or
            original.get("completedEpisodes") != original.get("update", -1) * 40):
        raise ValueError("A2S1 source identity, reward, or completed-batch boundary differs")
    if ppo.reward_config("signals")["actionWasteVersion"] != NEW_REWARD:
        raise ValueError("Target reward configuration differs")
    return original


def prepare(source: Path = SOURCE, destination: Path = DESTINATION, dry_run=False):
    if destination.exists() or destination.with_name("latest.pt").exists():
        raise FileExistsError("A2S1W1 already has an initializer or a training checkpoint")
    original = inspect(source)
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        if (original["network"] != {"stateDim": encoder.state_dim,
                                    "candidateDim": encoder.candidate_dim} or
                original["observationSchemaVersion"] != client.schema["observationSchemaVersion"] or
                original["actionSchemaVersion"] != client.schema["actionSchemaVersion"] or
                original["eventIds"] != client.schema["eventIds"]):
            raise ValueError("Current rules, observation, action, or card IDs require separate migration")
        model = make_network(A2S1_ADAPTER, encoder)
        model.load_state_dict(original["modelState"], strict=True)
        source_hash = sha256(source)
        identity = {"format": "quartermaster-ppo-comparison-initial-v1",
                    "experimentId": "A2S1W1", "networkArchitecture": A2S1_ADAPTER,
                    "network": original["network"], "encoderVersion": ppo.A2S1_ENCODER_VERSION,
                    "buildFingerprint": client.fingerprint,
                    "sourceCheckpointSha256": source_hash,
                    "sourceExperimentId": "A2S1", "sourceUpdate": original["update"],
                    "sourceCompletedEpisodes": original["completedEpisodes"],
                    "sourceRewardVersion": OLD_REWARD, "rewardConfig": ppo.reward_config("signals"),
                    "optimizerMigration": "new-Adam-no-old-momentum",
                    "weightsSha256": ppo.model_weights_sha256(model),
                    "modelState": model.state_dict()}
        report = {key: value for key, value in identity.items() if key != "modelState"}
        report["oldBuildFingerprint"] = original["buildFingerprint"]
        report["newExperimentStartsAtUpdate"] = 0
        report["newExperimentStartsWithFreshTrajectories"] = True
        if dry_run:
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return report
        destination.parent.mkdir(parents=True, exist_ok=False)
        temporary = destination.with_suffix(".tmp")
        try:
            torch.save(identity, temporary)
            os.replace(temporary, destination)
            restored = torch.load(destination, map_location="cpu", weights_only=False)
            if restored["weightsSha256"] != report["weightsSha256"]:
                raise ValueError("Migrated initializer failed reload")
            report["initialFileSha256"] = sha256(destination)
            destination.with_name("migration-report.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return report
    finally:
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Explicit A2S1 v2 to A2S1W1 v3 reward migration")
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--destination", type=Path, default=DESTINATION)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    prepare(args.source, args.destination, args.dry_run)
