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
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

import torch
import numpy as np
from torch import nn
from torch.distributions import Categorical

try:
    from scripts.ppo_action_semantics import MAX_ACTION_SLOTS, action_facts, opportunity_facts
except ModuleNotFoundError:
    from ppo_action_semantics import MAX_ACTION_SLOTS, action_facts, opportunity_facts


ROOT = Path(__file__).resolve().parents[1]
GAMMA = 1.0
LAMBDA_ROUND = 0.95
POTENTIAL_SCALE = 0.3
ENCODER_VERSION = "ppo-vector-v7-effective-straits"
A2S1_ENCODER_VERSION = "ppo-vector-a2s1-v3-use-scopes"
TRAINER_VERSION = "ppo-trainer-v9-actor-map"
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
UNIT_TYPES = ["army", "navy", "air"]
NODES = ["SOURCE", "TARGETS", "ENGINE_CHOICE"]
CANDIDATE_KINDS = ["source", "pass", "choice", "targets"]
CHOICE_SLOTS = 16
CHOICE_FEATURE_KINDS = ["build_order", "action_region", "defenderId", "attackerId",
                        "empty_defender", "action_plan", "effect_choice", "extra_card",
                        "reallocate", "cards", "force_hand", "pay_cost", "region_target",
                        "country_target", "unit_target", "relocate", "trigger",
                        "order_mandatory_triggers", "accept", "decline", "execute"]
OPTIMIZER_CONFIG = {"lr": 3e-4, "epochs": 4, "minibatch": 256, "clip": 0.2,
                    "entropy": 0.01, "valueCoefficient": 0.5, "gradNorm": 0.5}
REWARD_CONFIG = {"gamma": GAMMA, "lambdaRound": LAMBDA_ROUND, "potential": POTENTIAL_SCALE,
                 "actionWasteVersion": "complete-action-v2", "actionWastePenalty": -0.01}
def reward_config(card_set):
    if card_set == "signals":
        return {**REWARD_CONFIG,
                "actionWasteVersion": "complete-action-and-deferred-target-v2"}
    return REWARD_CONFIG
ENCODER_DICTIONARY = {"effectKinds": EFFECT_KINDS, "actions": ACTIONS, "phases": PHASES,
                      "choiceKinds": CHOICE_KINDS, "choiceFields": CHOICE_FIELDS,
                      "targetSlots": TARGET_SLOTS, "choiceSlots": CHOICE_SLOTS,
                      "choiceFeatureKinds": CHOICE_FEATURE_KINDS}
ENCODER_DICTIONARY_HASH = hashlib.sha256(json.dumps(ENCODER_DICTIONARY, sort_keys=True).encode()).hexdigest()
def encoder_version(card_set):
    return A2S1_ENCODER_VERSION if card_set == "signals" else ENCODER_VERSION

def encoder_dictionary_hash(encoder):
    if not encoder.signals:
        return ENCODER_DICTIONARY_HASH
    return hashlib.sha256(json.dumps({"base": ENCODER_DICTIONARY,
        "cards": encoder.cards, "nodes": encoder.nodes,
        "maxActionSlots": encoder.max_action_slots,
        "schema": encoder.schema["observationSchemaVersion"]}, sort_keys=True).encode()).hexdigest()
TRAINER_SOURCE_HASH = hashlib.sha256(Path(__file__).read_bytes() +
    Path(__file__).with_name("ppo_action_semantics.py").read_bytes() +
    (Path(__file__).with_name("ppo_network_factory.py").read_bytes()
     if Path(__file__).with_name("ppo_network_factory.py").exists() else b"") +
    (Path(__file__).with_name("ppo_map_network.py").read_bytes()
     if Path(__file__).with_name("ppo_map_network.py").exists() else b"") +
    (Path(__file__).with_name("ppo_opening_adapter.py").read_bytes()
     if Path(__file__).with_name("ppo_opening_adapter.py").exists() else b"") +
    (Path(__file__).with_name("ppo_auxiliary.py").read_bytes()
     if Path(__file__).with_name("ppo_auxiliary.py").exists() else b"") +
    (Path(__file__).with_name("ppo_parallel.py").read_bytes()
     if Path(__file__).with_name("ppo_parallel.py").exists() else b"") +
    (Path(__file__).with_name("ppo_trajectory.py").read_bytes()
     if Path(__file__).with_name("ppo_trajectory.py").exists() else b"") +
    Path(__file__).with_name("ppo-arena-server.mjs").read_bytes()).hexdigest()
# These exact predecessors use the same observations, actions, rewards, policy
# update and arena rules. Later changes affect progress/review presentation,
# default worker count, or temporary trajectory storage only. All other
# schema, rule-build, course, optimizer and seed checks remain strict.
NON_SEMANTIC_PREDECESSOR_HASHES = frozenset({
    # Historical S2MAP round 2: only experiment routing and the optional
    # A1S2 adapter/auxiliary path have changed; its own semantics are intact.
    "a343ff64ae233ce94afcbc2b935307b8d6463edb3061f26f945757a0e98164af",
    # S2MAP updates through #13 used the same 256-sample objective; the
    # subsequent change only accumulates that objective in smaller GPU pieces.
    "92162067e83a5569c38a1c540af3115de0057b5c57710a034af2916cef7f44f7",
    "3f0ff2c6491001bf3c3bd144712b2d055c2d15f750a6bf9229e5e68f5b350e0e",
    "02c6b3eb1c4a692fccbf9d7c1852b038b3ae14498a825ae8b064f46e94e129fb",
    "2b9778411434db42f2679a7c1e6a018d8b35d98a7789829c952f06309bcd7704",
    "f77b4daddb66dbdf12f462fde55d9698911ec4d9d11d2542a5b057d7cf2f96f9",
    "31ad0efe38df4bceded8b45721c73153dcfc923b3895184d5c7b7ee2d7d8b7f8",
})


