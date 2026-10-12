"""One-way, explicit C4 -> potential-signal input migration for A2AUTO2.

The C4 checkpoint and its historical course pool are read-only. A new pool is
earned by legal reset/step replay; a new initializer is written atomically.
"""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts import ppo_auto_experiment as previous
from scripts.ppo_auto_pool_migrate import migrate as replay_pool
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network, migrate_signal_potential

EXPERIMENT = "A2AUTO2"
ROOT = ppo.ROOT / "PPO训练/.state" / EXPERIMENT
POOL = ROOT / "course-pool-potential-v1.json.gz"
REVIEW = ROOT / "review-parent-potential.pt"
REVIEW_SOURCE = (Path(r"C:\Users\1\.codex\worktrees\training-sync-v182\战场军需官") /
                 "PPO训练/.state/A2S1C3/latest.pt")
REVIEW_SOURCE_SHA = "ed32ba1f9e6927be8a4cec739942533ff5d949137b39239429b53c9855b5c0b7"
OLD_POOL_SHA = "5ff8c323ba56e12b7dae215b47a56159f8142a42d767080cb12615f9721c1bd2"
OLD_ENCODER = "ppo-vector-a2s1-v3-use-scopes"
OLD_BUILD = "433a8ab044f124a68b29cef01e1a18475b9545d2b12ebf0bff0e28823447b252"


def state_hash(state):
    digest = hashlib.sha256()
    for name, tensor in sorted(state.items()):
        raw = tensor.detach().cpu().contiguous().numpy().tobytes()
        digest.update(name.encode())
        digest.update(len(raw).to_bytes(8, "little"))
        digest.update(raw)
    return digest.hexdigest()


class LegacyEncoder(ppo.Encoder):
    def _potential_vector(self, potential):
        return []


