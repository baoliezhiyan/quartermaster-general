"""One-way, checked migration from the accepted A1S2 adaptation to A2S1.

This creates a new experiment initializer. It never edits the parent model.
"""
from __future__ import annotations

import hashlib
import json
import os
import argparse
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_network_factory import ADAPTED_MAP, A2S1_ADAPTER, make_network

ROOT = ppo.ROOT
PARENT = ROOT / "PPO训练" / "A1S2" / "白色方案示范适应" / "模型.pt"
ACCEPTANCE = PARENT.with_name("验收.json")
INITIAL = ROOT / "PPO训练" / ".state" / "A2S1" / "initial.pt"
EXPECTED_PARENT_FILE = "5e38d70a8412d7c9da54079b95fdc1ded3a18bb059c46678aa404a09a38ee3bd"
EXPECTED_PARENT_WEIGHTS = "c0bca61cc9604f7e9d06dde59c5522cc20540ec6592403cc9f2caf1e53cc02bf"


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def migrate_state_columns(source, target, old, new):
    old_card_start = old.map_slices[0][0] - 3 * len(old.cards) - 2 * len(old.seats)
    new_card_start = new.map_slices[0][0] - 3 * len(new.cards) - 2 * len(new.seats)
    old_nodes_end = 8 + len(ppo.PHASES) + len(ppo.NODES)
    if new_card_start - old_card_start != 1:
        raise ValueError("Unexpected A2S1 state layout")
    target[..., :old_nodes_end] = source[..., :old_nodes_end]
    target[..., old_nodes_end + 1:new_card_start] = source[..., old_nodes_end:old_card_start]
    for group in range(3):
        a = old_card_start + group * len(old.cards)
        b = new_card_start + group * len(new.cards)
        target[..., b:b + len(old.cards)] = source[..., a:a + len(old.cards)]
    old_tail = old_card_start + 3 * len(old.cards)
    new_tail = new_card_start + 3 * len(new.cards)
    target[..., new_tail:new_tail + source.shape[-1] - old_tail] = source[..., old_tail:]


def migrate_candidate_columns(source, target, old, new):
    card_start = len(ppo.CANDIDATE_KINDS)
    if new.cards[:len(old.cards)] != old.cards:
        raise ValueError("Old candidate card dictionary is not a prefix")
    target[..., :card_start + len(old.cards)] = source[..., :card_start + len(old.cards)]
    old_after_cards = card_start + len(old.cards)
    new_after_cards = card_start + len(new.cards)
    ordered_width = ppo.TARGET_SLOTS * (1 + len(old.countries) + 3)
    simple_width = len(old.regions) + len(old.countries) + 4 + ordered_width
    target[..., new_after_cards:new_after_cards + simple_width] = source[
        ..., old_after_cards:old_after_cards + simple_width]
    old_choice_start = old_after_cards + simple_width
    new_choice_start = new_after_cards + simple_width
    old_effect_start = old.candidate_semantic_start - old.max_effects * old.effect_dim
    new_effect_start = new.candidate_semantic_start - new.max_effects * new.effect_dim
    old_choice_width = (old_effect_start - old_choice_start) // ppo.CHOICE_SLOTS
    new_choice_width = (new_effect_start - new_choice_start) // ppo.CHOICE_SLOTS
    prefix = old_choice_width - len(old.cards) - 2
    if new_choice_width != old_choice_width + len(new.cards) - len(old.cards):
        raise ValueError("Unexpected A2S1 choice token layout")
    for slot in range(ppo.CHOICE_SLOTS):
        a = old_choice_start + slot * old_choice_width
        b = new_choice_start + slot * new_choice_width
        target[..., b:b + prefix + len(old.cards)] = source[..., a:a + prefix + len(old.cards)]
        target[..., b + prefix + len(new.cards):b + new_choice_width] = source[
            ..., a + prefix + len(old.cards):a + old_choice_width]
    if old.effect_dim != new.effect_dim or old.max_effects != new.max_effects:
        raise ValueError("Effect token layout requires a separate migration")
    target[..., new_effect_start:new.candidate_semantic_start] = source[
        ..., old_effect_start:old.candidate_semantic_start]
    old_semantic = old.candidate_semantic_start
    new_semantic = new.candidate_semantic_start
    old_slots = old.candidate_dim - old_semantic - 6
    new_slots = new.candidate_dim - new_semantic - 6 - 4
    if old_slots * new.max_action_slots != new_slots * old.max_action_slots:
        raise ValueError("Action semantic token width changed")
    target[..., new_semantic:new_semantic + old_slots] = source[..., old_semantic:old_semantic + old_slots]
    target[..., new_semantic + new_slots:new_semantic + new_slots + 6] = source[..., -6:]