_ONEHOT_CACHE = {}


def onehot(value, names):
    key = id(names)
    cached = _ONEHOT_CACHE.get(key)
    if cached is None or cached[0] is not names:
        cached = (names, {name: index for index, name in enumerate(names)},
                  {None: [0.0] * len(names)})
        _ONEHOT_CACHE[key] = cached
    vector = cached[2].get(value)
    if vector is None:
        vector = [0.0] * len(names)
        index = cached[1].get(value)
        if index is not None:
            vector[index] = 1.0
        cached[2][value] = vector
    return vector


class ArenaClient:
    def __init__(self, log_path=None, bundle_path=None, entry_path=None,
                 log_snapshots=False, card_set="events"):
        command = ["node", "scripts/ppo-arena-server.mjs"]
        command += ["--card-set", card_set]
        if log_path:
            command += ["--log", str(log_path)]
        if log_snapshots:
            if not log_path:
                raise ValueError("Snapshot logging needs a log path")
            command += ["--log-snapshots"]
        if bundle_path:
            command += ["--bundle", str(bundle_path)]
        if entry_path:
            command += ["--entry", str(entry_path)]
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
        self.transport = {"serializeSeconds": 0.0, "waitSeconds": 0.0,
                          "parseSeconds": 0.0, "serverOperationSeconds": 0.0,
                          "sentBytes": 0, "receivedBytes": 0}

    def request(self, **message):
        started = time.perf_counter()
        payload = json.dumps(message, ensure_ascii=False) + "\n"
        self.transport["serializeSeconds"] += time.perf_counter() - started
        self.transport["sentBytes"] += len(payload.encode("utf-8"))
        started = time.perf_counter()
        self.process.stdin.write(payload)
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        self.transport["waitSeconds"] += time.perf_counter() - started
        if not line:
            raise RuntimeError(f"Arena server closed: {self.process.stderr.read()}")
        self.transport["receivedBytes"] += len(line.encode("utf-8"))
        started = time.perf_counter()
        response = json.loads(line)
        self.transport["parseSeconds"] += time.perf_counter() - started
        if not response.get("ok"):
            raise RuntimeError(f"Arena error: {response.get('error')}")
        self.transport["serverOperationSeconds"] += response.get("operationSeconds", 0.0)
        if "tag" in message and response.get("tag") != message["tag"]:
            raise RuntimeError("Arena response tag differs from request")
        return response

    def close(self):
        if self.process.poll() is None:
            try:
                self.request(op="close")
            except (RuntimeError, BrokenPipeError):
                pass
            self.process.wait(timeout=10)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream and not stream.closed:
                stream.close()


