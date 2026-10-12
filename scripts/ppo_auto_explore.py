"""Bounded off-policy exploration using the real training engine.

This module never emits PPO samples. An explicit intervention and its frozen
policy probability are retained separately for every branch decision.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import time
from collections import Counter
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_auto_archive import ExplorationArchive, action_family, cell_key, digest
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network

VERSION = "auto-explorer-v3-persistent-path"
QUEUE = ("coverage", "coverage", "coverage", "coverage", "coverage",
         "continuation", "continuation", "continuation", "review", "review")


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class FrozenPolicy:
    @classmethod
    def from_live(cls, model, encoder, device, *, source_hash):
        """Wrap the single frozen collector model without loading another GPU copy."""
        instance = object.__new__(cls)
        instance.checkpoint = None
        instance.file_hash = source_hash
        instance.encoder = encoder
        instance.device = device
        instance.model = model
        instance.model.eval()
        instance.weight_hash = ppo.model_weights_sha256(model)
        instance.timing = {"encodeSeconds": 0.0, "inferenceSeconds": 0.0,
                           "calls": 0}
        return instance

    def __init__(self, checkpoint: Path, client, *, device="cpu"):
        self.checkpoint = Path(checkpoint)
        self.file_hash = sha256(checkpoint)
        self.saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
        initial = self.saved.get("format") == "quartermaster-ppo-comparison-initial-v1"
        if ((self.saved.get("resourceMode") if initial else self.saved.get("mode")) != "A" or
            ("signals" if initial else self.saved.get("cardSet")) != "signals" or
            self.saved.get("networkArchitecture") != A2S1_ADAPTER or
            self.saved.get("buildFingerprint") != client.fingerprint):
            raise ValueError("Exploration model is not the reviewed A-mode signals map network")
        self.encoder = ppo.Encoder(client.schema)
        if self.saved.get("network") != {"stateDim": self.encoder.state_dim,
                                          "candidateDim": self.encoder.candidate_dim}:
            raise ValueError("Exploration model input dimensions differ")
        if self.saved.get("encoderVersion") != ppo.encoder_version("signals"):
            raise ValueError("Exploration model observation encoding differs")
        self.device = torch.device(device)
        self.model = make_network(A2S1_ADAPTER, self.encoder).to(self.device)
        self.model.load_state_dict(self.saved["modelState"], strict=True)
        self.model.eval()
        self.weight_hash = ppo.model_weights_sha256(self.model)
        self.timing = {"encodeSeconds": 0.0, "inferenceSeconds": 0.0,
                       "calls": 0}

    def probabilities(self, observation):
        encode_started = time.perf_counter()
        state, candidates = self.encoder.encode(observation)
        self.timing["encodeSeconds"] += time.perf_counter()-encode_started
        inference_started = time.perf_counter()
        with torch.inference_mode():
            logits, value = self.model(*ppo.batch_tensors(
                [{"state": state, "candidates": candidates}], self.device))
            probs = torch.softmax(logits[0, :len(observation["candidates"])], -1).cpu().tolist()
        if self.device.type == "cuda":
            torch.cuda.synchronize()
        self.timing["inferenceSeconds"] += time.perf_counter()-inference_started
        self.timing["calls"] += 1
        return probs, float(value[0])


def sample(probs, rng):
    draw = rng.random()
    for index, probability in enumerate(probs):
        draw -= probability
        if draw < 0:
            return index
    return len(probs) - 1


def structural_choices(observation):
    families = {}
    for index, candidate in enumerate(observation["candidates"]):
        families.setdefault(action_family(candidate), []).append(index)
    return families


def choose_exploration_action(archive, root, attempt):
    observation = root["observation"]
    cell = root["cell"]
    indexed = []
    for index, candidate in enumerate(observation["candidates"]):
        family = action_family(candidate)
        card = candidate.get("definitionId") or candidate.get("kind") or "unknown"
        count = archive.coverage_count(cell, card, family)
        # Three exact-card selections and one semantic-family selection.
        score = count[1] if attempt % 4 else sum(
            archive.coverage_count(cell, other.get("definitionId") or
                other.get("kind") or "unknown", family)[1]
            for other in observation["candidates"] if action_family(other) == family)
        cooling = archive.coverage_cooling(cell, card, family)
        indexed.append((int(cooling), score, count[0], family, card, index))
    available = [item for item in indexed if not item[0]]
    return min(available)[-1] if available else None


def _state_hash(snapshot):
    return digest({"state": snapshot["state"], "decisionCount": snapshot["decisionCount"]})


def restore_equivalent(client, root):
    restored = client.request(op="restore", snapshot=root["snapshot"], comboTelemetry="full")
    if digest(restored["observation"]) != digest(root["observation"]):
        raise ValueError("Restored root has different visible observation or candidates")
    current = client.request(op="snapshot")["snapshot"]
    if _state_hash(current) != _state_hash(root["snapshot"]):
        raise ValueError("Restored root has different engine state")
    return restored["observation"]


def run_branch(client, root, policy, first_index, *, kind, seed, max_steps=120,
               max_extra_interventions=2, review_seed=None, stop_after_two_turns=True,
               deadline=None, archive=None, budget_key=None, budget_ceiling=None,
               save_observations=True):
    observation = restore_equivalent(client, root)
    if review_seed is not None:
        response = client.request(op="review-fork-rng", seed=review_seed,
                                  purpose="off-policy-review")
        if digest(response["observation"]) != digest(observation):
            raise ValueError("Future RNG fork changed current legal observation")
    rng = random.Random(seed)
    start_seat = observation["activeSeat"]
    start_round = observation["round"]
    first_card_id = observation["candidates"][first_index].get("cardId")
    first_definition = observation["candidates"][first_index].get("definitionId")
    started = time.perf_counter()
    path, successors, reward = [], [], {"axis": 0.0, "allies": 0.0}
    side = ppo.team_of(observation["decisionSeat"])
    interventions = 0
    result = None
    for depth in range(max_steps):
        if deadline is not None and time.time() >= deadline:
            break
        if archive is not None and not archive.consume_budget(budget_key, 1, budget_ceiling):
            break
        candidates = observation["candidates"]
        probs, value = policy.probabilities(observation)
        if depth == 0:
            index = first_index
            behavior = "explicit_exploration" if kind != "reference" else "frozen_argmax"
        else:
            relevant = (kind == "coverage" and archive is not None and
                ppo.team_of(observation["decisionSeat"]) == side and
                len(structural_choices(observation)) >= 2 and
                observation["node"] in ("SOURCE", "ENGINE_CHOICE"))
            if relevant and interventions < max_extra_interventions:
                current = {"observation": observation, "cell": cell_key(observation)}
                index = choose_exploration_action(archive, current, depth)
                if index is not None:
                    behavior = "downstream_exploration"
                    interventions += 1
                else:
                    index = sample(probs, rng)
                    behavior = "frozen_sample"
            elif kind == "sentinel":
                index = max(range(len(probs)), key=lambda item: probs[item])
                behavior = "frozen_argmax"
            else:
                index = sample(probs, rng)
                behavior = "frozen_sample"
        candidate = candidates[index]
        before = observation
        response = client.request(op="step", action={**before["decision"],
                                  "actionId": candidate["id"]}, comboTelemetry=True)
        after_scores = (response["result"]["allianceScores"] if response["result"]
                        else response["observation"]["allianceScores"])
        base, train = ppo.decision_rewards(before, after_scores, response["result"], response["info"])
        for team in reward:
            reward[team] += train[team]
        for item in response["info"].get("rewardAdjustments", ()):
            reward[ppo.team_of(item["seat"])] += item["penalty"]
        commits = response.get("comboTelemetry", {}).get("commits", ())
        path.append({"decisionId": before["decision"]["decisionId"],
            "seat": before["decisionSeat"], "round": before["round"],
            "actionId": candidate["id"], "cardId": candidate.get("cardId"),
            "definitionId": candidate.get("definitionId"),
            "candidateHash": digest(candidates), "policyProbability": probs[index],
            "behavior": behavior, "value": value,
            "selection": response.get("comboTelemetry", {}).get("selected"),
            "observation": before if save_observations and
                ppo.team_of(before["decisionSeat"]) == side else None,
            "events": commits, "baseReward": base, "trainingReward": train,
            "rewardAdjustments": response["info"].get("rewardAdjustments", ())})
        observation = response["observation"]
        result = response["result"]
        meaningful = any(commit.get("installs") or commit.get("added") or
            commit.get("removed") or any(event.get("outcome") == "succeeded" and
            event.get("kind") in ("action", "score") for event in commit.get("events", ()))
            for commit in commits)
        if observation is not None and len(successors) < 8 and meaningful:
            successors.append({"snapshot": client.request(op="snapshot")["snapshot"],
                               "observation": observation, "pathLength": depth+1,
                               "interventions": interventions})
        if result is not None:
            break
        if observation is None:
            raise RuntimeError("Arena returned neither observation nor result")
        # The first window ends after the acting country has completed two more
        # own turns. A continuing status remains unresolved, not a failed route.
        if stop_after_two_turns and observation["round"] >= start_round + 2 and \
                observation["activeSeat"] == start_seat:
            break
    final = client.request(op="snapshot")["snapshot"]
    attributed = [(depth, commit, event) for depth, step in enumerate(path)
                  for commit in step["events"] for event in commit.get("events", ())
                  if (first_card_id and (event.get("frameCardId") == first_card_id or
                      first_card_id in event.get("sourceAncestors", ()))) or
                     (depth == 0 and step.get("cardId") == first_card_id)]
    useful = [event for _, _, event in attributed
              if event.get("outcome") == "succeeded" and
                 (event.get("defenderId") or event.get("kind") == "score")]
    start_units = {unit["id"] for unit in root["snapshot"]["state"]["units"]}
    source_units = {event.get("resultUnitId") for _, _, event in attributed
                    if event.get("outcome") == "succeeded" and event.get("resultUnitId")}
    source_units.update(unit["id"] for depth, step in enumerate(path) for commit in step["events"]
                        for unit in commit.get("added", ()) if depth == 0 and
                        step.get("cardId") == first_card_id)
    surviving = [unit for unit in final["state"]["units"] if unit["id"] not in start_units
                 and unit["id"] in source_units]
    signature = sorted({canonical_event(event) for event in useful} |
                       {f"unit:{unit['country']}:{unit['type']}:{unit['regionId']}"
                        for unit in surviving})
    mechanism = [canonical_mechanism(event) for _, _, event in attributed
                 if event.get("outcome") == "succeeded" and
                 event.get("kind") in ("action", "score", "remove")]
    outcome = "useful" if useful or surviving else "completed" if result else "truncated"
    return {"version": VERSION, "kind": kind, "rootId": root["id"], "seed": seed,
        "reviewSeed": review_seed, "policyFileSha256": policy.file_hash,
        "policyWeightsSha256": policy.weight_hash,
        "startHash": _state_hash(root["snapshot"]), "endHash": _state_hash(final),
        "path": path, "successors": successors, "steps": len(path),
        "extraInterventions": interventions,
        "durationSeconds": time.perf_counter()-started,
        "naturalEnd": bool(result and result.get("termination") == "natural"),
        "winner": result.get("winner") if result else None,
        "score": final["state"]["scores"], "reward": reward, "side": side,
        "rootCardId": first_card_id, "rootDefinitionId": first_definition,
        "usefulEventIds": [event["id"] for event in useful],
        "survivingNewUnits": [unit["id"] for unit in surviving],
        "routeSignature": signature, "mechanismSignature": mechanism,
        "outcome": outcome}


def canonical_mechanism(event):
    return json.dumps({key: event.get(key) for key in
        ("sourceDefinitionId", "kind", "action", "country", "regionId")},
        sort_keys=True, separators=(",", ":"))


def canonical_event(event):
    """Stable tactical result, excluding frame, instance and decision IDs."""
    return json.dumps({key: event.get(key) for key in
        ("kind", "action", "country", "regionId", "targetRegionId", "amount")
        if event.get(key) is not None}, sort_keys=True, separators=(",", ":"))


def capture_roots(client, policy, archive, seed, *, max_roots=12, max_decisions=240,
                  deadline=None, budget_key="p2_engine_steps", budget_ceiling=6000):
    reasons, decisions, source_games = Counter(), 0, []
    for game_number in range(12):
        if decisions >= max_decisions or len(archive.roots()) >= max_roots:
            break
        game_seed = seed + 1009 * game_number
        observation = client.request(op="reset", seed=game_seed,
            gameId=f"auto-root-{game_seed}", mode="A", cardSet="signals",
            trace="none", comboTelemetry="full")["observation"]
        rng = random.Random(game_seed ^ 0xA511E9B3)
        prefix, stored_here = [], 0
        while observation is not None and decisions < max_decisions and \
                len(archive.roots()) < max_roots and len(prefix) < 60:
            if (deadline is not None and time.time() >= deadline) or not archive.consume_budget(
                    budget_key, 1, budget_ceiling):
                break
            if len(prefix) % 4 == game_number % 4 and \
                    len(structural_choices(observation)) >= 2 and stored_here < 4:
                snapshot = client.request(op="snapshot")["snapshot"]
                root_id, reason = archive.add_root(snapshot, observation, prefix)
                reasons[reason] += 1
                stored_here += bool(root_id)
            probs, _ = policy.probabilities(observation)
            candidate = observation["candidates"][sample(probs, rng)]
            prefix.append({"decisionId": observation["decision"]["decisionId"],
                           "actionId": candidate["id"], "cardId": candidate.get("cardId"),
                           "candidateHash": digest(observation["candidates"]),
                           "observation": observation,
                           "behavior": "frozen_sample"})
            response = client.request(op="step", action={**observation["decision"],
                                      "actionId": candidate["id"]})
            observation = response["observation"]
            decisions += 1
            if stored_here >= 4:
                break
        source_games.append({"seed": game_seed, "decisions": len(prefix),
                             "rootsStored": stored_here})
    return {"roots": len(archive.roots()), "decisions": decisions,
            "sourceGames": source_games, "reasons": dict(reasons)}


def capture_sentinels(client, policy, archive, seed, *, deadline, max_steps=36,
                      course_pool=None):
    """Frozen, disjoint game seeds; never reused for exploration or imitation."""
    existing_sentinels = archive.sentinels()
    completed_seeds = {item["seed"] for item in existing_sentinels}
    existing = {digest(archive.read_root(root)["observation"]) for root in archive.roots()}
    steps = 0
    for game in range(4):
        game_seed = seed + game * 7919
        if game_seed in completed_seeds:
            continue
        observation = client.request(op="reset", seed=game_seed,
            gameId=f"auto-sentinel-{game_seed}", mode="A", cardSet="signals",
            trace="none")["observation"]
        rng = random.Random(game_seed ^ 0x517E1)
        for depth in range(9):
            if not observation or steps >= max_steps or time.time() >= deadline:
                break
            if depth in (3, 6, 8) and digest(observation) not in existing:
                archive.add_sentinel(game_seed, observation,
                                     client.request(op="snapshot")["snapshot"])
                existing.add(digest(observation))
                completed_seeds.add(game_seed)
            if not archive.consume_budget("p2_engine_steps", 1, 6000):
                break
            probabilities, _ = policy.probabilities(observation)
            choice = observation["candidates"][sample(probabilities, rng)]
            response = client.request(op="step", action={**observation["decision"],
                                      "actionId": choice["id"]})
            observation = response["observation"]
            steps += 1
    course_cases = 0
    if course_pool is not None and time.time() < deadline:
        import gzip
        with gzip.open(course_pool, "rt", encoding="utf-8") as stream:
            pool = json.load(stream)
        train_scenes = {entry.get("strategicSceneSha256") for entry in pool["entries"]
                        if entry.get("split") == "train"}
        for template in ("G1", "U4", "J1"):
            entry = next((entry for entry in pool["entries"] if
                entry["template"] == template and entry["variant"] == "positive" and
                entry["layer"] == "payoff" and entry["split"] == "evaluation" and
                entry.get("strategicSceneSha256") not in train_scenes), None)
            if entry is None:
                continue
            if entry["seed"] in completed_seeds:
                continue
            observation = client.request(op="restore", snapshot=entry["snapshot"])["observation"]
            if observation is not None and digest(observation) not in existing:
                archive.add_sentinel(entry["seed"], observation, entry["snapshot"])
                existing.add(digest(observation))
                completed_seeds.add(entry["seed"])
                course_cases += 1
    return {"stored": len(archive.sentinels()), "engineSteps": steps,
            "independentCourseCases": course_cases}


def explore_pairs(clients, policy, archive, *, max_pairs=2, max_steps=6000,
                  wall_seconds=1200, seed=20261011):
    started = time.perf_counter()
    deadline = archive.phase_deadline("p2", wall_seconds)
    results = []
    unresolved_pairs = 0
    roots = archive.roots()
    queue_counts = Counter()
    for number in range(archive.branch_pairs(), archive.branch_pairs()+max_pairs):
        if not roots or archive.remaining_budget("p2_engine_steps", max_steps) < 2 or \
                time.time() >= deadline:
            break
        desired_queue = QUEUE[number % len(QUEUE)]
        eligible = [item for item in archive.roots_by_queue(desired_queue)
                    if sum(step.get("behavior") in ("explicit_exploration",
                        "downstream_exploration") for step in
                        archive.read_root(item)["prefix"]) < 4]
        if not eligible:
            eligible = [item for item in (archive.roots_by_queue("coverage") or roots)
                        if sum(step.get("behavior") in ("explicit_exploration",
                            "downstream_exploration") for step in
                            archive.read_root(item)["prefix"]) < 4]
            queue_counts[f"{desired_queue}_reallocated"] += 1
        if not eligible:
            queue_counts["depth_cap"] += 1
            break
        queue_counts[desired_queue] += 1
        root = archive.read_root(eligible[number % len(eligible)])
        used_interventions = sum(item.get("behavior") in
            ("explicit_exploration", "downstream_exploration") for item in root["prefix"])
        if used_interventions >= 4:
            queue_counts["depth_cap"] += 1
            continue
        choices = root["observation"]["candidates"]
        probs, _ = policy.probabilities(root["observation"])
        reference_index = max(range(len(probs)), key=lambda index: probs[index])
        explore_index = choose_exploration_action(archive, root, number)
        if explore_index is None:
            queue_counts["cooldown"] += 1
            continue
        if explore_index == reference_index and len(choices) > 1:
            explore_index = sorted(range(len(choices)), key=lambda i: probs[i])[0]
        pair = []
        for client, index, kind in zip(clients, (reference_index, explore_index),
                                       ("reference", "coverage")):
            if archive.remaining_budget("p2_engine_steps", max_steps) <= 0 or \
                    time.time() >= deadline:
                break
            result = run_branch(client, root, policy, index, kind=kind,
                                seed=seed + number,
                                max_steps=min(120, archive.remaining_budget(
                                    "p2_engine_steps", max_steps)),
                                deadline=deadline, archive=archive,
                                budget_key="p2_engine_steps", budget_ceiling=max_steps,
                                save_observations=kind != "reference",
                                max_extra_interventions=min(2, 3-used_interventions))
            card = choices[index]
            family = action_family(card)
            compact = {key: value for key, value in result.items() if key != "successors"}
            branch_id = archive.record_branch(root["id"],
                card.get("definitionId") or card["kind"], family, compact, result["outcome"])
            for successor in result["successors"]:
                prefix = root["prefix"] + [{key: step.get(key) for key in
                    ("decisionId", "actionId", "candidateHash", "observation", "behavior",
                     "seat", "cardId", "events")}
                    for step in result["path"][:successor["pathLength"]]]
                # A continuation cannot start a fresh intervention allowance.
                if sum(item.get("behavior") in ("explicit_exploration",
                    "downstream_exploration") for item in prefix) > 4:
                    continue
                archive.add_root(successor["snapshot"], successor["observation"],
                    prefix, branch_id)
            pair.append(result)
        results.extend(pair)
        if len(pair) != 2 or not all(item["steps"] for item in pair):
            unresolved_pairs += 1
            break
        reference, proposed = pair
        side = proposed["side"]
        if proposed["outcome"] == "useful" and \
                proposed["reward"][side] >= reference["reward"][side]:
            archive.add_route(root["id"], {"version": VERSION,
                "rootId": root["id"], "firstActionId": choices[explore_index]["id"],
                "firstCardId": choices[explore_index].get("cardId"),
                "firstDefinitionId": choices[explore_index].get("definitionId"),
                "candidate": {key: value for key, value in proposed.items()
                              if key != "successors"}, "referenceSummary": {
                    "reward": reference["reward"], "outcome": reference["outcome"],
                    "steps": reference["steps"]}, "path": proposed["path"],
                "shortWindowOnly": True})
    return {"pairs": (len(results)-unresolved_pairs)//2,
            "unresolvedPairs": unresolved_pairs,
            "steps": sum(item["steps"] for item in results),
            "durationSeconds": time.perf_counter()-started,
            "queueCounts": dict(queue_counts),
            "pendingReview": len(archive.routes("candidate")),
            "branches": [{key: value for key, value in item.items()
                          if key not in ("path", "successors")}
                         for item in results]}


def review_routes(clients, policy, parent_policy, archive, *, max_routes=3,
                  max_steps=20_000, wall_seconds=1800, seed=20261011):
    """Eight complete paired continuations; insufficient budget remains unresolved."""
    started, steps, reports = time.perf_counter(), 0, []
    deadline = archive.phase_deadline("p3", wall_seconds)
    policies = (policy, parent_policy)
    previously_reviewed = sum(len(archive.routes(status)) for status in
                              ("reviewed", "enabled", "revoked"))
    remaining_routes = max(0, max_routes - previously_reviewed)
    for route_id in archive.routes("candidate")[:remaining_routes]:
        if archive.remaining_budget("p3_engine_steps", max_steps) <= 0 or time.time() >= deadline:
            break
        route = archive.route(route_id)["evidence"]
        root = archive.read_root(route["rootId"])
        proposal = next((index for index, candidate in enumerate(root["observation"]["candidates"])
                         if candidate["id"] == route["firstActionId"]), None)
        if proposal is None:
            reports.append({"routeId": route_id, "status": "unresolved", "reason": "candidate_missing"})
            continue
        pairs = []
        for trial in range(8):
            if archive.remaining_budget("p3_engine_steps", max_steps) <= 0 or time.time() >= deadline:
                break
            frozen = policies[trial % 2]
            probs, _ = frozen.probabilities(root["observation"])
            reference_index = max(range(len(probs)), key=lambda index: probs[index])
            paired_seed = seed + 7919 * trial
            trial_results = []
            for client, index, kind in zip(clients,
                    (reference_index, proposal), ("reference-review", "proposal-review")):
                remaining = archive.remaining_budget("p3_engine_steps", max_steps)
                if remaining <= 0 or time.time() >= deadline:
                    break
                trial_results.append(run_branch(client, root, frozen, index,
                    kind=kind, seed=paired_seed, review_seed=paired_seed,
                    max_steps=min(1400, remaining), stop_after_two_turns=False,
                    deadline=deadline, archive=archive,
                    budget_key="p3_engine_steps", budget_ceiling=max_steps,
                    save_observations=False, max_extra_interventions=0))
            if len(trial_results) != 2:
                steps += sum(item["steps"] for item in trial_results)
                break
            steps += sum(item["steps"] for item in trial_results)
            left, right = trial_results
            pairs.append({"seed": paired_seed, "opponentPolicySha256": frozen.weight_hash,
                "referenceReward": left["reward"], "proposalReward": right["reward"],
                "referenceNatural": left["naturalEnd"], "proposalNatural": right["naturalEnd"],
                "routeRepeated": right["outcome"] == "useful" and bool(
                    route["candidate"].get("mechanismSignature")) and
                    mechanism_matches(route["candidate"]["mechanismSignature"],
                                      right["mechanismSignature"]) and bool(
                    set(route["candidate"]["routeSignature"]) &
                    set(right["routeSignature"])),
                "difference": right["reward"][right["side"]] - left["reward"][left["side"]],
                "steps": left["steps"] + right["steps"]})
        completed = len(pairs) == 8 and all(item["referenceNatural"] and
                                             item["proposalNatural"] for item in pairs)
        pass_count = sum(item["difference"] >= 0 for item in pairs)
        replay_count = sum(item["routeRepeated"] for item in pairs)
        mean_difference = sum(item["difference"] for item in pairs)/len(pairs) if pairs else None
        qualified = completed and pass_count >= 6 and mean_difference > 0 and replay_count >= 4
        report = {"routeId": route_id, "completed": completed, "pairs": pairs,
            "nonnegativePairs": pass_count, "routeRepetitions": replay_count,
            "meanDifference": mean_difference,
            "status": "enabled" if qualified else "reviewed" if completed else "unresolved"}
        if completed:
            archive.set_route_status(route_id, "enabled" if qualified else "reviewed")
            if qualified:
                labels = demonstration_path(root, route)
                report["demonstration"] = archive.add_demonstrations(route_id,
                    route["firstDefinitionId"] or "structural-action", labels)
        reports.append(report)
    return {"reviewed": reports, "steps": steps,
            "durationSeconds": time.perf_counter()-started,
            "remainingCandidates": len(archive.routes("candidate"))}


def mechanism_matches(required, actual):
    """Ordered subsequence in one reviewed branch, never stitched across forks."""
    iterator = iter(actual)
    return all(any(candidate == needed for candidate in iterator) for needed in required)


def demonstration_path(root, route):
    """Retain only legally reproducible same-team decisions on the causal path."""
    path = root["prefix"] + route["path"]
    first = route["firstCardId"]
    side = route["candidate"]["side"]
    related_cards = {first} if first else set()
    related_frames = set()
    for step in route["path"]:
        for commit in step.get("events", ()):
            for event in commit.get("events", ()):
                if event.get("outcome") == "succeeded" and (
                    event.get("frameCardId") == first or
                    first in event.get("sourceAncestors", ())):
                    related_cards.update(filter(None, [event.get("frameCardId"),
                        *event.get("sourceAncestors", ())]))
                    related_frames.add(event.get("frameId"))
    labels = []
    for step in path:
        observation = step.get("observation")
        if observation is None or ppo.team_of(observation["decisionSeat"]) != side:
            continue
        contextual = any(commit.get("context", {}).get("frameId") in related_frames
            for commit in step.get("events", ()) if commit.get("context"))
        is_root_choice = (step["decisionId"] == route["path"][0]["decisionId"] and
                          step["actionId"] == route["firstActionId"])
        if step.get("cardId") not in related_cards and not is_root_choice and not contextual:
            continue
        choices = observation["candidates"]
        if digest(choices) != step["candidateHash"] or sum(
                choice["id"] == step["actionId"] for choice in choices) != 1:
            raise ValueError("Causal demonstration lost its legal candidate identity")
        labels.append({"observation": observation, "actionId": step["actionId"],
            "candidateHash": step["candidateHash"], "decisionId": step["decisionId"],
            "seat": observation["decisionSeat"], "sourceCardId": first,
            "behavior": step.get("behavior")})
    if not any(item["decisionId"] == route["path"][0]["decisionId"] and
               item["actionId"] == route["firstActionId"] for item in labels):
        raise ValueError("Reviewed route lacks a supervised exploration action")
    return labels


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("capture", "branch", "review", "show"))
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=20261011)
    parser.add_argument("--max-roots", type=int, default=12)
    parser.add_argument("--pairs", type=int, default=2)
    parser.add_argument("--parent-checkpoint", type=Path)
    args = parser.parse_args()
    clients = [ppo.ArenaClient(card_set="signals") for _ in range(
        2 if args.command in ("branch", "review") else 1)]
    try:
        policy = FrozenPolicy(args.checkpoint, clients[0])
        identity = {"sourceCheckpointSha256": policy.file_hash,
                    "sourceWeightsSha256": policy.weight_hash,
                    "buildFingerprint": clients[0].fingerprint,
                    "encoderVersion": ppo.encoder_version("signals"),
                    "rewardConfig": ppo.reward_config("signals"), "explorerVersion": VERSION}
        with ExplorationArchive(args.archive, identity) as archive:
            if args.command == "capture":
                result = capture_roots(clients[0], policy, archive, args.seed,
                                       max_roots=args.max_roots)
            elif args.command == "branch":
                result = explore_pairs(clients, policy, archive, max_pairs=args.pairs,
                                       seed=args.seed)
            elif args.command == "review":
                if not args.parent_checkpoint:
                    parser.error("--parent-checkpoint is required for independent review")
                parent = FrozenPolicy(args.parent_checkpoint, clients[0])
                if parent.weight_hash == policy.weight_hash:
                    raise ValueError("Review needs two distinct frozen policy sources")
                result = review_routes(clients, policy, parent, archive, seed=args.seed)
            else:
                result = archive.stats()
            print(json.dumps({"identity": identity, "result": result}, ensure_ascii=False, indent=2))
    finally:
        for client in clients:
            client.close()


if __name__ == "__main__":
    main()
