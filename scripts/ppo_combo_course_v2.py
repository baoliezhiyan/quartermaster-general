"""A2S1C2 reachable starts. Preparation decisions never enter PPO samples.

Every start is a prefix of a legal reset/step trace. The generator may guide
preparation, but does not edit state, resources, random draws, or responses.
"""
from __future__ import annotations

import gzip
import argparse
import hashlib
import json
import os
import random
import time
from dataclasses import replace
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts import ppo_combo_course as first

VERSION = "a2s1-reachable-combos-v8-heldout-scene-and-control"
MIX = {"normal": 28, "course": 12, "payoff": 8, "preparation": 4,
       "rotation": "nine-templates-deterministic-v2"}
TEMPLATES = (
    first.Template("G1", "germany", ("special_136",), ("eastern_europe", "ukraine"),
        (first.Prep("germany", "build_army", "eastern_europe"),
         first.Prep("soviet_union", "build_army", "ukraine"),
         first.Prep("germany", "special_136")), "special_136"),
    first.Template("G2", "germany", ("special_136", "special_137"),
        ("eastern_europe", "ukraine", "moscow"),
        (first.Prep("germany", "build_army", "eastern_europe"),
         first.Prep("soviet_union", "build_army", "ukraine"),
         first.Prep("germany", "special_136"),
         first.Prep("germany", "special_137")), "special_137"),
    first.Template("G3", "germany", ("special_134", "special_136"),
        ("western_europe",),
        (first.Prep("germany", "land_battle", "western_europe"),
         first.Prep("united_kingdom", "build_navy", "sea_north_sea"),
         first.Prep("united_kingdom", "land_battle", "western_europe"),
         first.Prep("united_kingdom", "build_army", "western_europe"),
         first.Prep("united_states", "build_navy", "sea_north_atlantic"),
         first.Prep("united_states", "build_navy", "sea_north_sea"),
         first.Prep("united_states", "land_battle", "western_europe"),
         first.Prep("united_states", "build_army", "western_europe"),
         first.Prep("germany", "special_134"),
         first.Prep("germany", "special_136")), "special_136", 1100, 20),
    *tuple(item for item in first.TEMPLATES if item.key in
           ("U1", "U2", "U3", "J1", "J2")),
    first.Template("U4", "united_states", ("special_84",),
        ("sea_north_atlantic", "sea_north_sea"),
        (first.Prep("united_states", "special_84"),
         first.Prep("united_states", "build_navy", "sea_north_atlantic")),
        "special_84", 800, 12),
)
# A legal first-turn shipyard can compress the American two-sea approach when
# the allied front would otherwise form only after a natural game ending. It
# remains a paid, real preparation action, not a free map edit.
TEMPLATES = tuple(replace(item, steps=tuple(
    [*item.steps[:next(i for i, step in enumerate(item.steps)
                       if step.seat == "united_states" and step.card == "build_navy")],
     first.Prep("united_states", "special_84"),
     *item.steps[next(i for i, step in enumerate(item.steps)
                       if step.seat == "united_states" and step.card == "build_navy"):]]))
    if item.key in ("G3", "U1", "U3") else item for item in TEMPLATES)
# This course is deliberately early/near-opportunity. A failed frozen-policy
# preparation must not spend a whole 1000-decision game on one seed.
TEMPLATES = tuple(replace(item, max_decisions=min(item.max_decisions, 160))
                  for item in TEMPLATES)
BY_KEY = {item.key: item for item in TEMPLATES}


def course_id(entry: dict) -> str:
    return entry.get("courseId") or ":".join(entry[k] for k in
        ("template", "variant", "layer"))


def teaching_target(template, observation, state):
    """Return a legal lesson which has not already been installed or concealed."""
    missing = tuple(card for card in template.cards if template.key == "U1" or
                    not first._installed(state, template.owner, card))
    available = tuple(card for card in missing if first._source(observation, card))
    target = available[0] if len(missing) == 1 and available else (
        available[-1] if available else None)
    return target, missing