class Encoder:
    def __init__(self, schema):
        self.schema = schema
        self.regions = [r["id"] for r in schema["regions"]]
        self.region_index = {name: i for i, name in enumerate(self.regions)}
        self.region_data = {r["id"]: r for r in schema["regions"]}
        self.countries = list(schema["countries"])
        self.seats = list(schema["seats"])
        self.cards = list(schema["basicActions"]) + list(schema["eventIds"])
        self.signals = schema["courseVersion"] == "ppo-signals-a2s1-v2"
        self.nodes = NODES + (["AIR_RELOCATE"] if self.signals else [])
        self.max_action_slots = schema.get("maxActionSlots", MAX_ACTION_SLOTS)
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
        self.static_map_features = []
        for region_id in self.regions:
            region = self.region_data[region_id]
            self.static_map_features.extend([float(region["type"] == "SEA"),
                float(region["supply"]), len(self.neighbors[region_id]) / 15.0])
            self.static_map_features.extend(onehot(region.get("homeCountry"), self.countries))
            self.static_map_features.extend([self.home_distances[home].get(region_id, 20) / 20.0
                                             for home in self.home_distances])
        self.effect_dim = (len(EFFECT_KINDS) + len(ACTIONS) + len(self.countries) + len(self.seats)
                           + 23 + len(self.regions) + TARGET_SLOTS * (1 + len(self.countries) + 3) * 2
                           + len(self.binding_keys) * 2 + 2)
        self.empty_effect_vector = [0.0] * (self.max_effects * self.effect_dim)
        self.empty_unit_sequence = [0.0] * (TARGET_SLOTS * (1 + len(self.countries) + 3))
        self.empty_region_sequence = [0.0] * len(self.regions)
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
        return {"round": 1, "phase": "PLAY", "node": "SOURCE", "mode": "A",
                "cardSet": "signals" if self.signals else "events",
                "activeSeat": self.seats[0], "decisionSeat": self.seats[0], "sourceSeat": self.seats[0],
                "unitCountry": None, "scores": {s: 0 for s in self.seats},
                "allianceScores": {"axis": 0, "allies": 0}, "units": [], "suppliedUnitIds": [],
                "effectiveStraits": {c: [False] * len(self.schema["straits"])
                                     for c in self.countries},
                "reserves": {c: {"army": 0, "navy": 0, "air": 0} for c in self.countries},
                "ownResources": {k: {} for k in ("remaining", "open", "discard")},
                "publicResources": {s: {"remainingTotal": 0, "discardTotal": 0} for s in self.seats},
                "visibleCards": {"active": {s: [] for s in self.seats}, "ownFaceDown": [],
                                 "otherFaceDownCount": {s: 0 for s in self.seats}},
                "effectiveHomes": {c: self.regions[0] for c in self.countries},
                "effectiveSupply": {c: [False] * len(self.regions) for c in self.countries},
                "visibleUseCounts": {}, "visibleRoundUseCounts": {},
                "currentSourceDefinition": None,
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
        if not regions:
            return self.empty_region_sequence
        if len(regions) > len(self.regions):
            raise ValueError("Region sequence exceeds schema cap")
        result = []
        for region in regions:
            if region not in self.region_index:
                raise ValueError(f"Unknown region {region}")
            result.append((self.region_index[region] + 1) / len(self.regions))
        return result + [0.0] * (len(self.regions) - len(result))

    def _unit_sequence(self, facts):
        if not facts:
            return self.empty_unit_sequence
        if len(facts) > TARGET_SLOTS:
            raise ValueError("Unit target sequence exceeds schema cap")
        result = []
        for fact in facts:
            region = fact["regionId"]
            if region not in self.region_index:
                raise ValueError(f"Unknown target region {region}")
            result.extend([(self.region_index[region] + 1) / len(self.regions)] +
                          onehot(fact["country"], self.countries) +
                          onehot(fact["type"], UNIT_TYPES))
        return result + [0.0] * ((TARGET_SLOTS - len(facts)) * (1 + len(self.countries) + 3))

    def _target_facts(self, effect, obs, field="targetIds", fact_field="targetFacts"):
        ids = effect.get(field) or []
        facts = effect.get(fact_field) or []
        if facts or not ids:
            return facts
        by_id = getattr(self, "_encoding_context", {}).get("unitsById")
        if by_id is None:
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
        if not effects:
            return self.empty_effect_vector
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
        static = self.static_map_features
        own = obs["ownResources"]
        values = ([obs["round"] / 20.0, (20 - obs["round"]) / 20.0, float(obs["mode"] == "B"),
                   float(obs.get("cardSet", "events") in ("events", "signals")),
                   obs["currentEffectIndex"] / 32.0, min(obs.get("choiceMin", 0), 20) / 20.0,
                   min(obs.get("choiceMax", 0), 20) / 20.0, float(obs.get("canSkip", False))] +
                  onehot(obs["phase"], PHASES) + onehot(obs["node"], self.nodes) +
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
        if not hasattr(self, "map_slices"):
            start = len(values)
            self.map_slices = ((start, start + len(units)),
                (start + len(units), start + len(units) + len(supplied)),
                (start + len(units) + len(supplied),
                 start + len(units) + len(supplied) + len(control)),
                (start + len(units) + len(supplied) + len(control),
                 start + len(units) + len(supplied) + len(control) + len(static)))
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
        if not hasattr(self, "effective_straits_start"):
            self.effective_straits_start = len(values)
        links = obs.get("effectiveStraits")
        if links is None or set(links) != set(self.countries):
            raise ValueError("Observation lacks engine-derived effective strait facts")
        for country in self.countries:
            flags = links[country]
            if len(flags) != len(self.schema["straits"]):
                raise ValueError("Effective strait count differs from schema")
            values.extend(float(flag) for flag in flags)
        if self.signals:
            visible = obs.get("visibleCards")
            homes = obs.get("effectiveHomes")
            supply = obs.get("effectiveSupply")
            if not visible or not homes or not supply:
                raise ValueError("A2S1 observation lacks card or dynamic map facts")
            for seat in self.seats:
                active = visible["active"][seat]
                counts = Counter(active)
                values.extend(min(counts[card], 4) / 4 for card in self.cards)
            face_down_counts = Counter(visible["ownFaceDown"])
            values.extend(min(face_down_counts[card], 4) / 4
                          for card in self.cards)
            values.extend(min(visible["otherFaceDownCount"][seat], 10) / 10
                          for seat in self.seats)
            for country in self.countries:
                values += onehot(homes[country], self.regions)
                flags = supply[country]
                if len(flags) != len(self.regions):
                    raise ValueError("Effective supply fact count differs")
                values.extend(float(flag) for flag in flags)
            origin = obs.get("originAction") or {}
            values += onehot(origin.get("action"), ACTIONS)
            values += onehot(origin.get("country"), self.countries)
            values += onehot(origin.get("regionId"), self.regions)
            values += onehot(origin.get("sourceRegionId"), self.regions)
            values += onehot(obs.get("currentSourceDefinition"), self.cards)
            values.extend(min((obs.get("visibleUseCounts") or {}).get(card, 0), 3) / 3
                          for card in self.cards)
            round_uses = obs.get("visibleRoundUseCounts")
            if round_uses is None:
                raise ValueError("A2S1 observation lacks current-round use facts")
            values.extend(min(round_uses.get(card, 0), 3) / 3 for card in self.cards)
        if hasattr(self, "state_dim") and len(values) != self.state_dim:
            raise ValueError("Variable state vector dimension")
        return values

    def encode_candidate(self, obs, candidate):
        by_id = getattr(self, "_encoding_context", {}).get("unitsById")
        if by_id is None:
            by_id = {unit["id"]: unit for unit in obs["units"]}
        targets = [0.0] * len(self.regions)
        country_targets = [0.0] * len(self.countries)
        for target in (candidate.get("targetIds") or []) + (candidate.get("choiceIds") or []):
            if target in self.region_index:
                targets[self.region_index[target]] = 1.0
            elif target in self.countries:
                country_targets[self.countries.index(target)] = 1.0
            else:
                unit = by_id.get(target)
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
            unit = by_id.get(target)
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
                    known(fact["type"], UNIT_TYPES, "unit type"))
        def choice_token(item):
            return (known(item["kind"], CHOICE_FEATURE_KINDS, "kind") +
                    known(item.get("action"), ACTIONS, "action") +
                    known(item.get("nextAction"), ACTIONS, "next action") +
                    known(item.get("country"), self.countries, "country") +
                    known(item.get("regionId"), self.regions, "region") +
                    known(item.get("unitType"), UNIT_TYPES, "unit type") +
                    unit_feature(item.get("source")) + unit_feature(item.get("target")) +
                    known(item.get("definitionId"), self.cards, "card") +
                    [float(item.get("repeated", False)), float(item.get("intercept", False))])
        choice_width = len(choice_token({"kind": "accept"}))
        choice_vector = [number for item in choice_features for number in choice_token(item)]
        choice_vector += [0.0] * ((CHOICE_SLOTS - len(choice_features)) * choice_width)
        values = (onehot(candidate["kind"], CANDIDATE_KINDS) +
                  onehot(definition, self.cards) + targets + country_targets +
                  [len(candidate.get("choiceIds") or []) / 10.0,
                   len(candidate.get("targetIds") or []) / 10.0,
                   float(not candidate.get("choiceIds") and candidate["kind"] == "choice"),
                   float(candidate["kind"] == "pass")])
        values += ordered_vector + choice_vector + self._effect_vector(candidate.get("effects") or [], obs)
        if not hasattr(self, "candidate_semantic_start"):
            self.candidate_semantic_start = len(values)
        values += self._action_semantics(obs, candidate)
        if self.signals:
            card_type = candidate.get("cardType")
            if card_type is None and definition:
                card_type = self.schema["cardTypes"].get(definition)
            if card_type not in (None, "基本牌", "事件", "状态", "响应"):
                raise ValueError(f"Unknown A2S1 card type: {card_type}")
            values += onehot(card_type, ["基本牌", "事件", "状态", "响应"])
        if hasattr(self, "candidate_dim") and len(values) != self.candidate_dim:
            raise ValueError("Variable candidate vector dimension")
        return values

    def _action_semantics(self, obs, candidate):
        outcomes = ("unknown", "new", "repeated", "blocked", "target", "empty")
        facts = action_facts(obs, candidate, self.schema["regions"], self.max_action_slots,
                             getattr(self, "_encoding_context", None))
        def token(item):
            return (onehot(item["action"], ACTIONS) +
                    onehot(item["country"], self.countries) +
                    onehot(item["regionId"], self.regions) +
                    onehot(item["unitType"], UNIT_TYPES) +
                    onehot(item["outcome"], outcomes) +
                    onehot(item["homeCountry"], self.countries) +
                    [float(item["chosenLegal"]), float(item["recycled"]),
                     min(item["same"], 3) / 3, min(item["allied"], 3) / 3,
                     min(item["enemy"], 3) / 3, min(item["suppliedHere"], 3) / 3,
                     float(item["supplyPoint"] is True), float(item["supplyPoint"] is None),
                     float(item["futureTarget"])])
        empty = token({"action": None, "country": None, "regionId": None,
                       "unitType": None, "outcome": None, "homeCountry": None,
                       "chosenLegal": False, "recycled": False, "same": 0,
                       "allied": 0, "enemy": 0, "suppliedHere": 0,
                       "supplyPoint": None, "futureTarget": False})
        result = [value for item in facts for value in token(item)]
        result.extend([0.0] * ((self.max_action_slots - len(facts)) * len(empty)))
        opportunity = opportunity_facts(candidate)
        result.extend([min(opportunity["extraPlayEffects"], 3) / 3,
                       float(opportunity["replacesSpentPlay"]),
                       float(opportunity["trueExtraPlayKnown"]),
                       float(any(e.get("fee") for e in candidate.get("effects") or [])),
                       float(any(e.get("kind") == "choose" for e in candidate.get("effects") or [])),
                       min(len(obs.get("priorResults") or []), 8) / 8])
        return result

    def encode(self, obs):
        if not obs["candidates"]:
            raise ValueError("No legal candidates")
        by_region = {}
        for unit in obs["units"]:
            by_region.setdefault(unit["regionId"], []).append(unit)
        self._encoding_context = {"unitsById": {u["id"]: u for u in obs["units"]},
                                  "unitsByRegion": by_region,
                                  "regions": self.region_data,
                                  "supplied": set(obs["suppliedUnitIds"])}
        try:
            state = torch.from_numpy(np.asarray(self.encode_state(obs), dtype=np.float32))
            array = np.empty((len(obs["candidates"]), self.candidate_dim), dtype=np.float32)
            for index, candidate in enumerate(obs["candidates"]):
                array[index] = self.encode_candidate(obs, candidate)
            return state, torch.from_numpy(array)
        finally:
            del self._encoding_context

    def encode_reference(self, obs):
        """Pre-optimization path retained for exact observation regression tests."""
        if not obs["candidates"]:
            raise ValueError("No legal candidates")
        return (torch.tensor(self.encode_state(obs), dtype=torch.float32),
                torch.tensor([self.encode_candidate(obs, candidate)
                              for candidate in obs["candidates"]], dtype=torch.float32))


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


def model_weights_sha256(model):
    digest = hashlib.sha256()
    for name, tensor in sorted(model.state_dict().items()):
        raw = tensor.detach().cpu().contiguous().numpy().tobytes()
        digest.update(name.encode("utf-8"))
        digest.update(len(raw).to_bytes(8, "little"))
        digest.update(raw)
    return digest.hexdigest()


def experiment_config_sha256(experiment_id, mode, entropy_coefficient, initial_hash,
                             training_seed, build_fingerprint, card_set="events", architecture=None,
                             auxiliary_config=None):
    if experiment_id is None:
        return None
    config = {"experimentId": experiment_id, "resourceMode": mode,
              "entropyCoefficient": entropy_coefficient,
              "initialWeightsSha256": initial_hash, "trainingSeed": training_seed,
              "buildFingerprint": build_fingerprint, "cardSet": card_set,
              "encoderVersion": encoder_version(card_set), "rewardConfig": reward_config(card_set),
              "optimizerConfig": {**OPTIMIZER_CONFIG, "entropy": entropy_coefficient}}
    if architecture is not None:
        config["networkArchitecture"] = architecture
    if auxiliary_config is not None:
        config["auxiliaryConfig"] = auxiliary_config
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()


def batch_tensors(samples, device):
    states = torch.stack([item["state"] for item in samples]).to(device=device, dtype=torch.float32)
    width = max(item["candidates"].shape[0] for item in samples)
    dim = samples[0]["candidates"].shape[1]
    candidates = torch.zeros((len(samples), width, dim), device=device)
    mask = torch.zeros((len(samples), width), dtype=torch.bool, device=device)
    for index, item in enumerate(samples):
        count = item["candidates"].shape[0]
        candidates[index, :count] = item["candidates"].to(device=device, dtype=torch.float32)
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


def decision_rewards(previous, after, outcome, info):
    """One training reward entry for the initiating decision, shared by both collectors."""
    natural = bool(outcome and outcome["termination"] == "natural")
    base = {team: shaped_reward(previous["allianceScores"], after, team, natural,
                                outcome["winner"] if outcome else None)
            for team in ("axis", "allies")}
    adjusted = dict(base)
    waste = info.get("wasteCheck")
    if waste and waste["penalty"]:
        if (waste["seat"] != previous["decisionSeat"] or not waste["repeated"] or
                waste["reason"] != "repeated_basic_build"):
            raise RuntimeError("Waste penalty does not belong to the initiating decision")
        adjusted[team_of(waste["seat"])] += REWARD_CONFIG["actionWastePenalty"]
    return base, adjusted


def apply_reward_adjustments(rewards, samples, info):
    """Attach delayed training-only waste to its original PPO decision.

    Called after appending the current step. No opponent bonus is created, and
    the game score in the arena is untouched.
    """
    applied = []
    for item in info.get("rewardAdjustments") or ():
        index = item["decisionId"]
        if not isinstance(index, int) or index < 0 or index >= len(rewards) or \
                samples[index]["seat"] != item["seat"]:
            raise RuntimeError("Delayed waste does not belong to its originating decision")
        penalty = item["penalty"]
        if penalty != REWARD_CONFIG["actionWastePenalty"] or \
                item.get("afterCap") != penalty:
            raise RuntimeError("Unexpected action waste reward or cap")
        rewards[index][team_of(item["seat"])] += penalty
        applied.append(item)
    return applied


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


def select_action(model, state, candidates, device, deterministic=False, rng=None):
    with torch.no_grad():
        batch = [{"state": state, "candidates": candidates}]
        inputs = batch_tensors(batch, device)
        logits, value = model(*inputs)
        distribution = Categorical(logits=logits[0, :len(candidates)])
        if deterministic:
            action = logits[0, :len(candidates)].argmax()
        elif rng is not None:
            probs = distribution.probs.cpu().tolist()
            draw, total = rng.random(), 0.0
            chosen = len(probs) - 1
            for index, probability in enumerate(probs):
                total += probability
                if draw < total:
                    chosen = index
                    break
            action = torch.tensor(chosen, device=device)
        else:
            action = distribution.sample()
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
                 baseline_side=None, rng=None, card_set="events", record_metadata=None,
                 deterministic=False, reference_model=None, reference_team=None):
    rng = rng or random.Random(seed)
    response = client.request(op="reset", seed=seed, mode=mode, cardSet=card_set,
                              trace=trace, recordMetadata=record_metadata)
    observation = response["observation"]
    samples, rewards, elapsed = [], [], []
    base_totals = {"axis": 0.0, "allies": 0.0}
    waste_penalties = defaultdict(int)
    waste_reasons = defaultdict(int)
    repeated_builds = 0
    choices, sources, submitted, resolved = (defaultdict(int) for _ in range(4))
    openness = []
    first_german_source = True
    white_opening = False
    white_recruit = False
    white_followed_arden = False
    white_pending = False
    passes = 0
    while observation is not None and len(samples) < max_decisions:
        seat = observation["decisionSeat"]
        state, candidates = encoder.encode(observation)
        use_baseline = baseline_side == team_of(seat)
        use_reference = reference_model is not None and reference_team == team_of(seat)
        if use_baseline:
            index = weighted_baseline(observation, rng)
            logprob, value = 0.0, 0.0
        else:
            index, logprob, value = select_action(reference_model if use_reference else model,
                                                  state, candidates, device,
                                                  deterministic=deterministic, rng=rng)
        chosen = observation["candidates"][index]
        if first_german_source and observation["node"] == "SOURCE" and observation["activeSeat"] == "germany":
            first_german_source = False
            white_opening = chosen.get("definitionId") == "special_150"
            white_pending = white_opening
        if white_pending and observation.get("choiceKind") == "EXTRA_CARD" and \
                "germany:special_158" in (chosen.get("choiceIds") or ()):
            white_followed_arden = True
        if chosen["kind"] == "pass":
            passes += 1
        if chosen["kind"] == "source":
            sources[chosen.get("definitionId") or "unknown"] += 1
        own = observation["ownResources"]
        remaining = sum(own["remaining"].values())
        if remaining:
            openness.append(sum(own["open"].values()) / remaining)
        previous = observation
        response = client.request(op="step", action={**observation["decision"], "actionId": chosen["id"]})
        if white_opening and not white_recruit:
            current = response["observation"] or response["result"].get("finalObservation", {})
            white_recruit = any(u["country"] == "germany" and u["type"] == "army" and
                                u["regionId"] == "eastern_europe" for u in current.get("units", ()))
        if "special_150" in response["info"].get("resolvedCardDefinitions", ()):
            white_pending = False
        outcome = response["result"]
        after = outcome["allianceScores"] if outcome else response["observation"]["allianceScores"]
        base, training_reward = decision_rewards(previous, after, outcome, response["info"])
        for team in base_totals:
            base_totals[team] += base[team]
        waste = response["info"].get("wasteCheck")
        if waste and waste.get("repeated"):
            repeated_builds += 1
        if waste and waste["penalty"]:
            waste_penalties[waste["seat"]] += 1
            waste_reasons[waste["reason"]] += 1
        rewards.append(training_reward)
        elapsed.append(response["info"]["turnsAdvanced"])
        for definition in response["info"].get("submittedCardDefinitions", []):
            submitted[definition] += 1
        for definition in response["info"].get("resolvedCardDefinitions", []):
            resolved[definition] += 1
        samples.append({"seat": seat, "state": state, "candidates": candidates,
                        "action": index, "logprob": logprob, "value": value,
                        "baseline": use_baseline or use_reference})
        for adjustment in apply_reward_adjustments(rewards, samples, response["info"]):
            waste_penalties[adjustment["seat"]] += 1
            waste_reasons[adjustment["reason"]] += 1
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
            "shaped": base_totals,
            "trainingReward": {team: sum(r[team] for r in rewards) for team in ("axis", "allies")},
            "wastePenaltiesBySeat": dict(waste_penalties),
            "wastePenaltyTotal": REWARD_CONFIG["actionWastePenalty"] * sum(waste_penalties.values()),
            "wasteReasons": dict(waste_reasons), "repeatedBasicBuilds": repeated_builds,
            "decisions": len(samples), "sources": dict(sources),
            "submitted": dict(submitted), "resolved": dict(resolved),
            "consumedEvents": consumed_events,
            "openingWhitePlan": white_opening, "whiteRecruit": white_recruit,
            "whiteFollowedArden": white_followed_arden, "passes": passes,
            "countryTurns": sum(elapsed),
            "meanOpenFraction": sum(openness) / len(openness) if openness else 0.0,
            "remainingBySeat": remaining_by_seat, "discardedBySeat": discarded_by_seat}


