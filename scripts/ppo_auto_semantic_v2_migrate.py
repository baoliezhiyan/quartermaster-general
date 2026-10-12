"""Explicit, read-only v4 -> audited v5 capability migration for short off-policy audit.

The v4 capability suffix was zero initialized and never PPO trained. We verify
that fact before dropping the obsolete, text-derived fields and appending the
new audited fields with zero input weights. Historical artifacts stay intact.
"""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_auto_pool_migrate import migrate as replay_pool
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network, migrate_signal_potential

OLD = ppo.ROOT / "PPO训练/.state/A2AUTO2"
ROOT = ppo.ROOT / "PPO训练/.state/A2AUTO2SEM"
INITIAL = ROOT / "initial.pt"
REVIEW = ROOT / "review-parent.pt"
POOL = ROOT / "course-pool-audited-v1.json.gz"
OLD_FILE = "0d40cbb8a265f7ea7606448fc0dc78df63d33e6697691b22dd4ddd2d7fe5eb3c"
OLD_WEIGHT = "d784e244ba139eec94c5478efe5461d89c38193f9e2e5a7b1818c63111189538"
OLD_ENCODER = "ppo-vector-a2s1-v4-potential-signals"
OLD_BUILD = "fb6369053ef2d8542fd0f87aa6a7f92afbfba01d0bf78b94ec76d93edd7dc1cb"
OLD_POOL = "19b8761c53c9a103a08ed19243c529468495ba00bb2e47ff0805c01d124e6753"


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def atomic_torch(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".audited-", suffix=".pt",
                                     delete=False) as stream:
        temporary = Path(stream.name)
    try:
        torch.save(payload, temporary)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def audited_model(source, encoder):
    old = source["network"]["candidateDim"]
    core = source["candidateMigration"]["sourceCandidateDim"]
    state = {name: value.detach().cpu().clone() for name, value in source["modelState"].items()}
    for name in ("map.base.candidate_net.0.weight", "prototype_candidate"):
        if state[name].shape[-1] != old or torch.count_nonzero(state[name][..., core:]):
            raise ValueError("Historical potential-channel weights are not zero")
        state[name] = state[name][..., :core].clone()
    core_source = {**source, "mode": "A", "cardSet": "signals",
                   "network": {"stateDim": encoder.state_dim, "candidateDim": core},
                   "modelState": state}
    migrated = migrate_signal_potential(core_source, encoder)
    return migrated, core