def classify_control(template, variant):
    if variant == "positive":
        return "verified_positive"
    # A scripted alternative route never proves that installing a permanent
    # state would be harmful. It is a route comparison, not a negative label.
    return "route_comparison" if template.key == "U4" else "condition_contrast_unverified"


def _state_signature(state: dict) -> str:
    """Strategic diversity, independent of card order and unit IDs."""
    payload = (state["round"], state["activeSeat"],
        sorted((u["country"], u["type"], u["regionId"]) for u in state["units"]),
        {seat: sorted(c["definitionId"] for c in deck["active"] + deck["faceDown"])
         for seat, deck in state["decks"].items()},
        {seat: {pile: sorted(c["definitionId"] for c in deck[pile])
                for pile in ("drawPile", "discardPile", "hand")}
         for seat, deck in state["decks"].items()}, state.get("scores"))
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def _near(template, observation, state, variant):
    if observation["activeSeat"] != template.owner or observation["node"] != "SOURCE":
        return False
    if template.owner == "germany" and observation["round"] < 2:
        return False
    key = template.key
    has = first._has
    if key in ("G1", "G2"):
        # For two-state preparation the Soviet target may arrive on the next
        # intervening turn. The German eastern front is already in place;
        # the later payoff snapshot still requires the real target and both
        # legally installed states.
        return has(state, "germany", "army", "eastern_europe") and (
            key == "G2" or has(state, "soviet_union", "army", "ukraine")
            or variant == "control")
    if key == "G3":
        if not first._installed(state, "germany", "special_134"):
            return has(state, "united_kingdom", "navy", "sea_north_sea") and (
                variant == "control" or has(state, "united_states", "navy", "sea_north_atlantic"))
        return (has(state, "united_kingdom", "army", "western_europe") and
            (variant == "control" or has(state, "united_states", "army", "western_europe")))
    if key in ("U1", "U3"):
        return has(state, "united_states", "navy", "sea_north_atlantic") and (
            has(state, "germany", "army", "western_europe") or
            has(state, "united_states", "navy", "sea_north_sea"))
    if key == "U2":
        return (has(state, "japan", "navy", "sea_east_china") if not first._installed(
            state, "united_states", "special_78") else
            (has(state, "japan", "navy", "sea_north_pacific") if variant == "control"
             else has(state, "japan", "army", "hawaii")))
    if key == "J1":
        return (has(state, "china", "army", "eastern_china") and
                (has(state, "japan", "navy", "sea_east_china") or
                 bool(first._source(observation, "build_navy", "sea_east_china"))))
    if key == "J2":
        return has(state, "china", "army", "eastern_china")
    if key == "U4":
        return observation["round"] == 1 and bool(first._source(observation, "special_84"))
    return False


def _u4_ready(observation, state, variant):
    if (observation["activeSeat"] != "united_states" or observation["node"] != "SOURCE"
            or observation["round"] != 2):
        return False
    active = first._installed(state, "united_states", "special_84")
    atlantic = first._has(state, "united_states", "navy", "sea_north_atlantic")
    north = first._has(state, "united_states", "navy", "sea_north_sea")
    return not north and (active and not atlantic and bool(first._source(
        observation, "build_navy", "sea_north_atlantic")) if variant == "positive"
        else not active and atlantic and bool(first._source(
            observation, "build_navy", "sea_north_sea")))


def _ready(template, observation, state, variant):
    if template.key == "U4":
        return _u4_ready(observation, state, variant)
    if template.key == "G3" and variant == "control":
        return (observation["activeSeat"] == "germany" and
            observation["node"] == "SOURCE" and observation["phase"] == "PLAY" and
            all(first._installed(state, "germany", card) for card in template.cards) and
            first._has(state, "united_kingdom", "navy", "sea_north_sea") and
            not first._has(state, "united_states", "army", "western_europe"))
    if template.key == "J2" and variant == "control":
        return (observation["activeSeat"] == "japan" and
            (observation["node"] == "SOURCE" or observation.get("choiceKind") == "TRIGGER") and
            observation["phase"] == "PLAY" and
            not first._has(state, "china", "army", "eastern_china"))
    return first.ready(template, observation, state, variant)