def _is_cuda_oom(error, device):
    return (device.type == "cuda" and
            isinstance(error, (torch.cuda.OutOfMemoryError, torch.AcceleratorError)) and
            "out of memory" in str(error).lower())


def ppo_update(model, optimizer, samples, device, rng, epochs=4, minibatch=256,
               entropy_coefficient=None, gradient_microbatch=None,
               sampling="global-shuffle-v1"):
    entropy_coefficient = (OPTIMIZER_CONFIG["entropy"] if entropy_coefficient is None
                           else entropy_coefficient)
    if not math.isfinite(entropy_coefficient) or entropy_coefficient < 0:
        raise ValueError("Invalid entropy coefficient")
    if gradient_microbatch is None:
        gradient_microbatch = minibatch
    if gradient_microbatch < 1 or gradient_microbatch > minibatch:
        raise ValueError("Invalid gradient microbatch size")
    # A trajectory spool exposes only small scalar metadata here. Tensor payloads
    # are read for the current shuffled minibatch, never for the full update.
    metadata = samples.training_metadata() if hasattr(samples, "training_metadata") else samples
    useful_positions = [i for i, item in enumerate(metadata) if not item["baseline"]]
    useful = [metadata[i] for i in useful_positions]
    metadata_index = {position: index for index, position in enumerate(useful_positions)}
    if not useful:
        raise ValueError("No policy decisions to update")
    advantage = torch.tensor([item["advantage"] for item in useful], dtype=torch.float32, device=device)
    mean, std = advantage.mean(), advantage.std(unbiased=False)
    if float(std) > 1e-8:
        advantage = (advantage - mean) / (std + 1e-8)
    else:
        advantage = advantage - mean
    losses, entropies, clip_fracs, kls, gradients = [], [], [], [], []
    oom_fallbacks = []
    for epoch in range(epochs):
        if sampling == "chunk-shuffle-epoch-v1":
            if not hasattr(samples, "epoch_batches"):
                raise ValueError("Chunk sampler requires a trajectory store")
            # Only integer sample indices are held here, never decoded payloads.
            batches = list(samples.epoch_batches(useful_positions, rng, minibatch))
        elif sampling == "global-shuffle-v1":
            order = list(useful_positions)
            rng.shuffle(order)
            batches = (order[start:start + minibatch]
                       for start in range(0, len(order), minibatch))
        else:
            raise ValueError(f"Unknown PPO sampling configuration: {sampling}")
        for batch_number, positions in enumerate(batches):
            indices = [metadata_index[position] for position in positions]
            batch = (samples.load_batch(positions)
                     if hasattr(samples, "load_batch") else [useful[i] for i in indices])
            if sampling == "chunk-shuffle-epoch-v1" and batch_number + 1 < len(batches):
                samples.prefetch(batches[batch_number + 1])
            microbatch = gradient_microbatch
            while True:
                optimizer.zero_grad(set_to_none=True)
                # Every retry starts the same logical batch from its first sample.
                # The actual piece size preserves the 256-sample mean objective.
                batch_loss = batch_entropy = batch_clip = batch_kl = 0.0
                try:
                    for offset in range(0, len(batch), microbatch):
                        piece = batch[offset:offset + microbatch]
                        logits, values = model(*batch_tensors(piece, device))
                        distribution = Categorical(logits=logits)
                        actions = torch.tensor([item["action"] for item in piece], device=device)
                        old_logprob = torch.tensor([item["logprob"] for item in piece], device=device)
                        targets = torch.tensor([item["target"] for item in piece], device=device)
                        logprob = distribution.log_prob(actions)
                        ratio = (logprob - old_logprob).exp()
                        local_advantage = advantage[indices[offset:offset + len(piece)]]
                        policy_loss = -torch.minimum(ratio * local_advantage,
                                                      ratio.clamp(0.8, 1.2) * local_advantage).mean()
                        value_loss = (values - targets).square().mean()
                        entropy = distribution.entropy().mean()
                        loss = (policy_loss + OPTIMIZER_CONFIG["valueCoefficient"] * value_loss -
                                entropy_coefficient * entropy)
                        weight = len(piece) / len(batch)
                        (loss * weight).backward()
                        batch_loss += float(loss.detach()) * weight
                        batch_entropy += float(entropy.detach()) * weight
                        batch_clip += float(((ratio.detach() - 1).abs() > 0.2).float().mean()) * weight
                        batch_kl += float((old_logprob - logprob).detach().mean()) * weight
                        del logits, values, distribution, actions, old_logprob, targets
                        del logprob, ratio, local_advantage, policy_loss, value_loss, entropy, loss
                    break
                except (torch.cuda.OutOfMemoryError, torch.AcceleratorError) as exc:
                    if not _is_cuda_oom(exc, device) or microbatch <= 16:
                        raise
                    optimizer.zero_grad(set_to_none=True)
                    next_size = 32 if microbatch > 32 else 16
                    oom_fallbacks.append({"epoch": epoch + 1, "batchSize": len(batch),
                                          "maxCandidates": max(item["candidates"].shape[0] for item in batch),
                                          "from": microbatch, "to": next_size})
                    microbatch = next_size
                if microbatch != gradient_microbatch and device.type == "cuda":
                    torch.cuda.empty_cache()
            gradients.append(float(nn.utils.clip_grad_norm_(model.parameters(), 0.5)))
            optimizer.step()
            losses.append(batch_loss)
            entropies.append(batch_entropy)
            clip_fracs.append(batch_clip)
            kls.append(batch_kl)
    return {"loss": sum(losses) / len(losses), "entropy": sum(entropies) / len(entropies),
            "entropyCoefficient": entropy_coefficient,
            "clipFraction": sum(clip_fracs) / len(clip_fracs), "approxKl": sum(kls) / len(kls),
            "gradientNorm": sum(gradients) / len(gradients), "samples": len(useful),
            "sampling": sampling,
            "oomFallbacks": oom_fallbacks,
            "advantageMean": float(advantage.mean()),
            "valueErrorBefore": sum((item["value"] - item["target"]) ** 2 for item in useful) / len(useful)}