def migrate():
    source_path = OLD / "initial.pt"
    if digest(source_path) != OLD_FILE:
        raise ValueError("Historical initializer file differs")
    source = torch.load(source_path, map_location="cpu", weights_only=False)
    if (source.get("weightsSha256") != OLD_WEIGHT or
        source.get("encoderVersion") != OLD_ENCODER or
        source.get("buildFingerprint") != OLD_BUILD or
        source.get("resourceMode") != "A" or
        source.get("networkArchitecture") != A2S1_ADAPTER):
        raise ValueError("Historical initializer identity differs")
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        model, core = audited_model(source, encoder)
        if source["network"]["stateDim"] != encoder.state_dim:
            raise ValueError("Global observation changed; append-only migration invalid")
        # The obsolete capability channel had zero weights. The common core
        # remains identical and every new capability input starts with zero.
        old_core = make_network(A2S1_ADAPTER, encoder)
        old_core.load_state_dict(model.state_dict(), strict=True)
        for seed in (3, 17, 41):
            observation = client.request(op="reset", seed=seed, mode="A",
                                         cardSet="signals")["observation"]
            state, actions = encoder.encode(observation)
            neutral = actions.clone()
            neutral[:, core:] = 0
            batch = ppo.batch_tensors([{"state": state, "candidates": actions}],
                                      torch.device("cpu"))
            neutral_batch = ppo.batch_tensors([{"state": state, "candidates": neutral}],
                                              torch.device("cpu"))
            with torch.inference_mode():
                logits, value = model(*batch)
                neutral_logits, neutral_value = old_core(*neutral_batch)
            torch.testing.assert_close(logits, neutral_logits, atol=1e-6, rtol=0)
            torch.testing.assert_close(value, neutral_value, atol=1e-6, rtol=0)
        previous_pool = OLD / "course-pool-potential-v1.json.gz"
        if digest(previous_pool) != OLD_POOL:
            raise ValueError("Historical course pool file differs")
        if not POOL.exists():
            replay_pool(previous_pool, POOL, expected_source_sha=OLD_POOL)
        from scripts import ppo_combo_course_v2 as course
        import gzip
        import json
        with gzip.open(POOL, "rt", encoding="utf-8") as stream:
            pool = json.load(stream)
        expected_pool = course.pool_identity(client,
            pool["migration"]["sourceIdentity"]["parentCheckpointSha256"],
            pool["migration"]["sourceIdentity"]["generatorWeightsSha256"])
        course.read_pool(POOL, expected_pool)
        payload = {"format": "quartermaster-ppo-comparison-initial-v1",
            "experimentId": "A2AUTO2SEM", "sourceExperimentId": "A2AUTO2",
            "sourceFileSha256": OLD_FILE, "sourceWeightsSha256": OLD_WEIGHT,
            "resourceMode": "A", "cardSet": "signals", "mode": "A",
            "networkArchitecture": A2S1_ADAPTER,
            "network": {"stateDim": encoder.state_dim,
                        "candidateDim": encoder.candidate_dim},
            "encoderVersion": ppo.encoder_version("signals"),
            "buildFingerprint": client.fingerprint,
            "rewardConfig": ppo.reward_config("signals"),
            "coursePoolSha256": digest(POOL), "optimizerMigration": "new-Adam",
            "semanticMigration": {"oldEncoder": OLD_ENCODER,
                "oldBuild": OLD_BUILD, "oldCandidateDim": source["network"]["candidateDim"],
                "unchangedCoreDim": core, "oldPotentialWeightsZero": True,
                "newPotentialWeightsZero": True,
                "initialLogitCheckSeeds": [3, 17, 41]},
            "weightsSha256": ppo.model_weights_sha256(model),
            "modelState": {name: value.detach().cpu().clone()
                           for name, value in model.state_dict().items()}}
        if not INITIAL.exists():
            atomic_torch(INITIAL, payload)
        loaded = torch.load(INITIAL, map_location="cpu", weights_only=False)
        if any(loaded.get(key) != payload[key] for key in ("weightsSha256",
                "buildFingerprint", "encoderVersion", "coursePoolSha256")):
            raise ValueError("Existing audited initializer has different identity")
        restored = make_network(A2S1_ADAPTER, encoder)
        restored.load_state_dict(loaded["modelState"], strict=True)
        if ppo.model_weights_sha256(restored) != payload["weightsSha256"]:
            raise ValueError("Audited initializer failed reload")
        review_old_path = OLD / "review-parent-potential.pt"
        review_old = torch.load(review_old_path, map_location="cpu", weights_only=False)
        if (review_old.get("encoderVersion") != OLD_ENCODER or
            review_old.get("buildFingerprint") != OLD_BUILD or
            review_old.get("network") != source["network"]):
            raise ValueError("Historical independent review model differs")
        review_model, _ = audited_model({**review_old,
            "candidateMigration": source["candidateMigration"]}, encoder)
        review_payload = {**{key: value for key, value in payload.items()
            if key != "modelState"}, "experimentId": "A2AUTO2SEM-REVIEW",
            "sourceFileSha256": digest(review_old_path),
            "weightsSha256": ppo.model_weights_sha256(review_model),
            "modelState": {name: value.detach().cpu().clone()
                for name, value in review_model.state_dict().items()}}
        if not REVIEW.exists():
            atomic_torch(REVIEW, review_payload)
        existing_review = torch.load(REVIEW, map_location="cpu", weights_only=False)
        if any(existing_review.get(key) != review_payload[key] for key in
               ("sourceFileSha256", "weightsSha256", "encoderVersion",
                "buildFingerprint", "network", "coursePoolSha256")):
            raise ValueError("Existing independent review migration differs")
        if digest(source_path) != OLD_FILE:
            raise ValueError("Historical initializer was modified")
        return {"initialFileSha256": digest(INITIAL), "initialWeightsSha256":
            payload["weightsSha256"], "poolSha256": digest(POOL),
            "reviewFileSha256": digest(REVIEW), "buildFingerprint": client.fingerprint,
            "encoderVersion": ppo.encoder_version("signals"),
            "oldCoreDim": core, "newCandidateDim": encoder.candidate_dim}
    finally:
        client.close()


if __name__ == "__main__":
    import json
    print(json.dumps(migrate(), ensure_ascii=False, indent=2))