def _choose_model(model, encoder, device, rng, observation, excluded=()):
    state, candidates = encoder.encode(observation)
    if excluded:
        with torch.inference_mode():
            logits, _ = model(*ppo.batch_tensors([{"state": state,
                "candidates": candidates}], device))
            probabilities = torch.softmax(logits[0, :len(candidates)], -1).cpu().tolist()
        allowed = [i for i, action in enumerate(observation["candidates"])
                   if action.get("definitionId") not in excluded]
        if not allowed:
            raise ValueError("No legal non-target preparation action remains")
        total = sum(probabilities[i] for i in allowed)
        draw = rng.random() * total
        index = allowed[-1]
        for i in allowed:
            draw -= probabilities[i]
            if draw < 0:
                index = i
                break
    else:
        index, _, _ = ppo.select_action(model, state, candidates, device, rng=rng)
    return observation["candidates"][index]


def _specified_chain(entry, feasible):
    """Require actual source-linked effects, not just clicked legal buttons."""
    from scripts.ppo_combo_metrics import new_tracker, record_step, summarize
    tracker = new_tracker(course_id(entry), entry["snapshot"])
    for offset, step in enumerate(feasible["steps"]):
        if step.get("telemetry"):
            record_step(tracker, step["telemetry"], offset)
    result = summarize(tracker, {"winner": "allies",
        "allianceScores": {"axis": 0, "allies": 0}})
    return result.get("specifiedComboAchieved") is True