def migrate(parent, old, new):
    source = make_network(ADAPTED_MAP, old)
    source.load_state_dict(parent["modelState"])
    if ppo.model_weights_sha256(source) != EXPECTED_PARENT_WEIGHTS:
        raise ValueError("Parent weights hash mismatch")
    target = make_network(A2S1_ADAPTER, new)
    old_state = source.state_dict()
    new_state = target.state_dict()
    with torch.no_grad():
        for name, tensor in old_state.items():
            if name in ("prototype_state", "prototype_candidate"):
                continue
            current = new_state[name]
            if name == "map.base.state_net.0.weight":
                current.zero_()
                migrate_state_columns(tensor, current, old, new)
            elif name == "map.base.candidate_net.0.weight":
                current.zero_()
                migrate_candidate_columns(tensor, current, old, new)
            elif current.shape == tensor.shape:
                current.copy_(tensor)
            else:
                raise ValueError(f"Unmigrated tensor: {name}")
        target.load_state_dict(new_state)
    return target


def opening_probabilities(model, encoder, observation):
    state, candidates = encoder.encode(observation)
    with torch.no_grad():
        logits, value = model(state[None], candidates[None],
                              torch.ones((1, len(candidates)), dtype=torch.bool))
        probs = torch.softmax(logits[0], -1)
    ranked = sorted(zip(observation["candidates"], probs.tolist()),
                    key=lambda item: item[1], reverse=True)
    return {"whitePlan": next(prob for item, prob in ranked if item.get("definitionId") == "special_150"),
            "whitePlanRank": next(i + 1 for i, (item, _) in enumerate(ranked)
                                  if item.get("definitionId") == "special_150"),
            "topFive": [{"id": item["id"], "probability": probability}
                        for item, probability in ranked[:5]], "value": float(value[0])}


