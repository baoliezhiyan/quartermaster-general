"""One architecture registry for PPO collection, restore, export and evaluation."""
from __future__ import annotations

import torch

from scripts.ppo_train import PpoNetwork

FLAT = "flat-v1-effective-straits"
MAP = "shared-regions-actor-adjacency-ordered-actions-v2"
STAGE2_EXPERIMENTS = {"S2FLAT": FLAT, "S2MAP": MAP}
ADAPTED_MAP = "map-contextual-opening-adapter-v1"
A2S1_ADAPTER = "map-contextual-opening-adapter-a2s1-v1"
ACTIVE_EXPERIMENTS = {"A1S2": ADAPTED_MAP, "A2S1": A2S1_ADAPTER,
                      "A2S1W1": A2S1_ADAPTER}


def make_network(architecture, encoder):
    if architecture == FLAT:
        return PpoNetwork(encoder.state_dim, encoder.candidate_dim)
    if architecture == MAP:
        from scripts.ppo_map_network import PpoMapNetwork
        return PpoMapNetwork(encoder)
    if architecture == ADAPTED_MAP:
        from scripts.ppo_opening_adapter import PpoOpeningAdapter
        return PpoOpeningAdapter(encoder)
    if architecture == A2S1_ADAPTER:
        from scripts.ppo_opening_adapter import A2S1MapAdapter
        return A2S1MapAdapter(encoder)
    raise ValueError(f"Unknown PPO architecture: {architecture}")


def migrate_flat_state(saved, encoder):
    """Append historical strait facts; old logits and values remain unchanged."""
    network = saved["network"]
    if network["candidateDim"] != encoder.candidate_dim or network["stateDim"] >= encoder.state_dim:
        raise ValueError("Source flat dimensions cannot migrate by state-input prefix")
    model = make_network(FLAT, encoder)
    target = model.state_dict()
    for name, tensor in saved["modelState"].items():
        if name == "state_net.0.weight":
            if tensor.shape[0] != target[name].shape[0]:
                raise ValueError("Source state hidden width differs")
            target[name][:, :network["stateDim"]] = tensor
            target[name][:, network["stateDim"]:] = 0
        elif name in target and target[name].shape == tensor.shape:
            target[name] = tensor
        else:
            raise ValueError(f"Source flat layer cannot migrate: {name}")
    model.load_state_dict(target)
    return model


def map_from_flat(flat, encoder):
    from scripts.ppo_map_network import migrate_flat
    return migrate_flat(flat, make_network(MAP, encoder))