def generate_one(client, encoder, model, device, template, seed, variant="positive",
                 rng_salt=0xC2C2, heldout=False):
    started = time.perf_counter()
    observation = client.request(op="reset", seed=seed, mode="A", cardSet="signals")["observation"]
    rng = random.Random((seed << 32) ^ rng_salt)
    trace, completed, near_snapshots = [], set(), []
    white_selected = arden_selected = False
    for _ in range(template.max_decisions):
        if observation is None:
            break
        snapshot = client.request(op="snapshot")["snapshot"] if (
            template.key == "U4" or observation["node"] == "SOURCE" or
            observation.get("choiceKind") == "TRIGGER") else None
        state = snapshot["state"] if snapshot else None
        if snapshot:
            ready = _ready(template, observation, state, variant)
            if ready and (template.owner != "germany" or observation["round"] >= 2):
                nearby = [item for item in near_snapshots if item["target"] and
                          (template.key == "U1" or item["missing"]) and
                          len(trace) - item["traceLength"] <= 100
                          and (template.key == "U4" or observation["round"] - item["round"] <= 2)]
                if not nearby:
                    return {"template": template.key, "variant": variant, "seed": seed,
                            "failure": "no_near_preparation", "decisions": len(trace),
                            "nearDiagnostics": [{"traceLength": item["traceLength"],
                                "round": item["round"], "target": item["target"],
                                "missing": item["missing"]} for item in near_snapshots],
                            "trace": trace}
                preparation = nearby[-1]
                return {"template": template.key, "variant": variant,
                    "seed": seed, "snapshot": snapshot, "trace": trace,
                    "preparation": preparation,
                    "generatedSeconds": time.perf_counter() - started}
        planned, candidate = None, None
        if (heldout and template.key == "U4" and observation["round"] == 1 and
                observation["activeSeat"] == "germany" and
                observation["node"] == "SOURCE"):
            # A real German first-turn placement changes the held-out board
            # encoding. It is a legal scripted prelude, not a synthetic state
            # mutation or a negative label for the shipyard.
            candidate = first._source(observation, "build_army", "eastern_europe")
            if candidate:
                planned = "heldout_u4_legal_axis_deployment"
        if (template.owner == "germany" and observation["round"] == 1 and
                observation["activeSeat"] == "germany"):
            if observation["node"] == "SOURCE" and not white_selected:
                candidate = first._source(observation, "special_150")
                if candidate is None:
                    break
                planned = "white_plan"
                white_selected = True
            elif observation.get("choiceKind") == "EXTRA_CARD" and white_selected and not arden_selected:
                candidate = next((item for item in observation["candidates"] if any(
                    choice.get("definitionId") == "special_158" for choice in
                    item.get("choices") or [])), None)
                if candidate is None:
                    return {"template": template.key, "variant": variant, "seed": seed,
                            "failure": "arden_discarded_or_unavailable", "decisions": len(trace)}
                planned = "arden_extra_card"
                arden_selected = True
            elif observation["node"] == "SOURCE":
                candidate = next((item for item in observation["candidates"] if
                                  item["kind"] == "pass"), None)
                planned = "finish_first_turn" if candidate else None
        if template.owner == "germany" and observation["round"] > 1 and not arden_selected:
            return {"template": template.key, "variant": variant, "seed": seed,
                    "failure": "white_arden_not_completed", "decisions": len(trace)}
        if candidate is None and snapshot and _near(template, observation, state, variant):
            target, missing = teaching_target(template, observation, state)
            near_snapshots.append({"snapshot": snapshot, "traceLength": len(trace),
                "round": observation["round"], "missing": list(missing),
                "target": target, "candidateId": first._source(observation, target)["id"]
                if target else None})
        if candidate is None and template.key == "U4" and observation["activeSeat"] == "united_states":
            if observation["round"] == 1 and observation["node"] == "SOURCE":
                candidate = (first._source(observation, "special_84") if variant == "positive"
                             else first._source(observation, "build_navy", "sea_north_atlantic"))
                planned = "u4_install_or_direct" if candidate else None
        if candidate is None and template.key in ("G3", "U1", "U3") and (
                observation["activeSeat"] == "united_states"):
            if observation.get("choiceKind") == "TRIGGER":
                candidate = next((item for item in observation["candidates"] if any(
                    choice.get("kind") == "trigger" and choice.get("definitionId") == "special_84"
                    for choice in item.get("choices") or ())), None)
                planned = "paid_shipyard_followup" if candidate else None
            elif observation.get("choiceKind") in ("ACTION_REGION", "ACTION_PLAN"):
                candidate = next((item for item in observation["candidates"] if any(
                    choice.get("action") == "build_navy" and choice.get("regionId") == "sea_north_sea"
                    for choice in item.get("choices") or ())), None)
                planned = "paid_shipyard_north_sea" if candidate else None
        if (candidate is None and template.key == "G3" and
                observation["activeSeat"] == "united_kingdom" and
                observation["node"] == "SOURCE" and
                not first._has(state, "united_kingdom", "army", "western_europe")):
            candidate = first._source(observation, "build_army", "western_europe")
            if candidate:
                planned = next(i for i, step in enumerate(template.steps) if
                    step.seat == "united_kingdom" and step.card == "build_army" and
                    step.region == "western_europe")
        if (candidate is None and template.key == "G3" and
                observation["activeSeat"] == "germany" and
                observation["node"] == "SOURCE" and observation["round"] >= 2 and
                not first._installed(state, "germany", "special_134") and
                first._has(state, "united_kingdom", "navy", "sea_north_sea")):
            candidate = first._source(observation, "special_134")
            if candidate:
                planned = next(i for i, step in enumerate(template.steps) if
                    step.seat == "germany" and step.card == "special_134")
        if candidate is None and snapshot and template.key != "U4" and (
                observation["node"] == "SOURCE" or template.key == "J2" and
                observation.get("choiceKind") == "TRIGGER"):
            if template.owner != "germany" or observation["round"] >= 2:
                number, candidate = first._planned(template, completed, observation, state, variant)
                planned = number
                if (candidate is not None and isinstance(number, int) and number >= 0 and
                        candidate.get("definitionId") in template.cards and
                        not _near(template, observation, state, variant)):
                    # Defer this status without repeatedly passing away the
                    # whole country's turn. Let the frozen policy choose a
                    # different real action while preparation remains distant.
                    candidate = _choose_model(model, encoder, device, rng,
                        observation, excluded=template.cards)
                    planned = "frozen_non_target_while_waiting"
        if candidate is None:
            candidate = _choose_model(model, encoder, device, rng, observation)
        response = client.request(op="step", action={**observation["decision"],
                                   "actionId": candidate["id"]})
        trace.append({"decision": observation["decision"], "actionId": candidate["id"],
            "activeSeat": observation["activeSeat"], "phase": observation["phase"],
            "choiceKind": observation.get("choiceKind"), "scripted": planned is not None,
            "scriptReason": planned})
        if isinstance(planned, int) and planned >= 0:
            completed.add(planned)
        observation = response["observation"]
    return {"template": template.key, "variant": variant, "seed": seed,
            "failure": "natural_end" if observation is None else "preparation_budget",
            "decisions": len(trace), "lastRound": observation["round"] if observation else None,
            "completedSetupSteps": sorted(completed),
            "scriptedReasons": [item["scriptReason"] for item in trace
                                if item.get("scriptReason") is not None],
            "generatedSeconds": time.perf_counter() - started}


