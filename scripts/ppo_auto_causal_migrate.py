"""Read-only v5 -> v7 opening-gate migration and frozen-policy comparison."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_legacy_potential import encoder_classes
from scripts.ppo_network_factory import (A2S1_ADAPTER, HISTORICAL_GATE_ADAPTER,
    make_network, migrate_scoped_signal_historical_gate)

SOURCE = ppo.ROOT / "PPO训练/.state/A2AUTO2SEM/initial.pt"
SOURCE_SHA = "4815e4118e430426a5cd0b5bee3d9a4adbcf497ee86bdb7c124b3e74527ca41c"
SOURCE_WEIGHTS = "754b2b45e1187df096e6a6b0744c8a0858ade01ba033ecc6c688821a8e730088"
DEST = ppo.ROOT / "PPO训练/.state/A2AUTO2SEM-CAUSAL-V7/initial.pt"
REPORT = DEST.with_name("migration-report.json")
CORE = 17784


def file_sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def compare(model, migrated, old_encoder, encoder, observation):
    state_old, candidates_old = old_encoder.encode(observation)
    state_new, candidates_new = encoder.encode(observation)
    if not torch.equal(state_old, state_new):
        raise ValueError("Historical state feature meaning changed")
    if not torch.equal(candidates_old[:, :CORE], candidates_new[:, :CORE]):
        raise ValueError("Historical candidate core changed")
    if not torch.equal(candidates_old[:, CORE:],
                       candidates_new[:, encoder.historical_start:]):
        raise ValueError("Historical opening-gate projection changed")
    mask = torch.ones((1, len(candidates_old)), dtype=torch.bool)
    with torch.inference_mode():
        old_logits, old_value = model(state_old[None], candidates_old[None], mask)
        new_logits, new_value = migrated(state_new[None], candidates_new[None], mask)
        old_prob = torch.softmax(old_logits, dim=-1)
        new_prob = torch.softmax(new_logits, dim=-1)
    return {"round": observation["round"], "seat": observation["decisionSeat"],
        "node": observation["node"], "candidateCount": len(candidates_old),
        "maxLogitError": float((old_logits-new_logits).abs().max()),
        "maxProbabilityError": float((old_prob-new_prob).abs().max()),
        "valueError": float((old_value-new_value).abs().max()),
        "argmaxChanged": bool(old_logits.argmax() != new_logits.argmax()),
        "topDefinitionBefore": observation["candidates"][int(old_logits.argmax())].get("definitionId"),
        "topDefinitionAfter": observation["candidates"][int(new_logits.argmax())].get("definitionId")}


def observations(client):
    for seed in (3, 17, 41):
        observation = client.request(op="reset", seed=seed, gameId=f"causal-migration-{seed}",
            mode="A", cardSet="signals")["observation"]
        for depth in range(24):
            if observation is None:
                break
            if depth in (0, 1, 3, 7, 12, 18, 23) or observation["node"] == "ENGINE_CHOICE":
                yield observation
            candidates = observation["candidates"]
            choice = next((c for c in candidates if c.get("definitionId") in
                ("special_150", "special_136", "special_84", "special_199")), None)
            selected = choice if depth < 2 and choice else candidates[(depth * 7 + seed) % len(candidates)]
            response = client.request(op="step", action={**observation["decision"],
                "actionId": selected["id"]})
            observation = response["observation"]


def migrate():
    if DEST.exists() or REPORT.exists():
        raise FileExistsError("Independent migration output already exists")
    if file_sha(SOURCE) != SOURCE_SHA:
        raise ValueError("Audited parent file changed")
    saved = torch.load(SOURCE, map_location="cpu", weights_only=False)
    if (saved.get("experimentId") != "A2AUTO2SEM" or
        saved.get("networkArchitecture") != A2S1_ADAPTER or
        saved.get("encoderVersion") != "ppo-vector-a2s1-v5-audited-potential" or
        saved.get("weightsSha256") != SOURCE_WEIGHTS or
        saved.get("resourceMode") != "A" or saved.get("cardSet") != "signals" or
        saved.get("rewardConfig") != ppo.reward_config("signals")):
        raise ValueError("Audited parent configuration differs")
    client = ppo.ArenaClient(card_set="signals")
    try:
        Old, New = encoder_classes()
        old_encoder, encoder = Old(client.schema), New(client.schema)
        if (saved["network"] != {"stateDim": old_encoder.state_dim,
                                 "candidateDim": old_encoder.candidate_dim} or
            old_encoder.candidate_dim != CORE + 281 or
            encoder.historical_start != 19487):
            raise ValueError("Historical and new input dimensions differ")
        parent = make_network(A2S1_ADAPTER, old_encoder)
        parent.load_state_dict(saved["modelState"], strict=True)
        if ppo.model_weights_sha256(parent) != SOURCE_WEIGHTS:
            raise ValueError("Audited parent weights changed")
        model = migrate_scoped_signal_historical_gate(saved, encoder)
        parent.eval(); model.eval()
        checks = [compare(parent, model, old_encoder, encoder, observation)
                  for observation in observations(client)]
        maximum = {field: max(item[field] for item in checks) for field in
                   ("maxLogitError", "maxProbabilityError", "valueError")}
        if (maximum["maxLogitError"] > 1e-5 or
            maximum["maxProbabilityError"] > 1e-6 or
            maximum["valueError"] > 1e-5 or any(item["argmaxChanged"] for item in checks)):
            raise ValueError(f"Historical policy changed materially: {maximum}")
        payload = {"format": "quartermaster-ppo-causal-migration-initial-v1",
            "experimentId": "A2AUTO2SEM-CAUSAL-V7", "resourceMode": "A",
            "cardSet": "signals", "parentFileSha256": SOURCE_SHA,
            "parentWeightsSha256": SOURCE_WEIGHTS,
            "sourceBuildFingerprint": saved["buildFingerprint"],
            "buildFingerprint": client.fingerprint,
            "observationSchemaVersion": client.schema["observationSchemaVersion"],
            "encoderVersion": encoder.version,
            "encoderDictionarySha256": ppo.encoder_dictionary_hash(encoder),
            "networkArchitecture": HISTORICAL_GATE_ADAPTER,
            "network": {"stateDim": encoder.state_dim,
                        "candidateDim": encoder.candidate_dim},
            "rewardConfig": saved["rewardConfig"],
            "historicalGate": {"coreDim": CORE,
                "newSemanticStart": CORE,
                "historicalProjectionStart": encoder.historical_start,
                "oldPotentialRowsSourceCommit": "21e3763"},
            "weightsSha256": ppo.model_weights_sha256(model),
            "modelState": {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}}
        DEST.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=DEST.parent, suffix=".pt", delete=False) as stream:
            temporary = Path(stream.name)
        try:
            torch.save(payload, temporary)
            loaded = torch.load(temporary, map_location="cpu", weights_only=False)
            restored = make_network(HISTORICAL_GATE_ADAPTER, encoder)
            restored.load_state_dict(loaded["modelState"], strict=True)
            if ppo.model_weights_sha256(restored) != payload["weightsSha256"]:
                raise ValueError("Migrated weights changed on save/load")
            reloaded = [compare(parent, restored, old_encoder, encoder, observation)
                        for observation in observations(client)]
            if any(item["maxProbabilityError"] > 1e-6 or item["argmaxChanged"]
                   for item in reloaded):
                raise ValueError("Migrated policy changed after reload")
            os.replace(temporary, DEST)
        finally:
            temporary.unlink(missing_ok=True)
        report = {"parentFileSha256": SOURCE_SHA, "parentWeightsSha256": SOURCE_WEIGHTS,
            "modelFileSha256": file_sha(DEST), "modelWeightsSha256": payload["weightsSha256"],
            "buildFingerprint": client.fingerprint,
            "encoderVersion": encoder.version,
            "observationSchemaVersion": client.schema["observationSchemaVersion"],
            "probeCount": len(checks), "maxima": maximum, "probes": checks,
            "postReloadMaxima": {field: max(item[field] for item in reloaded)
                for field in maximum}}
        with tempfile.NamedTemporaryFile(dir=DEST.parent, mode="w", encoding="utf-8",
                                     suffix=".json", delete=False) as stream:
            report_temporary = Path(stream.name)
            json.dump(report, stream, ensure_ascii=False, indent=2)
        os.replace(report_temporary, REPORT)
        if file_sha(SOURCE) != SOURCE_SHA:
            raise ValueError("Parent changed during migration")
        return report
    finally:
        client.close()


if __name__ == "__main__":
    print(json.dumps(migrate(), ensure_ascii=False, indent=2))