def checkpoint_payload(model, optimizer, encoder, client, mode, update, decisions, rng, next_seed,
                       card_set="events", completed_episodes=0, training_seed=None,
                       experiment_id=None, entropy_coefficient=None, initial_weights_sha256=None,
                       architecture=None, auxiliary_config=None, sampling_config=None):
    payload = {"format": "quartermaster-ppo-checkpoint-v1", "encoderVersion": encoder_version(card_set),
            "networkArchitecture": architecture,
            "trainerVersion": TRAINER_VERSION,
            "trainerSourceSha256": TRAINER_SOURCE_HASH,
            "encoderDictionarySha256": encoder_dictionary_hash(encoder),
            "observationSchemaVersion": client.schema["observationSchemaVersion"],
            "actionSchemaVersion": client.schema["actionSchemaVersion"],
            "buildFingerprint": client.fingerprint, "eventIds": client.schema["eventIds"],
            "mode": mode, "cardSet": card_set,
            "network": {"stateDim": encoder.state_dim, "candidateDim": encoder.candidate_dim},
            "optimizerConfig": {**OPTIMIZER_CONFIG,
                "entropy": OPTIMIZER_CONFIG["entropy"] if entropy_coefficient is None else entropy_coefficient},
            "rewardConfig": reward_config(card_set),
            "experimentId": experiment_id, "initialWeightsSha256": initial_weights_sha256,
            "experimentConfigSha256": experiment_config_sha256(experiment_id, mode,
                OPTIMIZER_CONFIG["entropy"] if entropy_coefficient is None else entropy_coefficient,
                initial_weights_sha256, training_seed, client.fingerprint, card_set, architecture,
                auxiliary_config),
            "update": update, "policyVersion": update,
            "completedDecisions": decisions, "completedEpisodes": completed_episodes,
            "episodesPerUpdate": 40, "nextSeed": next_seed, "trainingSeed": training_seed,
            "pythonRandomState": rng.getstate(), "torchRandomState": torch.get_rng_state(),
            "cudaRandomState": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None,
            "modelState": model.state_dict(), "optimizerState": optimizer.state_dict()}
    if auxiliary_config is not None:
        payload["auxiliaryConfig"] = auxiliary_config
    if sampling_config is not None:
        payload["samplingConfig"] = sampling_config
    return payload


