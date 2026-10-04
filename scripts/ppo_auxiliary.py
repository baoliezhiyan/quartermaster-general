"""Separate, decaying supervised update after a complete PPO update."""
from __future__ import annotations

import hashlib
from pathlib import Path

import torch

from scripts import ppo_train as ppo


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def config(path, initial_weight, decay_updates):
    if initial_weight < 0 or decay_updates < 1:
        raise ValueError("Invalid auxiliary strength or decay")
    return {"format": "a1s2-independent-auxiliary-v1",
            "enabled": initial_weight > 0,
            "datasetSha256": sha256(path), "initialWeight": initial_weight,
            "decayUpdates": decay_updates}


def load(path, expected_weights_hash, fingerprint, encoder):
    bundle = torch.load(path, map_location="cpu", weights_only=False)
    if (bundle.get("format") != "quartermaster-a1s2-auxiliary-v1" or
        bundle.get("adaptedWeightsSha256") != expected_weights_hash or
        bundle.get("buildFingerprint") != fingerprint or
        bundle.get("encoderVersion") != ppo.ENCODER_VERSION or
        len(bundle.get("arden", ())) < 1 or len(bundle.get("controls", ())) < 6):
        raise ValueError("A1S2 auxiliary data identity differs")
    for item in [bundle["opening"], *bundle["arden"], *bundle["controls"]]:
        if (item["state"].numel() != encoder.state_dim or
            item["candidates"].shape[1] != encoder.candidate_dim or
            item["candidates"].shape[0] < 1):
            raise ValueError("A1S2 auxiliary data shape differs")
    return bundle


def weight_at_update(settings, completed_update):
    if not settings["enabled"]:
        return 0.0
    return settings["initialWeight"] * max(0.0, 1.0 - (completed_update - 1) /
                                            settings["decayUpdates"])


def update(model, optimizer, bundle, device, strength, completed_update):
    if strength <= 0:
        return {"appliedWeight": 0.0, "supervisedLoss": None, "retentionKl": None,
                "source": "scripted-labels-only"}
    model.train()
    with torch.inference_mode():
        prior_values = [float(model(*ppo.batch_tensors([item], device))[1][0])
                        for item in bundle["controls"]]
    optimizer.zero_grad(set_to_none=True)
    opening = bundle["opening"]
    arden = bundle["arden"][(completed_update - 1) % len(bundle["arden"])]
    def chosen_loss(item):
        logits, _ = model(*ppo.batch_tensors([item], device))
        return -logits[0, :item["candidates"].shape[0]].log_softmax(-1)[item["chosen"]]
    supervised = chosen_loss(opening) + .5 * chosen_loss(arden)
    control_terms = []
    for item in bundle["controls"]:
        logits, _ = model(*ppo.batch_tensors([item], device))
        student = logits[0, :item["candidates"].shape[0]].log_softmax(-1)
        teacher = item["teacher"].to(device)
        control_terms.append((teacher * (teacher.clamp_min(1e-30).log() - student)).sum())
    retention = torch.stack(control_terms).mean()
    loss = strength * (supervised + 3.0 * retention)
    loss.backward()
    gradient = float(torch.nn.utils.clip_grad_norm_(model.parameters(), 0.5))
    optimizer.step()
    with torch.inference_mode():
        value_drift = max(abs(float(model(*ppo.batch_tensors([item], device))[1][0]) - before)
                          for item, before in zip(bundle["controls"], prior_values))
    return {"appliedWeight": strength, "supervisedLoss": float(supervised.detach()),
            "retentionKl": float(retention.detach()), "gradientNorm": gradient,
            "maximumControlValueDrift": value_drift,
            "source": "scripted-labels-only", "sampleCount": 2,
            "controlCount": len(bundle["controls"])}
