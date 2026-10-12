"""One architecture registry for PPO collection, restore, export and evaluation."""
from __future__ import annotations

import torch

from scripts.ppo_train import PpoNetwork
from scripts.ppo_legacy_potential import vector as historical_vector

FLAT = "flat-v1-effective-straits"
MAP = "shared-regions-actor-adjacency-ordered-actions-v2"
STAGE2_EXPERIMENTS = {"S2FLAT": FLAT, "S2MAP": MAP}
ADAPTED_MAP = "map-contextual-opening-adapter-v1"
A2S1_ADAPTER = "map-contextual-opening-adapter-a2s1-v1"
HISTORICAL_GATE_ADAPTER = "map-contextual-opening-adapter-a2s1-historical-gate-v2"
ACTIVE_EXPERIMENTS = {"A1S2": ADAPTED_MAP, "A2S1": A2S1_ADAPTER,
                      "A2S1W1": A2S1_ADAPTER, "A2S1C1": A2S1_ADAPTER,
                      "A2S1C2": A2S1_ADAPTER, "A2S1C3": A2S1_ADAPTER,
                      "A2S1C4": A2S1_ADAPTER,
                      "A2AUTOBASE": A2S1_ADAPTER,
                      "A2AUTOCAND": A2S1_ADAPTER,
                      "A2AUTO": A2S1_ADAPTER, "A2AUTO2": A2S1_ADAPTER}


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
    if architecture == HISTORICAL_GATE_ADAPTER:
        from scripts.ppo_opening_adapter import A2S1HistoricalGateAdapter
        return A2S1HistoricalGateAdapter(encoder)
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


def migrate_signal_potential(saved, encoder):
    """Explicitly append potential-signal inputs without changing initial logits.

    The old candidate features remain a prefix. New input weights are zero,
    and the opening prototype gets the same zero suffix. This is a new model
    identity; callers must save it as a separate initial checkpoint.
    """
    old = saved.get("network", {})
    if (saved.get("networkArchitecture") != A2S1_ADAPTER or
            saved.get("mode") != "A" or saved.get("cardSet") != "signals" or
            old.get("stateDim") != encoder.state_dim or
            not isinstance(old.get("candidateDim"), int) or
            old["candidateDim"] >= encoder.candidate_dim):
        raise ValueError("Source cannot migrate to potential-signal encoder")
    model = make_network(A2S1_ADAPTER, encoder)
    target = model.state_dict()
    candidate_weight = "map.base.candidate_net.0.weight"
    prototype = "prototype_candidate"
    for name, value in saved["modelState"].items():
        if name in (candidate_weight, prototype):
            if value.shape[:-1] != target[name].shape[:-1] or value.shape[-1] != old["candidateDim"]:
                raise ValueError(f"Unexpected migrated tensor shape: {name}")
            target[name][..., :old["candidateDim"]] = value
            target[name][..., old["candidateDim"]:] = 0
        elif name in target and target[name].shape == value.shape:
            target[name] = value
        else:
            raise ValueError(f"Source tensor cannot migrate: {name}")
    model.load_state_dict(target, strict=True)
    return model


def migrate_scoped_signal(saved, encoder):
    """Migrate only when the obsolete potential suffix had no policy influence.

    The opening adapter also measures candidate distance. Zero first-layer
    weights alone do not prove neutrality when opening_logit is nonzero.
    """
    if saved.get("encoderVersion") != "ppo-vector-a2s1-v5-audited-potential":
        raise ValueError("Scoped migration requires the audited v5 encoder")
    old = saved.get("network", {})
    core = saved.get("semanticMigration", {}).get("unchangedCoreDim")
    if not isinstance(core, int) or not core < old.get("candidateDim", 0):
        raise ValueError("Historical common candidate prefix is unverified")
    state = saved["modelState"]
    for name in ("map.base.candidate_net.0.weight", "prototype_candidate"):
        value = state[name]
        if value.shape[-1] != old["candidateDim"] or torch.count_nonzero(value[..., core:]):
            raise ValueError("Historical potential suffix has trained weights")
    if torch.count_nonzero(state["opening_logit"]):
        raise ValueError("Opening gate used obsolete potential semantics; exact migration impossible")
    cropped = {name: tensor.detach().clone() for name, tensor in state.items()}
    for name in ("map.base.candidate_net.0.weight", "prototype_candidate"):
        cropped[name] = cropped[name][..., :core].clone()
    source = {**saved, "network": {**old, "candidateDim": core},
              "modelState": cropped}
    return migrate_signal_potential(source, encoder)


def migrate_scoped_signal_historical_gate(saved, encoder):
    """Preserve trained v5 opening similarity via a separate old-feature suffix."""
    if (saved.get("encoderVersion") != "ppo-vector-a2s1-v5-audited-potential" or
            saved.get("networkArchitecture") != A2S1_ADAPTER or
            saved.get("mode") != "A" or saved.get("cardSet") != "signals"):
        raise ValueError("Source is not the audited A-mode v5 adapter")
    old = saved.get("network", {})
    core = saved.get("semanticMigration", {}).get("unchangedCoreDim")
    if (not isinstance(core, int) or old.get("stateDim") != encoder.state_dim or
            old.get("candidateDim") != core +
            len(historical_vector(encoder, None, None)) or
            encoder.historical_start <= core):
        raise ValueError("Historical candidate projection layout differs")
    source = saved["modelState"]
    old_weight = source["map.base.candidate_net.0.weight"]
    if old_weight.shape[-1] != old["candidateDim"] or torch.count_nonzero(old_weight[..., core:]):
        raise ValueError("Historical potential was learned by the base network")
    model = make_network(HISTORICAL_GATE_ADAPTER, encoder)
    target = model.state_dict()
    for name, value in source.items():
        if name in ("map.base.candidate_net.0.weight", "prototype_candidate"):
            target[name].zero_()
            target[name][..., :core] = value[..., :core]
            if name == "prototype_candidate":
                target[name][..., encoder.historical_start:] = value[..., core:]
        elif name in target and target[name].shape == value.shape:
            target[name] = value.detach().clone()
        else:
            raise ValueError(f"Historical parameter cannot migrate: {name}")
    model.load_state_dict(target, strict=True)
    return model