def restore_checkpoint(path, model, optimizer, encoder, client, mode, rng, card_set="events",
                       training_seed=None, experiment_id=None, entropy_coefficient=None,
                       initial_weights_sha256=None, architecture=None, auxiliary_config=None,
                       approved_resume_parent_sha256=None):
    saved = torch.load(path, map_location="cpu", weights_only=False)
    expected = {"format": "quartermaster-ppo-checkpoint-v1", "encoderVersion": encoder_version(card_set),
                "trainerVersion": TRAINER_VERSION,
                "encoderDictionarySha256": encoder_dictionary_hash(encoder),
                "observationSchemaVersion": client.schema["observationSchemaVersion"],
                "actionSchemaVersion": client.schema["actionSchemaVersion"],
                "buildFingerprint": client.fingerprint, "eventIds": client.schema["eventIds"],
                "mode": mode, "cardSet": card_set,
                "network": {"stateDim": encoder.state_dim,
                            "candidateDim": encoder.candidate_dim},
                "rewardConfig": reward_config(card_set),
                "optimizerConfig": {**OPTIMIZER_CONFIG,
                    "entropy": OPTIMIZER_CONFIG["entropy"] if entropy_coefficient is None else entropy_coefficient},
                "experimentId": experiment_id,
                "initialWeightsSha256": initial_weights_sha256,
                "experimentConfigSha256": experiment_config_sha256(experiment_id, mode,
                    OPTIMIZER_CONFIG["entropy"] if entropy_coefficient is None else entropy_coefficient,
                    initial_weights_sha256, training_seed, client.fingerprint, card_set, architecture,
                    auxiliary_config),
                "episodesPerUpdate": 40}
    if architecture is not None:
        expected["networkArchitecture"] = architecture
    if auxiliary_config is not None:
        expected["auxiliaryConfig"] = auxiliary_config
    if any(saved.get(key) != value for key, value in expected.items()):
        raise ValueError("Checkpoint schema, mode, or rules build differs")
    source_compatible = saved.get("trainerSourceSha256") in ({TRAINER_SOURCE_HASH} |
                                                              NON_SEMANTIC_PREDECESSOR_HASHES)
    if not source_compatible and approved_resume_parent_sha256 is not None:
        actual_hash = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        source_compatible = (actual_hash == approved_resume_parent_sha256 and
                             experiment_id == "A2S1" and saved.get("update") == 1 and
                             saved.get("trainerSourceSha256") ==
                             "87b7fa23046c8a38a0bb06623085ad414353f413fad16c976a56544bb924c8d2")
    if not source_compatible:
        raise ValueError("Checkpoint trainer source differs")
    if experiment_id == "A2S1" and saved.get("update", 0) > 1 and saved.get("samplingConfig") != {
            "version": "chunk-shuffle-epoch-v1", "cacheLimitBytes": 1536 * 1024 ** 2,
            "prefetchLimitBytes": 256 * 1024 ** 2, "gradientMicrobatch": 64,
            "logicalMinibatch": 256, "epochs": 4}:
        raise ValueError("A2S1 sampling configuration differs")
    if saved.get("completedEpisodes") != saved.get("update", -1) * 40:
        raise ValueError("Checkpoint complete-episode count differs from update boundary")
    if training_seed is not None and saved.get("trainingSeed") != training_seed:
        raise ValueError("Checkpoint training seed differs")
    model.load_state_dict(saved["modelState"])
    optimizer.load_state_dict(saved["optimizerState"])
    rng.setstate(saved["pythonRandomState"])
    torch.set_rng_state(saved["torchRandomState"])
    if saved["cudaRandomState"] is not None and torch.cuda.is_available():
        torch.cuda.set_rng_state_all(saved["cudaRandomState"])
    return saved


def evaluation(client, encoder, model, device, mode, seeds, max_decisions, card_set="events",
               on_progress=None):
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
                           "countryTurns": episode["countryTurns"],
                           "choices": episode["choices"],
                           "scoreDifference": end["allianceScores"]["axis"] - end["allianceScores"]["allies"],
                           "eventSourceSelections": sum(count for name, count in episode["sources"].items()
                                                        if name.startswith("special_")),
                           "eventSubmissions": sum(count for name, count in episode["submitted"].items()
                                                   if name.startswith("special_")),
                           "eventResolutions": sum(count for name, count in episode["resolved"].items()
                                                   if name.startswith("special_")),
                           "consumedEvents": episode["consumedEvents"],
                           "remainingBySeat": episode["remainingBySeat"],
                           "discardedBySeat": episode["discardedBySeat"]})
            if on_progress:
                on_progress(len(output))
    return output


if __name__ == "__main__":
    sys.path.insert(0, str(ROOT))
    from scripts.ppo_parallel import main
    main()