def pool_identity(client, parent_checkpoint_sha, model_sha):
    payload = {"version": VERSION, "mix": MIX, "buildFingerprint": client.fingerprint,
        "courseVersion": client.schema["courseVersion"],
        "observationVersion": client.schema["observationSchemaVersion"],
        "actionVersion": client.schema["actionSchemaVersion"],
        "encoderVersion": ppo.encoder_version("signals"),
        "rewardConfig": ppo.reward_config("signals"),
        "parentCheckpointSha256": parent_checkpoint_sha,
        "generatorWeightsSha256": model_sha, "resourceMode": "A",
        "rngConfig": {"defaultSalt": 0xC2C2, "U2Salt": 0xC0B0},
        "preparationPolicy": "legal-uncommitted-target-heldout-prelude-v8"}
    payload["identitySha256"] = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    return payload


def read_pool(path, expected_identity):
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        payload = json.load(stream)
    if payload["identity"] != expected_identity:
        raise ValueError("A2S1C2 pool identity differs")
    if not payload.get("complete"):
        raise ValueError("A2S1C2 pool is still partial; all starts are required")
    for entry in payload["entries"]:
        if entry.get("layer") == "preparation":
            if not entry.get("preparationTarget") or not entry.get("preparationCandidateId"):
                raise ValueError(f"Preparation lacks a legal lesson: {course_id(entry)}")
            if entry["template"] != "U1" and entry["preparationTarget"] not in entry[
                    "preparationMissing"]:
                raise ValueError(f"Preparation target already installed: {course_id(entry)}")
    return payload


def encoded_scene_key(encoder, observation):
    state, candidates = encoder.encode(observation)
    return hashlib.sha256(state.numpy().tobytes() + candidates.numpy().tobytes()).hexdigest()


def validate_preparation(client, entry):
    """Validate the actual takeover decision, not a stored metadata claim."""
    observation = client.request(op="restore", snapshot=entry["snapshot"])["observation"]
    if observation is None or observation["node"] != "SOURCE":
        raise ValueError(f"Preparation is not a source decision: {course_id(entry)}")
    template = BY_KEY[entry["template"]]
    target, missing = teaching_target(template, observation, entry["snapshot"]["state"])
    if (target != entry["preparationTarget"] or
            set(missing) != set(entry["preparationMissing"]) or
            not first._source(observation, target) or
            first._source(observation, target)["id"] != entry["preparationCandidateId"] or
            (template.key != "U1" and not missing)):
        raise ValueError(f"Preparation lesson is unavailable or already installed: {course_id(entry)}")
    return observation


def generation_summary(pool):
    rows = {}
    for template in TEMPLATES:
        starts = [e for e in pool["entries"] if e["template"] == template.key and
                  e["layer"] == "payoff"]
        def distinct(key):
            return len({json.dumps(key(e["snapshot"]["state"]), sort_keys=True)
                        for e in starts})
        rows[template.key] = {"seeds": len(starts),
            "trainSeeds": sum(e["split"] == "train" for e in starts),
            "evaluationSeeds": sum(e["split"] == "evaluation" for e in starts),
            "strategicScenes": len({e["strategicSceneSha256"] for e in starts}),
            "unitLayouts": distinct(lambda s: sorted((u["country"],u["type"],u["regionId"])
                                                   for u in s["units"])),
            "resourceLayouts": distinct(lambda s: {seat: sorted(c["definitionId"]
                for c in deck["hand"]) for seat, deck in s["decks"].items()}),
            "statusLayouts": distinct(lambda s: {seat: sorted(c["definitionId"] for c in
                deck["active"] + deck["faceDown"]) for seat,deck in s["decks"].items()}),
            "rounds": sorted({e["snapshot"]["state"]["round"] for e in starts}),
            "preparationRounds": sorted({e["snapshot"]["state"]["round"] for e in
                pool["entries"] if e["template"] == template.key and
                e["layer"] == "preparation"})}
    return {"entries": len(pool["entries"]), "failedAttempts": len(pool["failures"]),
            "templates": rows}