def initialize():
    initial_path = ROOT / "initial.pt"
    if initial_path.exists() or (ROOT / "latest.pt").exists():
        raise FileExistsError("A2AUTO2 initializer or training checkpoint already exists")
    if previous.sha(previous.PARENT) != previous.PARENT_SHA:
        raise ValueError("C4 source checkpoint file differs")
    if previous.sha(previous.POOL) != OLD_POOL_SHA:
        raise ValueError("Historical course pool differs")
    parent = torch.load(previous.PARENT, map_location="cpu", weights_only=False)
    if (parent.get("experimentId") != "A2S1C4" or parent.get("update") != 20 or
        parent.get("completedEpisodes") != 800 or parent.get("mode") != "A" or
        parent.get("cardSet") != "signals" or parent.get("networkArchitecture") != A2S1_ADAPTER or
        parent.get("encoderVersion") != OLD_ENCODER or
        parent.get("buildFingerprint") != OLD_BUILD or
        state_hash(parent["modelState"]) != previous.PARENT_WEIGHTS):
        raise ValueError("C4 source model identity differs")
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        legacy_encoder = LegacyEncoder(client.schema)
        if (parent["network"] != {"stateDim": legacy_encoder.state_dim,
                                  "candidateDim": legacy_encoder.candidate_dim} or
            encoder.state_dim != legacy_encoder.state_dim):
            raise ValueError("Potential-signal encoder is not an append-only candidate migration")
        legacy = make_network(A2S1_ADAPTER, legacy_encoder)
        legacy.load_state_dict(parent["modelState"], strict=True)
        migrated = migrate_signal_potential(parent, encoder)
        for seed in (3, 17, 41):
            observation = client.request(op="reset", seed=seed, gameId=f"migration-{seed}",
                mode="A", cardSet="signals", trace="none")["observation"]
            old_state, old_candidates = legacy_encoder.encode(observation)
            state, candidates = encoder.encode(observation)
            if not torch.equal(old_state, state) or not torch.equal(
                    old_candidates, candidates[:, :legacy_encoder.candidate_dim]):
                raise ValueError("Existing candidate prefix changed during migration")
            with torch.inference_mode():
                old_logits, old_value = legacy(*ppo.batch_tensors([{
                    "state": old_state, "candidates": old_candidates}], torch.device("cpu")))
                new_logits, new_value = migrated(*ppo.batch_tensors([{
                    "state": state, "candidates": candidates}], torch.device("cpu")))
            if not torch.allclose(old_logits, new_logits, atol=1e-5, rtol=1e-5) or \
                    not torch.allclose(old_value, new_value, atol=1e-5, rtol=1e-5):
                raise ValueError("Zero-extension changed the initial policy or value")
        if not POOL.exists():
            replay_pool(previous.POOL, POOL, expected_source_sha=OLD_POOL_SHA)
        if not REVIEW.exists():
            if previous.sha(REVIEW_SOURCE) != REVIEW_SOURCE_SHA:
                raise ValueError("Independent review policy file differs")
            source_review = torch.load(REVIEW_SOURCE, map_location="cpu", weights_only=False)
            if (source_review.get("experimentId") != "A2S1C3" or
                source_review.get("update") != 20 or
                source_review.get("network") != parent["network"] or
                source_review.get("encoderVersion") != OLD_ENCODER):
                raise ValueError("Independent review policy identity differs")
            review_model = migrate_signal_potential(source_review, encoder)
            review_payload = {"format": "quartermaster-offpolicy-review-migrated-v1",
                "sourceFileSha256": REVIEW_SOURCE_SHA,
                "sourceWeightsSha256": state_hash(source_review["modelState"]),
                "mode": "A", "cardSet": "signals", "networkArchitecture": A2S1_ADAPTER,
                "network": {"stateDim": encoder.state_dim,
                            "candidateDim": encoder.candidate_dim},
                "encoderVersion": ppo.encoder_version("signals"),
                "buildFingerprint": client.fingerprint,
                "modelState": {key: value.detach().cpu().clone()
                               for key, value in review_model.state_dict().items()}}
            ROOT.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=ROOT, suffix=".pt", prefix=".review-", delete=False) as stream:
                review_temporary = Path(stream.name)
            try:
                torch.save(review_payload, review_temporary)
                os.replace(review_temporary, REVIEW)
            finally:
                review_temporary.unlink(missing_ok=True)
        review_check = torch.load(REVIEW, map_location="cpu", weights_only=False)
        if (review_check.get("sourceFileSha256") != REVIEW_SOURCE_SHA or
            review_check.get("buildFingerprint") != client.fingerprint or
            review_check.get("encoderVersion") != ppo.encoder_version("signals") or
            review_check.get("network") != {"stateDim": encoder.state_dim,
                                             "candidateDim": encoder.candidate_dim}):
            raise ValueError("Migrated independent review policy differs")
        from scripts import ppo_combo_course_v2 as course
        with __import__("gzip").open(POOL, "rt", encoding="utf-8") as stream:
            pool = __import__("json").load(stream)
        expected_pool = course.pool_identity(client,
            pool["migration"]["sourceIdentity"]["parentCheckpointSha256"],
            pool["migration"]["sourceIdentity"]["generatorWeightsSha256"])
        course.read_pool(POOL, expected_pool)
        payload = {"format": "quartermaster-ppo-comparison-initial-v1",
            "experimentId": EXPERIMENT, "sourceExperimentId": "A2S1C4",
            "sourceUpdate": 20, "sourceCompletedEpisodes": 800,
            "sourceC4CheckpointSha256": previous.PARENT_SHA,
            "sourceCheckpointSha256": expected_pool["parentCheckpointSha256"],
            "generatorWeightsSha256": expected_pool["generatorWeightsSha256"],
            "demonstrationAuditSha256": parent["comboCourseConfig"]["demonstrationAuditSha256"],
            "networkArchitecture": A2S1_ADAPTER,
            "network": {"stateDim": encoder.state_dim, "candidateDim": encoder.candidate_dim},
            "encoderVersion": ppo.encoder_version("signals"),
            "buildFingerprint": client.fingerprint,
            "rewardConfig": ppo.reward_config("signals"), "resourceMode": "A",
            "coursePoolSha256": previous.sha(POOL),
            "optimizerMigration": "new-Adam-no-old-momentum",
            "candidateMigration": {"sourceEncoderVersion": OLD_ENCODER,
                "sourceBuildFingerprint": OLD_BUILD,
                "sourceCandidateDim": legacy_encoder.candidate_dim,
                "newCandidateDim": encoder.candidate_dim,
                "sourceWeightsSha256": previous.PARENT_WEIGHTS,
                "initialLogitCheckSeeds": [3, 17, 41]},
            "weightsSha256": ppo.model_weights_sha256(migrated),
            "modelState": {key: value.detach().cpu().clone()
                           for key, value in migrated.state_dict().items()}}
        ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=ROOT, suffix=".pt", prefix=".initial-", delete=False) as stream:
            temporary = Path(stream.name)
        try:
            torch.save(payload, temporary)
            check = torch.load(temporary, map_location="cpu", weights_only=False)
            restored = make_network(A2S1_ADAPTER, encoder)
            restored.load_state_dict(check["modelState"], strict=True)
            if ppo.model_weights_sha256(restored) != payload["weightsSha256"]:
                raise ValueError("Migrated initializer changed on disk")
            os.replace(temporary, initial_path)
        finally:
            temporary.unlink(missing_ok=True)
        return {"fileSha256": previous.sha(initial_path),
                "weightsSha256": payload["weightsSha256"],
                "buildFingerprint": client.fingerprint,
                "poolSha256": payload["coursePoolSha256"],
                "network": payload["network"]}
    finally:
        client.close()


if __name__ == "__main__":
    import json
    print(json.dumps(initialize(), ensure_ascii=False, indent=2))