def prepare(refresh=False):
    if INITIAL.exists():
        if not refresh:
            raise FileExistsError(f"A2S1 initial model already exists: {INITIAL}")
        existing = torch.load(INITIAL, map_location="cpu", weights_only=False)
        if (existing.get("format") != "quartermaster-ppo-comparison-initial-v1" or
            existing.get("experimentId") != "A2S1" or
            existing.get("sourceModelSha256") != EXPECTED_PARENT_FILE or
            INITIAL.with_name("latest.pt").exists()):
            raise ValueError("Only our untrained A2S1 initializer can be refreshed")
    if sha256(PARENT) != EXPECTED_PARENT_FILE:
        raise ValueError("Accepted A1S2 parent file hash differs")
    accepted = json.loads(ACCEPTANCE.read_text(encoding="utf-8"))
    if accepted.get("derivedModelSha256") != EXPECTED_PARENT_FILE or accepted.get("sampledWhiteRate", 0) < .65:
        raise ValueError("A1S2 acceptance evidence is missing or failed")
    parent = torch.load(PARENT, map_location="cpu", weights_only=False)
    if (parent.get("format") != "quartermaster-a1s2-white-plan-adapted-v1" or
        parent.get("weightsSha256") != EXPECTED_PARENT_WEIGHTS or
        parent.get("encoderVersion") != ppo.ENCODER_VERSION or
        parent.get("networkArchitecture") != ADAPTED_MAP):
        raise ValueError("A1S2 parent identity differs")
    old_client = ppo.ArenaClient(card_set="events")
    new_client = ppo.ArenaClient(card_set="signals")
    try:
        old_encoder = ppo.Encoder(old_client.schema)
        new_encoder = ppo.Encoder(new_client.schema)
        if parent["network"] != {"stateDim": old_encoder.state_dim,
                                 "candidateDim": old_encoder.candidate_dim}:
            raise ValueError("A1S2 encoder dimensions differ")
        model = migrate(parent, old_encoder, new_encoder)
        opening = new_client.request(op="reset", seed=20600000, mode="A", cardSet="signals")["observation"]
        white = next((candidate for candidate in opening["candidates"]
                      if candidate.get("definitionId") == "special_150"), None)
        if white is None:
            raise ValueError("White Plan missing in A2S1 opening")
        state, candidates = new_encoder.encode(opening)
        index = opening["candidates"].index(white)
        with torch.no_grad():
            model.prototype_state.copy_(state)
            model.prototype_candidate.copy_(candidates[index])
        probabilities = opening_probabilities(model, new_encoder, opening)
        identity = {"format": "quartermaster-ppo-comparison-initial-v1",
                    "experimentId": "A2S1", "networkArchitecture": A2S1_ADAPTER,
                    "network": {"stateDim": new_encoder.state_dim,
                                "candidateDim": new_encoder.candidate_dim},
                    "encoderVersion": ppo.A2S1_ENCODER_VERSION,
                    "buildFingerprint": new_client.fingerprint,
                    "sourceModelSha256": EXPECTED_PARENT_FILE,
                    "sourceWeightsSha256": EXPECTED_PARENT_WEIGHTS,
                    "migration": "zero-new-input-weights-and-reencode-opening-prototype-v1",
                    "weightsSha256": ppo.model_weights_sha256(model),
                    "modelState": model.state_dict()}
        INITIAL.parent.mkdir(parents=True, exist_ok=True)
        if INITIAL.exists():
            previous_hash = sha256(INITIAL)
            archive = INITIAL.parent / "migration-history" / previous_hash[:12]
            if archive.exists():
                raise FileExistsError(f"Migration archive exists: {archive}")
            archive.mkdir(parents=True)
            os.replace(INITIAL, archive / "initial.pt")
            previous_report = INITIAL.with_name("migration-report.json")
            if previous_report.exists():
                os.replace(previous_report, archive / "migration-report.json")
        temporary = INITIAL.with_suffix(".tmp")
        torch.save(identity, temporary)
        os.replace(temporary, INITIAL)
        reloaded = torch.load(INITIAL, map_location="cpu", weights_only=False)
        fresh = make_network(A2S1_ADAPTER, new_encoder)
        fresh.load_state_dict(reloaded["modelState"])
        if ppo.model_weights_sha256(fresh) != identity["weightsSha256"]:
            raise ValueError("Migrated A2S1 weights failed reload")
        report = {"parentFileSha256": EXPECTED_PARENT_FILE,
                  "parentWeightsSha256": EXPECTED_PARENT_WEIGHTS,
                  "initialFileSha256": sha256(INITIAL),
                  "initialWeightsSha256": identity["weightsSha256"],
                  "encoderVersion": ppo.A2S1_ENCODER_VERSION,
                  "buildFingerprint": new_client.fingerprint,
                  "opening": probabilities,
                  "migration": identity["migration"],
                  "newOptimizer": True, "auxiliaryLossEnabled": False}
        INITIAL.with_name("migration-report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False))
    finally:
        old_client.close()
        new_client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true",
                        help="archive only our untrained initializer before rebuilding")
    prepare(refresh=parser.parse_args().refresh)
