"""Small, versioned PPO client for the headless event curriculum.

The TypeScript server owns the rules. This file owns observation encoding,
per-seat trajectories, reward accounting, and policy optimization.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import subprocess
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import torch
from torch import nn
from torch.distributions import Categorical


ROOT = Path(__file__).resolve().parents[1]
GAMMA = 1.0
LAMBDA_ROUND = 0.95
POTENTIAL_SCALE = 0.3
ENCODER_VERSION = "ppo-vector-v3"
TRAINER_VERSION = "ppo-trainer-v3"
EFFECT_KINDS = ["action", "score", "draw", "deckTop", "forceHand", "signal", "choose", "cards",
                "extraPlay", "rebuild", "remove", "flag", "balance", "trace", "cancel", "randomReturn",
                "randomPlay", "frameChange", "countChange", "reallocate", "prelude", "copyStatus"]
ACTIONS = ["build_army", "build_navy", "recruit_army", "recruit_navy", "land_battle", "sea_battle",
           "air_power", "air_deploy", "air_move", "destroy"]
PHASES = ["TURN_START_WINDOW", "PLAY", "AIR", "SUPPLY", "SCORE", "DISCARD", "DRAW"]
CHOICE_KINDS = ["BUILD_ORDER", "EFFECT_DECISION", "AIR_DEFENSE", "AIR_INTERCEPT", "TRIGGER",
                "ORDER_MANDATORY_TRIGGERS", "FORCE_HAND", "PAY_COST", "ACTION", "RELOCATE",
                "REALLOCATE", "EFFECTS", "SELECT", "CARDS", "EXTRA_CARD", "EXTRA_TARGET", "EXTRA_EFFECTS"]
CHOICE_FIELDS = ["regionId", "defenderId", "attackerId", "option"]
TARGET_SLOTS = 8
CHOICE_SLOTS = 16
CHOICE_FEATURE_KINDS = ["build_order", "action_region", "defenderId", "attackerId",
                        "empty_defender", "action_plan", "effect_choice", "extra_card",
                        "reallocate", "cards", "force_hand", "pay_cost", "region_target",
                        "country_target", "unit_target", "relocate", "trigger",
                        "order_mandatory_triggers", "accept", "decline", "execute"]
OPTIMIZER_CONFIG = {"lr": 3e-4, "epochs": 4, "minibatch": 256, "clip": 0.2,
                    "entropy": 0.01, "valueCoefficient": 0.5, "gradNorm": 0.5}
REWARD_CONFIG = {"gamma": GAMMA, "lambdaRound": LAMBDA_ROUND, "potential": POTENTIAL_SCALE}
ENCODER_DICTIONARY = {"effectKinds": EFFECT_KINDS, "actions": ACTIONS, "phases": PHASES,
                      "choiceKinds": CHOICE_KINDS, "choiceFields": CHOICE_FIELDS,
                      "targetSlots": TARGET_SLOTS, "choiceSlots": CHOICE_SLOTS,
                      "choiceFeatureKinds": CHOICE_FEATURE_KINDS}
ENCODER_DICTIONARY_HASH = hashlib.sha256(json.dumps(ENCODER_DICTIONARY, sort_keys=True).encode()).hexdigest()
TRAINER_SOURCE_HASH = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def onehot(value, names):
    out = [0.0] * len(names)
    if value in names:
        out[names.index(value)] = 1.0
    return out


class ArenaClient:
    def __init__(self, log_path=None):
        command = ["node", "scripts/ppo-arena-server.mjs"]
        if log_path:
            command += ["--log", str(log_path)]
        self.process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)
        first = self.process.stdout.readline()
        if not first:
            raise RuntimeError(f"Arena server failed: {self.process.stderr.read()}")
        greeting = json.loads(first)
        if not greeting.get("ready"):
            raise RuntimeError(greeting)
        self.fingerprint = greeting["buildFingerprint"]
        self.schema = greeting["staticSchema"]

    def request(self, **message):
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(f"Arena server closed: {self.process.stderr.read()}")
        response = json.loads(line)
        if not response.get("ok"):
            raise RuntimeError(f"Arena error: {response.get('error')}")
        return response

    def close(self):
        if self.process.poll() is None:
            try:
                self.request(op="close")
            except (RuntimeError, BrokenPipeError):
                pass
            self.process.wait(timeout=10)


class Encoder:
    def __init__(self, schema):
        self.schema = schema
        self.regions = [r["id"] for r in schema["regions"]]
        self.region_index = {name: i for i, name in enumerate(self.regions)}
        self.region_data = {r["id"]: r for r in schema["regions"]}
        self.countries = list(schema["countries"])
        self.seats = list(schema["seats"])
        self.cards = list(schema["basicActions"]) + list(schema["eventIds"])
        self.binding_keys = list(schema["bindingKeys"])
        self.max_effects = schema["maxEffectTokens"]
        self.neighbors = {r: set() for r in self.regions}
        for a, b in schema["baseEdges"]:
            self.neighbors[a].add(b)
            self.neighbors[b].add(a)
        for strait in schema["straits"]:
            a, b = strait["seaA"], strait["seaB"]
            self.neighbors[a].add(b)
            self.neighbors[b].add(a)
        self.home_distances = self._home_distances()
        self.effect_dim = (len(EFFECT_KINDS) + len(ACTIONS) + len(self.countries) + len(self.seats)
                           + 23 + len(self.regions) + TARGET_SLOTS * (1 + len(self.countries) + 3) * 2
                           + len(self.binding_keys) * 2 + 2)
        self.state_dim = len(self.encode_state(self._dummy()))
        self.candidate_dim = len(self.encode_candidate(self._dummy(), self._dummy()["candidates"][0]))

    def _home_distances(self):
        out = {}
        homes = [r["id"] for r in self.schema["regions"] if r.get("homeCountry") in self.seats]
        for home in homes:
            distance = {home: 0}
            queue = [home]
            for node in queue:
                for neighbor in self.neighbors[node]:
                    if neighbor not in distance:
                        distance[neighbor] = distance[node] + 1
                        queue.append(neighbor)
            out[home] = distance
        return out

    def _dummy(self):
        return {"round": 1, "phase": "PLAY", "node": "SOURCE", "mode": "A", "cardSet": "events",
                "activeSeat": self.seats[0], "decisionSeat": self.seats[0], "sourceSeat": self.seats[0],
                "unitCountry": None, "scores": {s: 0 for s in self.seats},
                "allianceScores": {"axis": 0, "allies": 0}, "units": [], "suppliedUnitIds": [],
                "reserves": {c: {"army": 0, "navy": 0, "air": 0} for c in self.countries},
                "ownResources": {k: {} for k in ("remaining", "open", "discard")},
                "publicResources": {s: {"remainingTotal": 0, "discardTotal": 0} for s in self.seats},
                "activeEffects": [], "currentEffectIndex": 0, "selectedTargets": [],
                "selectedTargetFacts": [], "bindingFacts": {}, "priorResults": [],
                "choiceKind": None, "choiceField": None,
                "choiceMin": 0, "choiceMax": 0, "canSkip": False,
                "candidates": [{"id": "pass", "kind": "pass", "label": "pass"}]}

    def _region_summary(self, region):
        if region not in self.region_index:
            return [0.0] * 8
        r = self.region_data[region]
        degrees = len(self.neighbors[region])
        distances = [self.home_distances[h].get(region, 20) / 20.0 for h in self.home_distances]
        return [self.region_index[region] / max(1, len(self.regions) - 1),
                float(r["type"] == "SEA"), float(r["supply"]), degrees / 15.0,
                *distances[:4]]

    def _flatten_effects(self, effects):
        flat = []
        def visit(effect, branch=0):
            flat.append((effect, branch))
            for branch_index, children in enumerate(effect.get("children") or []):
                for child in children:
                    visit(child, branch_index + 1)
        for effect in effects:
            visit(effect)
        if len(flat) > self.max_effects:
            raise ValueError(f"Effect sequence exceeds schema cap: {len(flat)} > {self.max_effects}")
        return flat

    def _region_sequence(self, regions):
        if len(regions) > len(self.regions):
            raise ValueError("Region sequence exceeds schema cap")
        result = []
        for region in regions:
            if region not in self.region_index:
                raise ValueError(f"Unknown region {region}")
            result.append((self.region_index[region] + 1) / len(self.regions))
        return result + [0.0] * (len(self.regions) - len(result))

    def _unit_sequence(self, facts):
        if len(facts) > TARGET_SLOTS:
            raise ValueError("Unit target sequence exceeds schema cap")
        result = []
        for fact in facts:
            region = fact["regionId"]
            if region not in self.region_index:
                raise ValueError(f"Unknown target region {region}")
            result.extend([(self.region_index[region] + 1) / len(self.regions)] +
                          onehot(fact["country"], self.countries) +
                          onehot(fact["type"], ["army", "navy", "air"]))
        return result + [0.0] * ((TARGET_SLOTS - len(facts)) * (1 + len(self.countries) + 3))

    def _target_facts(self, effect, obs, field="targetIds", fact_field="targetFacts"):
        ids = effect.get(field) or []
        facts = effect.get(fact_field) or []
        if facts or not ids:
            return facts
        by_id = {unit["id"]: unit for unit in obs["units"]}
        if any(target not in by_id for target in ids):
            if field == "selectedIds":
                return [by_id[target] for target in ids if target in by_id]
            raise ValueError("Target ID lacks visible semantic unit facts")
        return [by_id[target] for target in ids]

    def _effect_token(self, effect, branch, obs):
        regions = effect.get("regions") or []
        first = self._region_summary(regions[0] if regions else None)
        values = (onehot(effect.get("kind"), EFFECT_KINDS) + onehot(effect.get("action"), ACTIONS) +
                  onehot(effect.get("country"), self.countries) + onehot(effect.get("seat"), self.seats) +
                  [float(bool(effect.get("fee"))), float(bool(effect.get("optional"))),
                   min(effect.get("min", 0), 20) / 20.0, min(effect.get("max", 0), 20) / 20.0,
                   min(effect.get("count", 0), 20) / 20.0, max(-20, min(effect.get("amount", 0), 20)) / 20.0,
                   min(len(regions), 20) / 20.0, min(len(effect.get("targetIds") or []), 20) / 20.0,
                   float(bool(effect.get("bindAs"))), float(bool(effect.get("fromBinding"))),
                   float(bool(effect.get("newOnly"))), float(effect.get("from") == "hand"),
                   float(effect.get("to") == "discardPile"), min(branch, 10) / 10.0,
                   float(effect.get("kind") == "signal" and effect.get("tag") == "INSTALL")])
        values += first + self._region_sequence(regions)
        values += self._unit_sequence(self._target_facts(effect, obs))
        values += self._unit_sequence(self._target_facts(effect, obs, "selectedIds", "selectedFacts"))
        values += onehot(effect.get("bindAs"), self.binding_keys)
        values += onehot(effect.get("fromBinding"), self.binding_keys)
        values += [float(bool(effect.get("precommitTargets"))),
                   (self.region_index[effect["selectionRegion"]] + 1) / len(self.regions)
                   if effect.get("selectionRegion") in self.region_index else 0.0]
        assert len(values) == self.effect_dim, (len(values), self.effect_dim)
        return values

    def _effect_vector(self, effects, obs):
        flat = self._flatten_effects(effects)
        output = []
        for effect, branch in flat:
            output.extend(self._effect_token(effect, branch, obs))
        output.extend([0.0] * ((self.max_effects - len(flat)) * self.effect_dim))
        return output

    def encode_state(self, obs):
        region_count, country_count = len(self.regions), len(self.countries)
        units = [0.0] * (region_count * country_count * 3)
        supplied = [0.0] * len(units)
        supplied_ids = set(obs["suppliedUnitIds"])
        control = [0.0] * (region_count * 3)
        for unit in obs["units"]:
            if unit["regionId"] not in self.region_index:
                raise ValueError("Unknown map region")
            region = self.region_index[unit["regionId"]]
            country = self.countries.index(unit["country"])
            type_index = ["army", "navy", "air"].index(unit["type"])
            index = (region * country_count + country) * 3 + type_index
            units[index] += 1.0
            if unit["id"] in supplied_ids:
                supplied[index] += 1.0
            alliance = 1 if unit["country"] in ("germany", "italy", "japan") else 2
            control[region * 3 + alliance] = 1.0
        for region in range(region_count):
            if control[region * 3 + 1] == 0 and control[region * 3 + 2] == 0:
                control[region * 3] = 1.0
        static = []
        for region_id in self.regions:
            r = self.region_data[region_id]
            static.extend([float(r["type"] == "SEA"), float(r["supply"]),
                           len(self.neighbors[region_id]) / 15.0])
            static.extend(onehot(r.get("homeCountry"), self.countries))
            static.extend([self.home_distances[h].get(region_id, 20) / 20.0 for h in self.home_distances])
        own = obs["ownResources"]
        values = ([obs["round"] / 20.0, (20 - obs["round"]) / 20.0, float(obs["mode"] == "B"),
                   float(obs.get("cardSet", "events") == "events"),
                   obs["currentEffectIndex"] / 32.0, min(obs.get("choiceMin", 0), 20) / 20.0,
                   min(obs.get("choiceMax", 0), 20) / 20.0, float(obs.get("canSkip", False))] +
                  onehot(obs["phase"], PHASES) + onehot(obs["node"], ["SOURCE", "TARGETS", "ENGINE_CHOICE"]) +
                  onehot(obs.get("choiceKind"), CHOICE_KINDS) +
                  onehot(obs.get("choiceField"), CHOICE_FIELDS) +
                  onehot(obs["activeSeat"], self.seats) + onehot(obs["decisionSeat"], self.seats) +
                  onehot(obs["sourceSeat"], self.seats) + onehot(obs.get("unitCountry"), self.countries) +
                  [obs["scores"][seat] / 100.0 for seat in self.seats] +
                  [obs["allianceScores"][team] / 300.0 for team in ("axis", "allies")] +
                  [obs["reserves"][country][kind] / 10.0 for country in self.countries for kind in ("army", "navy", "air")] +
                  [own[group].get(card, 0) / 10.0 for group in ("remaining", "open", "discard") for card in self.cards] +
                  [obs["publicResources"][seat][field] / 100.0 for seat in self.seats for field in
                   ("remainingTotal", "discardTotal")])
        values += units + supplied + control + static + self._effect_vector(obs["activeEffects"], obs)
        values += self._unit_sequence(obs.get("selectedTargetFacts") or [])
        for key in self.binding_keys:
            values += self._unit_sequence(obs.get("bindingFacts", {}).get(key) or [])
        prior = obs.get("priorResults") or []
        if len(prior) > 8:
            raise ValueError("Prior result sequence exceeds schema cap")
        for result in prior:
            values += [float(result["applied"]), float(result["cancelled"])]
            values += onehot(result.get("action"), ACTIONS)
            values += [(self.region_index[result["regionId"]] + 1) / len(self.regions)
                       if result.get("regionId") in self.region_index else 0.0]
        values += [0.0] * ((8 - len(prior)) * (3 + len(ACTIONS)))
        if hasattr(self, "state_dim") and len(values) != self.state_dim:
            raise ValueError("Variable state vector dimension")
        return values

    def encode_candidate(self, obs, candidate):
        targets = [0.0] * len(self.regions)
        country_targets = [0.0] * len(self.countries)
        for target in (candidate.get("targetIds") or []) + (candidate.get("choiceIds") or []):
            if target in self.region_index:
                targets[self.region_index[target]] = 1.0
            elif target in self.countries:
                country_targets[self.countries.index(target)] = 1.0
            else:
                unit = next((u for u in obs["units"] if u["id"] == target), None)
                if unit:
                    targets[self.region_index[unit["regionId"]]] = 1.0
                    country_targets[self.countries.index(unit["country"])] = 1.0
        definition = candidate.get("definitionId")
        if definition is None and candidate.get("cardId"):
            definition = candidate["cardId"].split(":")[1]
        if definition is None and candidate.get("choiceIds"):
            parts = candidate["choiceIds"][0].split(":")
            if len(parts) >= 2 and parts[1] in self.cards:
                definition = parts[1]
        ordered = []
        for target in (candidate.get("targetIds") or []) + (candidate.get("choiceIds") or []):
            unit = next((u for u in obs["units"] if u["id"] == target), None)
            if unit:
                ordered.append(unit)
            elif target in self.region_index:
                ordered.append({"regionId": target, "country": None, "type": None})
        ordered_vector = self._unit_sequence(ordered)
        choice_features = candidate.get("choices")
        if candidate["kind"] == "choice" and choice_features is None:
            raise ValueError("Choice candidate lacks structured semantics")
        choice_features = choice_features or []
        if candidate["kind"] == "choice" and len(choice_features) != len(candidate.get("choiceIds") or []):
            raise ValueError("Choice candidate semantic count differs from submitted options")
        if len(choice_features) > CHOICE_SLOTS:
            raise ValueError("Choice sequence exceeds schema cap")
        def known(value, names, field):
            if value is not None and value not in names:
                raise ValueError(f"Unknown choice {field}: {value}")
            return onehot(value, names)
        def unit_feature(fact):
            if not fact:
                return [0.0] * (len(self.regions) + len(self.countries) + 3)
            return (known(fact["regionId"], self.regions, "unit region") +
                    known(fact["country"], self.countries, "unit country") +
                    known(fact["type"], ["army", "navy", "air"], "unit type"))
        def choice_token(item):
            return (known(item["kind"], CHOICE_FEATURE_KINDS, "kind") +
                    known(item.get("action"), ACTIONS, "action") +
                    known(item.get("nextAction"), ACTIONS, "next action") +
                    known(item.get("country"), self.countries, "country") +
                    known(item.get("regionId"), self.regions, "region") +
                    known(item.get("unitType"), ["army", "navy", "air"], "unit type") +
                    unit_feature(item.get("source")) + unit_feature(item.get("target")) +
                    known(item.get("definitionId"), self.cards, "card") +
                    [float(item.get("repeated", False)), float(item.get("intercept", False))])
        choice_width = len(choice_token({"kind": "accept"}))
        choice_vector = [number for item in choice_features for number in choice_token(item)]
        choice_vector += [0.0] * ((CHOICE_SLOTS - len(choice_features)) * choice_width)
        values = (onehot(candidate["kind"], ["source", "pass", "choice", "targets"]) +
                  onehot(definition, self.cards) + targets + country_targets +
                  [len(candidate.get("choiceIds") or []) / 10.0,
                   len(candidate.get("targetIds") or []) / 10.0,
                   float(not candidate.get("choiceIds") and candidate["kind"] == "choice"),
                   float(candidate["kind"] == "pass")])
        values += ordered_vector + choice_vector + self._effect_vector(candidate.get("effects") or [], obs)
        if hasattr(self, "candidate_dim") and len(values) != self.candidate_dim:
            raise ValueError("Variable candidate vector dimension")
        return values

    def encode(self, obs):
        if not obs["candidates"]:
            raise ValueError("No legal candidates")
        state = torch.tensor(self.encode_state(obs), dtype=torch.float32)
        candidates = torch.tensor([self.encode_candidate(obs, c) for c in obs["candidates"]],
                                  dtype=torch.float32)
        return state, candidates


class PpoNetwork(nn.Module):
    def __init__(self, state_dim, candidate_dim):
        super().__init__()
        self.state_net = nn.Sequential(nn.Linear(state_dim, 256), nn.ReLU(), nn.Linear(256, 256), nn.ReLU())
        self.candidate_net = nn.Sequential(nn.Linear(candidate_dim, 128), nn.ReLU())
        self.policy = nn.Sequential(nn.Linear(384, 128), nn.ReLU(), nn.Linear(128, 1))
        self.value = nn.Sequential(nn.Linear(256, 128), nn.ReLU(), nn.Linear(128, 1))
        nn.init.orthogonal_(self.policy[-1].weight, gain=0.01)
        nn.init.zeros_(self.policy[-1].bias)
        nn.init.zeros_(self.value[-1].weight)
        nn.init.zeros_(self.value[-1].bias)

    def forward(self, states, candidates, mask):
        state_hidden = self.state_net(states)
        candidate_hidden = self.candidate_net(candidates)
        repeated = state_hidden[:, None, :].expand(-1, candidates.shape[1], -1)
        logits = self.policy(torch.cat((repeated, candidate_hidden), dim=-1)).squeeze(-1)
        logits = logits.masked_fill(~mask, -1e9)
        return logits, self.value(state_hidden).squeeze(-1)


def batch_tensors(samples, device):
    states = torch.stack([item["state"] for item in samples]).to(device)
    width = max(item["candidates"].shape[0] for item in samples)
    dim = samples[0]["candidates"].shape[1]
    candidates = torch.zeros((len(samples), width, dim), device=device)
    mask = torch.zeros((len(samples), width), dtype=torch.bool, device=device)
    for index, item in enumerate(samples):
        count = item["candidates"].shape[0]
        candidates[index, :count] = item["candidates"].to(device)
        mask[index, :count] = True
    return states, candidates, mask


def potential(axis, allies, team):
    difference = (axis - allies) if team == "axis" else (allies - axis)
    return POTENTIAL_SCALE * max(-1.0, min(1.0, difference / 30.0))


def team_of(seat):
    return "axis" if seat in ("germany", "japan", "italy") else "allies"


def shaped_reward(before, after, team, terminal=False, winner=None):
    old = potential(before["axis"], before["allies"], team)
    new = 0.0 if terminal else potential(after["axis"], after["allies"], team)
    outcome = 0.0
    if terminal and winner:
        outcome = 1.0 if winner == team else -1.0
    return outcome + new - old


def assign_advantages(samples, rewards, elapsed_turns):
    """One value boundary per decision by the same seat; intervening choices count in R."""
    by_seat = defaultdict(list)
    for index, sample in enumerate(samples):
        by_seat[sample["seat"]].append(index)
    for seat, indices in by_seat.items():
        next_advantage = 0.0
        full_return = 0.0
        for position in range(len(indices) - 1, -1, -1):
            start = indices[position]
            stop = indices[position + 1] if position + 1 < len(indices) else len(samples)
            interval_reward = sum(rewards[step][team_of(seat)] for step in range(start, stop))
            delta_t = sum(elapsed_turns[start:stop])
            continuation = 0.0 if stop == len(samples) else samples[stop]["value"]
            beta = LAMBDA_ROUND ** (delta_t / 6.0)
            delta = interval_reward + continuation - samples[start]["value"]
            advantage = delta + (0.0 if stop == len(samples) else beta * next_advantage)
            samples[start]["advantage"] = advantage
            samples[start]["target"] = samples[start]["value"] + advantage
            full_return += interval_reward
            samples[start]["actualReturn"] = full_return
            next_advantage = advantage
    return samples


def select_action(model, state, candidates, device, deterministic=False):
    with torch.no_grad():
        batch = [{"state": state, "candidates": candidates}]
        inputs = batch_tensors(batch, device)
        logits, value = model(*inputs)
        distribution = Categorical(logits=logits[0, :len(candidates)])
        action = logits[0, :len(candidates)].argmax() if deterministic else distribution.sample()
        return int(action), float(distribution.log_prob(action)), float(value[0])


def weighted_baseline(observation, rng):
    weights = []
    for candidate in observation["candidates"]:
        name = candidate.get("definitionId") or ""
        weight = 0.15 if candidate["kind"] == "pass" else 1.0
        if name in ("build_army", "build_navy"):
            weight *= 3.0
        elif name in ("land_battle", "sea_battle"):
            weight *= 2.2
        elif name.startswith("special_"):
            weight *= 1.5
        if candidate["kind"] == "choice" and not candidate.get("choiceIds"):
            weight *= 0.4
        weights.append(weight)
    return rng.choices(range(len(weights)), weights=weights)[0]


def play_episode(client, encoder, model, device, mode, seed, max_decisions, trace="none",
                 baseline_side=None, rng=None, card_set="events"):
    rng = rng or random.Random(seed)
    response = client.request(op="reset", seed=seed, mode=mode, cardSet=card_set, trace=trace)
    observation = response["observation"]
    samples, rewards, elapsed = [], [], []
    choices, sources, submitted, resolved = (defaultdict(int) for _ in range(4))
    openness = []
    while observation is not None and len(samples) < max_decisions:
        seat = observation["decisionSeat"]
        state, candidates = encoder.encode(observation)
        use_baseline = baseline_side == team_of(seat)
        if use_baseline:
            index = weighted_baseline(observation, rng)
            logprob, value = 0.0, 0.0
        else:
            index, logprob, value = select_action(model, state, candidates, device)
        chosen = observation["candidates"][index]
        if chosen["kind"] == "source":
            sources[chosen.get("definitionId") or "unknown"] += 1
        own = observation["ownResources"]
        remaining = sum(own["remaining"].values())
        if remaining:
            openness.append(sum(own["open"].values()) / remaining)
        before = observation["allianceScores"]
        response = client.request(op="step", action={**observation["decision"], "actionId": chosen["id"]})
        outcome = response["result"]
        after = outcome["allianceScores"] if outcome else response["observation"]["allianceScores"]
        is_terminal = bool(outcome and outcome["termination"] == "natural")
        rewards.append({team: shaped_reward(before, after, team, is_terminal, outcome["winner"] if outcome else None)
                        for team in ("axis", "allies")})
        elapsed.append(response["info"]["turnsAdvanced"])
        for definition in response["info"].get("submittedCardDefinitions", []):
            submitted[definition] += 1
        for definition in response["info"].get("resolvedCardDefinitions", []):
            resolved[definition] += 1
        samples.append({"seat": seat, "state": state, "candidates": candidates,
                        "action": index, "logprob": logprob, "value": value,
                        "baseline": use_baseline})
        choices[chosen["kind"]] += 1
        observation = response["observation"]
    if observation is not None:
        outcome = client.request(op="truncate", reason="max_decisions")["result"]
    if outcome["termination"] == "natural":
        assign_advantages(samples, rewards, elapsed)
    final_state = client.request(op="snapshot")["snapshot"]["state"]
    remaining_by_seat = {seat: len(deck["hand"]) for seat, deck in final_state["decks"].items()}
    discarded_by_seat = {seat: len(deck["discardPile"]) for seat, deck in final_state["decks"].items()}
    consumed_events = sum(1 for deck in final_state["decks"].values()
                          for zone in ("discardPile", "active", "removed", "faceDown")
                          for card in deck[zone] if card["definitionId"].startswith("special_"))
    return {"samples": samples, "outcome": outcome, "choices": dict(choices),
            "shaped": {team: sum(r[team] for r in rewards) for team in ("axis", "allies")},
            "decisions": len(samples), "sources": dict(sources),
            "submitted": dict(submitted), "resolved": dict(resolved),
            "consumedEvents": consumed_events,
            "countryTurns": sum(elapsed),
            "meanOpenFraction": sum(openness) / len(openness) if openness else 0.0,
            "remainingBySeat": remaining_by_seat, "discardedBySeat": discarded_by_seat}


def ppo_update(model, optimizer, samples, device, rng, epochs=4, minibatch=256):
    useful = [item for item in samples if not item["baseline"]]
    if not useful:
        raise ValueError("No policy decisions to update")
    advantage = torch.tensor([item["advantage"] for item in useful], dtype=torch.float32, device=device)
    mean, std = advantage.mean(), advantage.std(unbiased=False)
    if float(std) > 1e-8:
        advantage = (advantage - mean) / (std + 1e-8)
    else:
        advantage = advantage - mean
    losses, entropies, clip_fracs, kls, gradients = [], [], [], [], []
    for _ in range(epochs):
        order = list(range(len(useful)))
        rng.shuffle(order)
        for start in range(0, len(order), minibatch):
            indices = order[start:start + minibatch]
            batch = [useful[i] for i in indices]
            logits, values = model(*batch_tensors(batch, device))
            distribution = Categorical(logits=logits)
            actions = torch.tensor([item["action"] for item in batch], device=device)
            old_logprob = torch.tensor([item["logprob"] for item in batch], device=device)
            targets = torch.tensor([item["target"] for item in batch], device=device)
            logprob = distribution.log_prob(actions)
            ratio = (logprob - old_logprob).exp()
            local_advantage = advantage[indices]
            policy_loss = -torch.minimum(ratio * local_advantage,
                                          ratio.clamp(0.8, 1.2) * local_advantage).mean()
            value_loss = (values - targets).square().mean()
            entropy = distribution.entropy().mean()
            loss = policy_loss + 0.5 * value_loss - 0.01 * entropy
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            gradients.append(float(nn.utils.clip_grad_norm_(model.parameters(), 0.5)))
            optimizer.step()
            losses.append(float(loss.detach()))
            entropies.append(float(entropy.detach()))
            clip_fracs.append(float(((ratio.detach() - 1).abs() > 0.2).float().mean()))
            kls.append(float((old_logprob - logprob).detach().mean()))
    return {"loss": sum(losses) / len(losses), "entropy": sum(entropies) / len(entropies),
            "clipFraction": sum(clip_fracs) / len(clip_fracs), "approxKl": sum(kls) / len(kls),
            "gradientNorm": sum(gradients) / len(gradients), "samples": len(useful),
            "advantageMean": float(advantage.mean()),
            "valueErrorBefore": sum((item["value"] - item["target"]) ** 2 for item in useful) / len(useful)}


def checkpoint_payload(model, optimizer, encoder, client, mode, update, decisions, rng, next_seed,
                       card_set="events"):
    return {"format": "quartermaster-ppo-checkpoint-v1", "encoderVersion": ENCODER_VERSION,
            "trainerVersion": TRAINER_VERSION,
            "trainerSourceSha256": TRAINER_SOURCE_HASH,
            "encoderDictionarySha256": ENCODER_DICTIONARY_HASH,
            "observationSchemaVersion": client.schema["observationSchemaVersion"],
            "actionSchemaVersion": client.schema["actionSchemaVersion"],
            "buildFingerprint": client.fingerprint, "eventIds": client.schema["eventIds"],
            "mode": mode, "cardSet": card_set,
            "network": {"stateDim": encoder.state_dim, "candidateDim": encoder.candidate_dim},
            "optimizerConfig": OPTIMIZER_CONFIG,
            "rewardConfig": REWARD_CONFIG,
            "update": update, "completedDecisions": decisions, "nextSeed": next_seed,
            "pythonRandomState": rng.getstate(), "torchRandomState": torch.get_rng_state(),
            "cudaRandomState": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None,
            "modelState": model.state_dict(), "optimizerState": optimizer.state_dict()}


def restore_checkpoint(path, model, optimizer, encoder, client, mode, rng, card_set="events"):
    saved = torch.load(path, map_location="cpu", weights_only=False)
    expected = {"format": "quartermaster-ppo-checkpoint-v1", "encoderVersion": ENCODER_VERSION,
                "trainerVersion": TRAINER_VERSION, "trainerSourceSha256": TRAINER_SOURCE_HASH,
                "encoderDictionarySha256": ENCODER_DICTIONARY_HASH,
                "observationSchemaVersion": client.schema["observationSchemaVersion"],
                "actionSchemaVersion": client.schema["actionSchemaVersion"],
                "buildFingerprint": client.fingerprint, "eventIds": client.schema["eventIds"],
                "mode": mode, "cardSet": card_set,
                "network": {"stateDim": encoder.state_dim,
                            "candidateDim": encoder.candidate_dim},
                "rewardConfig": REWARD_CONFIG, "optimizerConfig": OPTIMIZER_CONFIG}
    if any(saved.get(key) != value for key, value in expected.items()):
        raise ValueError("Checkpoint schema, mode, or rules build differs")
    model.load_state_dict(saved["modelState"])
    optimizer.load_state_dict(saved["optimizerState"])
    rng.setstate(saved["pythonRandomState"])
    torch.set_rng_state(saved["torchRandomState"])
    if saved["cudaRandomState"] is not None and torch.cuda.is_available():
        torch.cuda.set_rng_state_all(saved["cudaRandomState"])
    return saved


def evaluation(client, encoder, model, device, mode, seeds, max_decisions, card_set="events"):
    output = []
    for seed in seeds:
        for baseline in ("axis", "allies"):
            episode = play_episode(client, encoder, model, device, mode, seed,
                                   max_decisions, baseline_side=baseline, rng=random.Random(seed + 19),
                                   card_set=card_set)
            end = episode["outcome"]
            output.append({"seed": seed, "baselineTeam": baseline,
                           "learnerTeam": "allies" if baseline == "axis" else "axis",
                           "winner": end["winner"], "termination": end["termination"],
                           "round": end["round"], "decisions": episode["decisions"],
                           "scoreDifference": end["allianceScores"]["axis"] - end["allianceScores"]["allies"],
                           "eventSourceSelections": sum(count for name, count in episode["sources"].items()
                                                        if name.startswith("special_")),
                           "eventSubmissions": sum(count for name, count in episode["submitted"].items()
                                                   if name.startswith("special_")),
                           "eventResolutions": sum(count for name, count in episode["resolved"].items()
                                                   if name.startswith("special_")),
                           "consumedEvents": episode["consumedEvents"],
                           "remainingBySeat": episode["remainingBySeat"]})
    return output


def process_usage(client):
    if sys.platform != "win32":
        return None
    command = (f"Get-Process -Id {os.getpid()},{client.process.pid} -ErrorAction SilentlyContinue | "
               "Select-Object Id,CPU,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress")
    try:
        result = subprocess.run(["powershell", "-NoProfile", "-Command", command],
                                capture_output=True, text=True, timeout=5, check=True)
        data = json.loads(result.stdout)
        return data if isinstance(data, list) else [data]
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def main():
    parser = argparse.ArgumentParser(description="Headless PPO event curriculum")
    parser.add_argument("--mode", choices=["A", "B"], required=True)
    parser.add_argument("--card-set", choices=["basics", "events"], default="events")
    parser.add_argument("--updates", type=int, default=1)
    parser.add_argument("--batch-decisions", type=int, default=4096)
    parser.add_argument("--max-episode-decisions", type=int, default=3000)
    parser.add_argument("--max-episodes-per-update", type=int, default=50)
    parser.add_argument("--seed", type=int, default=20260929)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--trace", choices=["none", "summary", "full"], default="none")
    parser.add_argument("--log", type=Path, default=None)
    parser.add_argument("--eval-seeds", type=int, default=0)
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--cpu", action="store_true")
    args = parser.parse_args()
    device = torch.device("cpu" if args.cpu or not torch.cuda.is_available() else "cuda")
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    rng = random.Random(args.seed)
    torch.manual_seed(args.seed)
    started = time.perf_counter()
    client = ArenaClient(args.log)
    try:
        encoder = Encoder(client.schema)
        model = PpoNetwork(encoder.state_dim, encoder.candidate_dim).to(device)
        optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
        next_seed = args.seed
        completed_decisions = 0
        start_update = 0
        if args.resume:
            saved = restore_checkpoint(args.checkpoint, model, optimizer, encoder, client,
                                       args.mode, rng, args.card_set)
            next_seed = saved["nextSeed"]
            completed_decisions = saved["completedDecisions"]
            start_update = saved["update"]
        report = {"mode": args.mode, "cardSet": args.card_set,
                  "buildFingerprint": client.fingerprint,
                  "device": str(device), "stateDim": encoder.state_dim,
                  "candidateDim": encoder.candidate_dim,
                  "parameters": sum(p.numel() for p in model.parameters()), "updates": []}
        for update_number in range(start_update + 1, start_update + args.updates + 1):
            batch, episodes = [], []
            began = time.perf_counter()
            usage_start = process_usage(client)
            peak_working = defaultdict(int)
            while len(batch) < args.batch_decisions and len(episodes) < args.max_episodes_per_update:
                episode = play_episode(client, encoder, model, device, args.mode, next_seed,
                                       args.max_episode_decisions, args.trace, rng=rng,
                                       card_set=args.card_set)
                next_seed += 1
                episodes.append({"seed": next_seed - 1, "termination": episode["outcome"]["termination"],
                                 "reason": episode["outcome"].get("reason"),
                                 "winner": episode["outcome"]["winner"],
                                 "round": episode["outcome"]["round"],
                                 "decisions": episode["decisions"],
                                 "choices": episode["choices"], "shaped": episode["shaped"],
                                 "sources": episode["sources"],
                                 "submitted": episode["submitted"],
                                 "resolved": episode["resolved"],
                                 "consumedEvents": episode["consumedEvents"],
                                 "countryTurns": episode["countryTurns"],
                                 "meanOpenFraction": episode["meanOpenFraction"],
                                 "remainingBySeat": episode["remainingBySeat"],
                                 "discardedBySeat": episode["discardedBySeat"],
                                 "allianceScores": episode["outcome"]["allianceScores"]})
                for process in process_usage(client) or []:
                    peak_working[process["Id"]] = max(peak_working[process["Id"]],
                                                      process["WorkingSet64"])
                if episode["outcome"]["termination"] == "natural":
                    batch.extend(episode["samples"])
                print(json.dumps({"update": update_number, "episode": episodes[-1]}, ensure_ascii=False), flush=True)
            if not batch:
                raise RuntimeError("Every episode truncated; PPO update refused")
            truncated = sum(e["termination"] == "truncated" for e in episodes)
            if truncated:
                raise RuntimeError(f"PPO batch contains {truncated} truncated episodes; investigate before update")
            collection_seconds = time.perf_counter() - began
            metrics = ppo_update(model, optimizer, batch, device, rng)
            completed_decisions += len(batch)
            usage_end = process_usage(client)
            args.checkpoint.parent.mkdir(parents=True, exist_ok=True)
            torch.save(checkpoint_payload(model, optimizer, encoder, client, args.mode,
                                          update_number, completed_decisions, rng, next_seed,
                                          args.card_set), args.checkpoint)
            result = {"number": update_number, "episodes": episodes, "completedDecisions": len(batch),
                      "truncatedEpisodes": sum(e["termination"] == "truncated" for e in episodes),
                      "collectionSeconds": collection_seconds,
                      "completedDecisionsPerSecond": len(batch) / collection_seconds,
                      "completedCountryTurns": sum(e["countryTurns"] for e in episodes
                                                   if e["termination"] == "natural"),
                      "discardedTruncatedCountryTurns": sum(e["countryTurns"] for e in episodes
                                                            if e["termination"] == "truncated"),
                      "optimization": metrics,
                      "processUsage": {"before": usage_start, "after": usage_end,
                                       "sampledPeakWorkingSetBytes": dict(peak_working)},
                      "gpuPeakAllocatedBytes": torch.cuda.max_memory_allocated() if device.type == "cuda" else 0}
            report["updates"].append(result)
            print(json.dumps({"updateSummary": result}, ensure_ascii=False), flush=True)
        if args.eval_seeds:
            report["evaluation"] = {
                mode: evaluation(client, encoder, model, device, mode,
                                 range(987650, 987650 + args.eval_seeds),
                                 args.max_episode_decisions, args.card_set)
                for mode in ("A", "B")}
        report["wallSeconds"] = time.perf_counter() - started
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"final": {"checkpoint": str(args.checkpoint),
                                    "wallSeconds": report["wallSeconds"]}}, ensure_ascii=False), flush=True)
    finally:
        client.close()


if __name__ == "__main__":
    main()