def write_pool(path, identity, entries, failures, *, complete=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(temporary, "wt", encoding="utf-8", compresslevel=6) as stream:
        json.dump({"identity": identity, "entries": entries, "failures": failures,
                   "complete": complete},
                  stream, ensure_ascii=False, separators=(",", ":"))
    os.replace(temporary, path)


def add_two_missing_preparations(client, entries):
    """Extract a few earlier legal trace prefixes from two-card courses.

    These share the payoff trajectory and its train/evaluation split; they
    add preparation contexts, not independent source games.
    """
    added = []
    for payoff in list(entries):
        if (payoff["layer"] != "payoff" or payoff["variant"] != "positive" or
                payoff["template"] not in ("G2", "G3", "J2")):
            continue
        suffix = f"{payoff['template']}:positive:preparation:{payoff['seed']}:both"
        if any(item.get("courseId") == suffix for item in entries):
            continue
        template = BY_KEY[payoff["template"]]
        observation = client.request(op="reset", seed=payoff["seed"], mode="A",
                                     cardSet="signals")["observation"]
        candidates = []
        for offset, step in enumerate(payoff["trace"]):
            if (observation is not None and observation["activeSeat"] == template.owner and
                    observation["node"] == "SOURCE" and
                    (template.owner != "germany" or observation["round"] >= 2)):
                snapshot = client.request(op="snapshot")["snapshot"]
                state = snapshot["state"]
                missing = [card for card in template.cards if not first._installed(
                    state, template.owner, card)]
                close = (_near(template, observation, state, "positive") or
                    template.key == "G3" and observation["round"] >= 2)
                decision_limit = 120 if template.key == "G3" else 80
                round_limit = 6 if template.key == "G3" else 4
                if (len(missing) == len(template.cards) and close and
                        len(payoff["trace"]) - offset <= decision_limit and
                        payoff["snapshot"]["state"]["round"] - observation["round"] <= round_limit):
                    candidates.append((offset, snapshot))
            observation = client.request(op="step", action={**observation["decision"],
                "actionId": step["actionId"]})["observation"]
        if not candidates:
            continue
        offset, snapshot = candidates[-1]
        extra = {**payoff, "layer": "preparation", "courseId": suffix,
            "snapshot": snapshot, "trace": payoff["trace"][:offset],
            "preparationMissing": list(template.cards),
            "preparationTarget": teaching_target(template,
                client.request(op="restore", snapshot=snapshot)["observation"],
                snapshot["state"])[0],
            "controlRole": "verified_positive",
            "auxiliaryPreparation": "two_states_uninstalled",
            "strategicSceneSha256": _state_signature(snapshot["state"]),
            "distanceDecisionsToPayoff": len(payoff["trace"]) - offset,
            "distanceRoundsToPayoff": payoff["snapshot"]["state"]["round"] -
                snapshot["state"]["round"]}
        first.replay(client, extra)
        obs = client.request(op="restore", snapshot=snapshot)["observation"]
        extra["preparationCandidateId"] = first._source(obs, extra["preparationTarget"])["id"]
        validate_preparation(client, extra)
        added.append(extra)
    entries.extend(added)
    return len(added)


def create_pool(client, encoder, model, device, parent_path: Path, output: Path,
                seed_base=2026100400, train_per_variant=2, eval_per_variant=1,
                attempts_per_start=12, only=None):
    started = time.perf_counter()
    identity = pool_identity(client, hashlib.sha256(parent_path.read_bytes()).hexdigest(),
                             ppo.model_weights_sha256(model))
    from scripts.ppo_combo_accept import probe
    if output.exists():
        with gzip.open(output, "rt", encoding="utf-8") as stream:
            previous = json.load(stream)
        if previous["identity"] != identity or previous.get("complete"):
            raise ValueError("Existing pool is complete or belongs to another frozen identity")
        entries, failures = previous["entries"], previous["failures"]
    else:
        entries, failures = [], []
    for template_index, template in enumerate(TEMPLATES):
        if only and template.key not in only:
            continue
        for variant_index, variant in enumerate(("positive", "control")):
            seen = {e["strategicSceneSha256"] for e in entries if
                    e["template"] == template.key and e["variant"] == variant and
                    e["layer"] == "payoff"}
            for slot in range(train_per_variant + eval_per_variant):
                split = "train" if slot < train_per_variant else "evaluation"
                if any(e["template"] == template.key and e["variant"] == variant and
                       e["split"] == split and e["layer"] == "payoff" and
                       e.get("poolSlot") == slot for e in entries):
                    continue
                found = None
                for attempt in range(attempts_per_start):
                    offset = (200 + attempt - 20 if slot == 0 and attempt >= 20 else
                              slot * 20 + attempt)
                    seed = seed_base + template_index * 1000 + variant_index * 100 + offset
                    if any(f.get("seed") == seed and f.get("template") == template.key and
                           f.get("variant") == variant for f in failures):
                        continue
                    salt = 0xC0B0 if template.key == "U2" else 0xC2C2
                    result = generate_one(client, encoder, model, device, template, seed,
                                          variant, rng_salt=salt,
                                          heldout=split == "evaluation")
                    if "failure" in result:
                        failures.append({"template": template.key, "variant": variant,
                            "split": split, "seed": seed, "reason": result["failure"],
                            "decisions": result.get("decisions", 0)})
                        write_pool(output, identity, entries, failures, complete=False)
                        print(json.dumps({"template": template.key, "variant": variant,
                            "split": split, "seed": seed, "failure": result["failure"],
                            "decisions": result.get("decisions", 0)}, ensure_ascii=False), flush=True)
                        continue
                    if variant == "positive":
                        feasible = probe(client, {**result, "layer": "payoff"},
                                         combo_telemetry=True)
                        if (feasible["goalsCompleted"] != feasible["goalsTotal"] or
                                not _specified_chain({**result, "layer": "payoff"}, feasible)):
                            failures.append({"template": template.key, "variant": variant,
                                "split": split, "seed": seed, "reason": "payoff_chain_blocked",
                                "completed": feasible["goalsCompleted"],
                                "required": feasible["goalsTotal"]})
                            write_pool(output, identity, entries, failures, complete=False)
                            print(json.dumps({"template": template.key, "variant": variant,
                                "split": split, "seed": seed, "failure": "payoff_chain_blocked",
                                "completed": feasible["goalsCompleted"],
                                "required": feasible["goalsTotal"]}, ensure_ascii=False), flush=True)
                            continue
                    signature = _state_signature(result["snapshot"]["state"])
                    if signature in seen:
                        failures.append({"template": template.key, "variant": variant,
                            "split": split, "seed": seed, "reason": "duplicate_strategic_scene"})
                        write_pool(output, identity, entries, failures, complete=False)
                        continue
                    seen.add(signature)
                    found = result
                    break
                if found is None:
                    failures.append({"template": template.key, "variant": variant,
                        "split": split, "reason": "attempt_budget_exhausted", "attempts": attempts_per_start})
                    continue
                for layer, snapshot, trace in (
                    ("payoff", found["snapshot"], found["trace"]),
                    ("preparation", found["preparation"]["snapshot"],
                     found["trace"][:found["preparation"]["traceLength"]])):
                    entry = {"template": template.key, "variant": variant, "layer": layer,
                        "split": split, "poolSlot": slot, "seed": found["seed"], "snapshot": snapshot,
                        "policyRngSalt": salt,
                        "trace": trace, "generationSeconds": found["generatedSeconds"],
                        "strategicSceneSha256": _state_signature(snapshot["state"]),
                        "preparationMissing": found["preparation"]["missing"],
                        "preparationTarget": found["preparation"]["target"],
                        "preparationCandidateId": found["preparation"]["candidateId"],
                        "controlRole": classify_control(template, variant),
                        "distanceDecisionsToPayoff": len(found["trace"]) -
                            found["preparation"]["traceLength"],
                        "distanceRoundsToPayoff": found["snapshot"]["state"]["round"] -
                            found["preparation"]["round"]}
                    entry["courseId"] = ":".join((template.key, variant, layer, str(found["seed"])))
                    first.replay(client, entry)
                    if layer == "preparation":
                        obs = validate_preparation(client, entry)
                        entry["encodedSceneSha256"] = encoded_scene_key(encoder, obs)
                    entries.append(entry)
                write_pool(output, identity, entries, failures, complete=False)
                print(json.dumps({"template": template.key, "variant": variant,
                    "split": split, "seed": found["seed"], "startRound": found["snapshot"]["state"]["round"],
                    "prepRound": found["preparation"]["round"]}, ensure_ascii=False), flush=True)
    expected = len([item for item in TEMPLATES if not only or item.key in only]) * 2 * (
        train_per_variant + eval_per_variant) * 2
    generated = sum(e["template"] in (only or BY_KEY) and
                    not e.get("auxiliaryPreparation") for e in entries)
    if generated != expected:
        write_pool(output, identity, entries, failures, complete=False)
        raise RuntimeError(json.dumps({"generated": generated, "required": expected,
            "failuresByReason": {reason: sum(f.get("reason") == reason for f in failures)
                                 for reason in {f.get("reason") for f in failures}}},
            ensure_ascii=False))
    auxiliary = add_two_missing_preparations(client, entries) if only is None else 0
    # A template-only diagnostic run is not a complete nine-template training
    # pool even when every requested diagnostic slot has been generated.
    write_pool(output, identity, entries, failures, complete=only is None)
    return {"path": str(output), "identity": identity, "entries": len(entries),
            "twoMissingPreparationEntries": auxiliary,
            "failures": len(failures), "bytes": output.stat().st_size,
            "generationSeconds": time.perf_counter() - started,
            "distinctStrategicScenesByTemplate": {template.key: len({e["strategicSceneSha256"]
                for e in entries if e["template"] == template.key and e["layer"] == "payoff"})
                for template in TEMPLATES if not only or template.key in only},
            "failureReasons": {reason: sum(f.get("reason") == reason for f in failures)
                               for reason in {f.get("reason") for f in failures}}}


def main():
    from scripts.ppo_combo_course import load_parent
    parser = argparse.ArgumentParser(description="Generate legal A2S1C2 starts; never starts PPO")
    parser.add_argument("--parent", type=Path, default=ppo.ROOT / "PPO训练" /
                        ".state" / "A2S1C1" / "latest.pt")
    parser.add_argument("--generator", type=Path, default=ppo.ROOT / "PPO训练" /
                        ".state" / "A2S1C1" / "initial.pt")
    parser.add_argument("--output", type=Path, default=ppo.ROOT / "PPO训练" /
                        ".state" / "A2S1C2" / "course-pool-v8.json.gz")
    parser.add_argument("--train-per-variant", type=int, default=2)
    parser.add_argument("--eval-per-variant", type=int, default=1)
    parser.add_argument("--attempts", type=int, default=12)
    parser.add_argument("--only", nargs="*", choices=list(BY_KEY))
    args = parser.parse_args()
    if args.attempts < 1 or args.train_per_variant < 1 or args.eval_per_variant < 1:
        parser.error("Finite positive budgets are required")
    torch.set_num_threads(2)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        model, _ = load_parent(args.generator, encoder, device)
        result = create_pool(client, encoder, model, device, args.parent,
            args.output, train_per_variant=args.train_per_variant,
            eval_per_variant=args.eval_per_variant, attempts_per_start=args.attempts,
            only=set(args.only) if args.only else None)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        client.close()


if __name__ == "__main__":
    main()
