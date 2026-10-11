"""Independent, rollback-safe policy imitation of reviewed off-policy routes."""
from __future__ import annotations

import copy
import math
import random
from collections import defaultdict

import torch

from scripts import ppo_train as ppo

VERSION = "auto-imitation-v1"
DEFAULT_CONFIG = {"maxMinibatches": 2, "minibatchSize": 64, "learningRate": 1e-5,
                  "sentinelKlLimit": .01, "valueDriftLimit": .15,
                  "maxConsecutiveRollbacks": 2}


def _encode_batch(encoder, items, device):
    encoded, labels = [], []
    for item in items:
        observation = item["observation"]
        choices = observation["candidates"]
        positions = [index for index, candidate in enumerate(choices)
                     if candidate["id"] == item["actionId"]]
        if len(positions) != 1:
            raise ValueError("Reviewed demonstration action is missing or ambiguous")
        state, candidates = encoder.encode(observation)
        encoded.append({"state": state, "candidates": candidates})
        labels.append(positions[0])
    return ppo.batch_tensors(encoded, device), torch.tensor(labels, device=device)


def _sentinel(model, encoder, observations, device):
    results = []
    with torch.inference_mode():
        for observation in observations:
            state, candidates = encoder.encode(observation)
            logits, value = model(*ppo.batch_tensors(
                [{"state": state, "candidates": candidates}], device))
            results.append((torch.softmax(logits[0, :len(observation["candidates"])], -1)
                            .detach().cpu(), float(value[0])))
    return results


def _drift(before, after):
    kl, value = 0.0, 0.0
    for (old_probs, old_value), (new_probs, new_value) in zip(before, after):
        kl = max(kl, float((old_probs * (old_probs.clamp_min(1e-38).log() -
                                        new_probs.clamp_min(1e-38).log())).sum()))
        value = max(value, abs(new_value-old_value))
    return kl, value


def route_balanced_samples(demonstrations, limit, seed):
    groups = defaultdict(list)
    for item in demonstrations:
        groups[item["routeId"]].append(item)
    rng = random.Random(seed)
    routes = sorted(groups)
    selected = []
    while routes and len(selected) < limit:
        rng.shuffle(routes)
        for route in list(routes):
            selected.append(groups[route].pop(rng.randrange(len(groups[route]))))
            if not groups[route]:
                routes.remove(route)
            if len(selected) >= limit:
                break
    return selected


def auxiliary_update(model, encoder, demonstrations, sentinel_observations, device,
                     *, config=None, optimizer_state=None, seed=0):
    """Never touches PPO samples, return/value targets, or PPO optimizer state."""
    settings = {**DEFAULT_CONFIG, **(config or {})}
    if not demonstrations:
        return {"status": "empty_library", "version": VERSION,
                "minibatches": 0, "optimizerState": optimizer_state}
    if not sentinel_observations:
        raise ValueError("Auxiliary imitation requires a non-training sentinel set")
    policy_parameters = [(name, parameter) for name, parameter in model.named_parameters()
                         if "value" not in name]
    optimizer = torch.optim.Adam([parameter for _, parameter in policy_parameters],
                                 lr=settings["learningRate"])
    if optimizer_state is not None:
        optimizer.load_state_dict(copy.deepcopy(optimizer_state))
    original_requires_grad = {id(parameter): parameter.requires_grad
                              for parameter in model.parameters()}
    for name, parameter in model.named_parameters():
        if "value" in name:
            parameter.requires_grad_(False)
    base = _sentinel(model, encoder, sentinel_observations, device)
    metrics, rollbacks = [], 0
    try:
        for number in range(settings["maxMinibatches"]):
            items = route_balanced_samples(demonstrations,
                min(settings["minibatchSize"], len(demonstrations)), seed+number)
            if not items:
                break
            weights_before = {key: value.detach().clone()
                              for key, value in model.state_dict().items()}
            optimizer_before = copy.deepcopy(optimizer.state_dict())
            (states, candidates, mask), labels = _encode_batch(encoder, items, device)
            logits, _ = model(states, candidates, mask)
            loss = torch.nn.functional.cross_entropy(logits, labels)
            if not torch.isfinite(loss):
                model.load_state_dict(weights_before)
                optimizer.load_state_dict(optimizer_before)
                metrics.append({"minibatch": number+1, "accepted": False,
                                "reason": "nonfinite_loss"})
                rollbacks += 1
                break
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            if any(not torch.isfinite(parameter).all() for parameter in model.parameters()):
                accepted, reason, kl, drift = False, "nonfinite_parameter", None, None
            else:
                kl, drift = _drift(base, _sentinel(model, encoder, sentinel_observations, device))
                accepted = (math.isfinite(kl) and math.isfinite(drift) and
                            kl <= settings["sentinelKlLimit"] and
                            drift <= settings["valueDriftLimit"])
                reason = "accepted" if accepted else "sentinel_drift"
            if not accepted:
                model.load_state_dict(weights_before)
                optimizer.load_state_dict(optimizer_before)
                for group in optimizer.param_groups:
                    group["lr"] *= .5
                rollbacks += 1
            else:
                rollbacks = 0
            metrics.append({"minibatch": number+1, "accepted": accepted,
                            "reason": reason, "loss": float(loss.detach()),
                            "sentinelKl": kl, "valueDrift": drift,
                            "learningRateAfter": optimizer.param_groups[0]["lr"]})
            if rollbacks >= settings["maxConsecutiveRollbacks"]:
                break
        return {"status": "paused_after_rollbacks" if rollbacks >= 2 else "complete",
                "version": VERSION, "config": settings, "minibatches": len(metrics),
                "metrics": metrics, "optimizerState": optimizer.state_dict()}
    finally:
        for parameter in model.parameters():
            parameter.requires_grad_(original_requires_grad[id(parameter)])
