"""Bounded G1/U4/J1 demonstration study; never creates PPO samples.

The three-way split and all learning limits are frozen in the adjacent JSON
before collection.  This module only reads the reviewed C2 start and writes
to a new, isolated experiment directory.
"""
from __future__ import annotations

import argparse
import collections
import copy
import gzip
import hashlib
import json
import math
import os
import random
import statistics
import time
from pathlib import Path

import torch
import torch.nn.functional as F

from scripts import ppo_train as ppo
from scripts import ppo_combo_bc as bc
from scripts import ppo_combo_course as first
from scripts import ppo_combo_course_v2 as course
from scripts.ppo_combo_accept import probe
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network

HERE = Path(__file__).resolve().parent.parent
BASE = HERE / "PPO训练" / ".state" / "A2S1C2"
ROOT = HERE / "PPO训练" / ".state" / "A2S1C2-G1-U4-J1-diagnostic-v1"
PLAN = HERE / "docs" / "training" / "A2S1C2-G1-U4-J1-有界实验预登记.json"
BASE_FILE_SHA = "deb92fd9960c92ff7ba13bcbc1ef871c36da36347c76a879cb0fcc441d39e885"
BASE_WEIGHT_SHA = "94135ecfb2f0b4f066163cc605120ce9716cd310b56796e8a2d9b0f7666f7693"
TARGETS = {"G1": "special_136", "U4": "special_84", "J1": "special_199"}
OWNERS = {"G1": "germany", "U4": "united_states", "J1": "japan"}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def atomic_new_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise FileExistsError(path)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_new_torch(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise FileExistsError(path)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    try:
        torch.save(value, temporary)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def open_models(encoder):
    source = BASE / "initial.pt"
    if digest(source) != BASE_FILE_SHA:
        raise ValueError("Reviewed C2 initial.pt file hash differs")
    saved = torch.load(source, map_location="cpu", weights_only=False)
    if (saved.get("weightsSha256") != BASE_WEIGHT_SHA or
            saved.get("networkArchitecture") != A2S1_ADAPTER or
            saved.get("rewardConfig") != ppo.reward_config("signals") or
            saved.get("network") != {"stateDim": encoder.state_dim,
                                     "candidateDim": encoder.candidate_dim}):
        raise ValueError("Reviewed C2 model identity or semantic configuration differs")
    baseline = make_network(A2S1_ADAPTER, encoder)
    baseline.load_state_dict(saved["modelState"], strict=True)
    if ppo.model_weights_sha256(baseline) != BASE_WEIGHT_SHA:
        raise ValueError("C2 weight hash differs after reload")
    previous = torch.load(BASE / "pre-demonstration.pt", map_location="cpu",
                          weights_only=False)
    before = make_network(A2S1_ADAPTER, encoder)
    before.load_state_dict(previous["modelState"], strict=True)
    if ppo.model_weights_sha256(before) != previous["weightsSha256"]:
        raise ValueError("Previous demonstration baseline weights differ")
    baseline.eval(), before.eval()
    return baseline, before, {"initialFileSha256": digest(source),
        "initialWeightsSha256": BASE_WEIGHT_SHA,
        "preDemonstrationFileSha256": digest(BASE / "pre-demonstration.pt"),
        "preDemonstrationWeightsSha256": previous["weightsSha256"]}


def installed(state, seat, card):
    return any(item["definitionId"] == card for item in
               state["decks"][seat]["active"] + state["decks"][seat]["faceDown"])


def units(state, country, kind, region):
    return any(u["country"] == country and u["type"] == kind and
               u["regionId"] == region for u in state["units"])


def facts(state, seat):
    regions = ("eastern_europe", "ukraine", "eastern_china", "sea_east_china",
               "sea_north_atlantic", "sea_north_sea")
    return {"round": state["round"], "seat": seat,
        "units": sorted((u["country"], u["type"], u["regionId"])
                        for u in state["units"] if u["regionId"] in regions),
        "installed": {owner: sorted(c["definitionId"] for c in
            state["decks"][owner]["active"] + state["decks"][owner]["faceDown"])
            for owner in ("germany", "united_states", "japan")},
        "available": {owner: collections.Counter(c["definitionId"] for c in
            state["decks"][owner]["hand"]) for owner in
            ("germany", "united_states", "japan")}}


def classify_retention(observation, state):
    """Game-fact categories registered before measuring KL or training.

    Keep only clearly unrelated SOURCE decisions. Ambiguous preparations are
    diagnostic-only; a route-control tag by itself says nothing about value.
    """
    if observation["node"] != "SOURCE":
        return "unclear", "non_source_decision"
    seat = observation["decisionSeat"]
    choices = {c.get("definitionId") for c in observation["candidates"]}
    if seat == "germany" and "special_136" in choices and not installed(
            state, seat, "special_136"):
        if (state["round"] >= 2 and units(state, seat, "army", "eastern_europe")
                and units(state, "soviet_union", "army", "ukraine")):
            return "teaching", "german_east_front_attack_and_build_route"
        return "unclear", "german_status_future_value_not_proven"
    if seat == "united_states" and "special_84" in choices and not installed(
            state, seat, "special_84"):
        if state["round"] == 1:
            return "teaching", "american_first_turn_shipyard_route"
        return "unclear", "american_shipyard_future_value_not_proven"
    if seat == "japan" and "special_199" in choices and not installed(
            state, seat, "special_199"):
        if (units(state, "china", "army", "eastern_china") and
                (units(state, seat, "navy", "sea_east_china") or
                 bool(first._source(observation, "build_navy", "sea_east_china")))):
            return "teaching", "japanese_china_attack_and_response_route"
        return "unclear", "japanese_response_future_value_not_proven"
    if seat in ("united_kingdom", "italy", "soviet_union"):
        return "preserve", "unrelated_country_basic_policy"
    return "unclear", "possible_shared_mechanism_or_delayed_value"


def policy(model, item):
    model.eval()
    with torch.inference_mode():
        logits, value = bc._forward(model, item)
        return logits.softmax(-1).cpu(), float(value)


def describe_shift(before, after, observation, count=5):
    old, _ = policy(before, observation)
    new, _ = policy(after, observation)
    diffs = (new - old).abs().topk(min(count, len(old))).indices.tolist()
    candidates = observation["rawCandidates"]
    return [{"cardId": candidates[i].get("definitionId"),
             "kind": candidates[i].get("kind"), "before": float(old[i]),
             "after": float(new[i])} for i in diffs]


def _encoded(encoder, observation, selected=None, metadata=None):
    state, candidates = encoder.encode(observation)
    sample = {"state": state, "candidates": candidates,
              "metadata": metadata or {}, "rawCandidates": observation["candidates"]}
    if selected is not None:
        sample["chosen"] = next(i for i, action in enumerate(observation["candidates"])
                                if action["id"] == selected)
        selected_card = observation["candidates"][sample["chosen"]].get("definitionId")
        sample["sameCardIndices"] = [i for i, action in enumerate(observation["candidates"])
             if selected_card and action.get("definitionId") == selected_card]
    return sample


def _kl(old, new):
    return float((old * (old.clamp_min(1e-30).log() -
                         new.clamp_min(1e-30).log())).sum())


def diagnose_old_retention(client, encoder, before, baseline, old_entries):
    """Read-only C2 retention audit, before new sample selection."""
    rows = []
    for entry in old_entries:
        if (entry["layer"] != "payoff" or entry["split"] != "train" or
                entry["variant"] != "control"):
            continue
        observation = client.request(op="reset", seed=entry["seed"], mode="A",
                                     cardSet="signals")["observation"]
        for offset, step in enumerate(entry["trace"]):
            if observation["node"] == "SOURCE" and any(
                    c.get("definitionId") in bc.TEACHING_TARGETS.values()
                    for c in observation["candidates"]):
                snapshot = client.request(op="snapshot")["snapshot"]
                category, reason = classify_retention(observation, snapshot["state"])
                sample = _encoded(encoder, observation)
                old_p, old_v = policy(before, sample)
                new_p, new_v = policy(baseline, sample)
                rows.append({"courseId": course.course_id(entry), "offset": offset,
                    "decisionId": observation["decision"]["decisionId"],
                    "category": category, "reason": reason,
                    "kl": _kl(old_p, new_p), "valueShift": abs(new_v-old_v),
                    "gameFacts": facts(snapshot["state"], observation["decisionSeat"]),
                    "topActionChanges": describe_shift(before, baseline, sample)})
            observation = client.request(op="step", action={**observation["decision"],
                "actionId": step["actionId"]})["observation"]
        if client.request(op="snapshot")["snapshot"]["state"] != entry[
                "snapshot"]["state"]:
            raise ValueError("Old C2 retention trace diverged")
    rows.sort(key=lambda row: row["kl"], reverse=True)
    return {"format": "three-course-retention-audit-v1",
        "comparison": "pre-demonstration-versus-reviewed-C2-initial",
        "counts": dict(collections.Counter(r["category"] for r in rows)),
        "topKl": rows[:15], "allScenes": rows}


def strategic_key(state):
    """Tactical dedupe ignores card order/IDs and irrelevant deck sequence."""
    important = {"special_136", "special_137", "special_84", "special_199",
                 "build_army", "land_battle", "build_navy", "sea_battle"}
    payload = {"round": state["round"], "active": state["activeSeat"],
        "units": sorted((u["country"], u["type"], u["regionId"])
                        for u in state["units"]),
        "statuses": {seat: sorted(c["definitionId"] for c in deck["active"] +
            deck["faceDown"]) for seat, deck in state["decks"].items()},
        "keyResources": {seat: sorted(c["definitionId"] for c in deck["hand"]
            if c["definitionId"] in important) for seat, deck in state["decks"].items()}}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def near_tactical_key(state):
    """Conservative cross-split check ignoring resource/card-order differences."""
    payload = {"round": state["round"], "seat": state["activeSeat"],
        "units": sorted((u["country"], u["type"], u["regionId"])
                        for u in state["units"]),
        "installed": {seat: sorted(c["definitionId"] for c in deck["active"] +
            deck["faceDown"]) for seat, deck in state["decks"].items()}}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def exclude_near_split_overlap(entries):
    accepted_seeds, seen, excluded = set(), {}, []
    for split in ("train", "validation", "final_test"):
        for entry in entries:
            if entry["split"] != split or entry["layer"] != "preparation":
                continue
            key = (entry["template"], near_tactical_key(entry["snapshot"]["state"]))
            previous = seen.get(key)
            if previous and previous["split"] != split:
                excluded.append({"template": entry["template"], "seed": entry["seed"],
                    "split": split, "nearDuplicateOfSeed": previous["seed"],
                    "nearDuplicateOfSplit": previous["split"],
                    "reason": "same_round_board_and_installed_states"})
                continue
            seen[key] = entry
            accepted_seeds.add((entry["template"], entry["seed"]))
    return [entry for entry in entries if (entry["template"], entry["seed"])
            in accepted_seeds], excluded


def split_for_index(index, planned):
    for split in ("train", "validation", "final_test"):
        if index < planned[split]:
            return split
        index -= planned[split]
    raise IndexError(index)


def _entry_pair(result, template, split, slot, encoder, client, heldout_region):
    common = {"template": template, "variant": "positive", "split": split,
        "poolSlot": slot, "seed": result["seed"], "policyRngSalt": 0xC2C2,
        "generationSeconds": result["generatedSeconds"],
        "heldoutRegion": heldout_region, "controlRole": "verified_positive",
        "preparationMissing": result["preparation"]["missing"],
        "preparationTarget": result["preparation"]["target"],
        "preparationCandidateId": result["preparation"]["candidateId"],
        "distanceDecisionsToPayoff": len(result["trace"]) -
            result["preparation"]["traceLength"],
        "distanceRoundsToPayoff": result["snapshot"]["state"]["round"] -
            result["preparation"]["round"]}
    entries = []
    for layer, snapshot, trace in (("preparation", result["preparation"]["snapshot"],
                                    result["trace"][:result["preparation"]["traceLength"]]),
                                   ("payoff", result["snapshot"], result["trace"])):
        item = {**common, "layer": layer, "snapshot": snapshot, "trace": trace,
            "courseId": f"{template}:positive:{layer}:{result['seed']}",
            "strategicSceneSha256": strategic_key(snapshot["state"])}
        first.replay(client, item)
        if layer == "preparation":
            observation = course.validate_preparation(client, item)
            item["encodedSceneSha256"] = course.encoded_scene_key(encoder, observation)
        entries.append(item)
    return entries


def generate_pool(client, encoder, generator, plan, output):
    """Finite legal reset/step generation; writes every attempt for diagnosis."""
    if output.exists():
        raise FileExistsError(output)
    begun = time.monotonic()
    selected, attempts = [], []
    seen = {key: set() for key in TARGETS}
    for template_index, key in enumerate(TARGETS):
        spec = plan["generation"]
        planned = spec["targetPerTemplate"]
        slots = sum(planned.values())
        for slot in range(slots):
            split = split_for_index(slot, planned)
            if (sum(row["template"] == key for row in selected if row["layer"] ==
                    "preparation") >= slots):
                break
            found = False
            for attempt in range(spec["maxAttemptsPerSlot"]):
                if time.monotonic() - begun > spec["wallSeconds"]:
                    attempts.append({"template": key, "slot": slot,
                                     "reason": "overall_wall_budget"})
                    break
                seed = spec["seedBase"] + template_index*100000 + slot*100 + attempt
                region = (spec["u4LegalPreludeRegions"][(slot + attempt) % len(
                    spec["u4LegalPreludeRegions"])] if key == "U4" and
                    split != "train" else "eastern_europe")
                try:
                    result = course.generate_one(client, encoder, generator,
                        torch.device("cpu"), course.BY_KEY[key], seed,
                        heldout=key == "U4" and split != "train",
                        heldout_region=region)
                    if "failure" in result:
                        reason = result["failure"]
                    else:
                        entry = {**result, "layer": "payoff",
                                 "courseId": f"{key}:positive:payoff:{seed}"}
                        feasible = probe(client, entry, combo_telemetry=True)
                        if (feasible["goalsCompleted"] != feasible["goalsTotal"] or
                                not course._specified_chain(entry, feasible)):
                            reason = "payoff_not_verified"
                        else:
                            signature = strategic_key(result["preparation"]["snapshot"]["state"])
                            if signature in seen[key]:
                                reason = "duplicate_tactical_scene"
                            else:
                                seen[key].add(signature)
                                selected += _entry_pair(result, key, split, slot,
                                                         encoder, client, region)
                                found = True
                                reason = "accepted"
                except Exception as exc:
                    reason = f"generation_error:{type(exc).__name__}:{str(exc)[:180]}"
                attempts.append({"template": key, "slot": slot, "split": split,
                                 "seed": seed, "reason": reason})
                if found:
                    break
            if not found and time.monotonic() - begun > spec["wallSeconds"]:
                break
    # A split owns its entire seed trace; no near slices migrate to another set.
    seen_seed = {}
    seen_scene = {}
    for entry in selected:
        if entry["layer"] != "preparation":
            continue
        key = (entry["template"], entry["seed"])
        prior = seen_seed.setdefault(key, entry["split"])
        if prior != entry["split"]:
            raise ValueError("A single source trajectory crossed splits")
        scene = (entry["template"], entry["strategicSceneSha256"])
        prior = seen_scene.setdefault(scene, entry["split"])
        if prior != entry["split"]:
            raise ValueError("Near-identical tactical scene crossed splits")
    identity = {"sourceFileSha256": BASE_FILE_SHA,
        "generatorFileSha256": digest(BASE.parent / "A2S1C1" / "initial.pt"),
        "buildFingerprint": client.fingerprint,
        "planSha256": digest(PLAN), "courseGeneratorVersion": course.VERSION,
        "generatorSourceSha256": digest(course.__file__),
        "ruleMode": "A/signals"}
    payload = {"identity": identity, "entries": selected, "attempts": attempts,
        "seconds": time.monotonic()-begun, "complete": True}
    output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output, "wt", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
    return {"fileSha256": digest(output), "entryCount": len(selected),
        "attemptCount": len(attempts), "seconds": payload["seconds"],
        "acceptedByTemplateSplit": dict(collections.Counter(
            f"{e['template']}:{e['split']}" for e in selected if e["layer"] ==
            "preparation")),
        "failures": dict(collections.Counter(a["reason"] for a in attempts if
                                            a["reason"] != "accepted"))}


def read_pool(path, client, plan):
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        data = json.load(stream)
    identity = data["identity"]
    if (not data["complete"] or identity["sourceFileSha256"] != BASE_FILE_SHA or
            identity["planSha256"] != digest(PLAN) or
            identity["generatorSourceSha256"] != digest(course.__file__) or
            identity["buildFingerprint"] != client.fingerprint):
        raise ValueError("Three-course pool identity or completion differs")
    return data


def _samples_for_split(client, encoder, baseline, entries, split):
    payoff = [entry for entry in entries if entry["split"] == split and
              entry["layer"] == "payoff" and entry["variant"] == "positive"]
    for entry in payoff:
        course.validate_preparation(client, next(item for item in entries if
            item["courseId"] == entry["courseId"].replace(":payoff:", ":preparation:")))
    # The reviewed extractor verifies each actual full chain and checks that
    # the scripted preparation really installs/conceals the selected card.
    extraction = [{**entry, "split": "train"} for entry in payoff]
    preparation, _, evidence = bc.extract(client, encoder, baseline, extraction)
    preparation = [sample for sample in preparation if sample["metadata"]["cardId"]
                   in TARGETS.values()]
    payoff_labels = []
    for entry in payoff:
        feasibility = probe(client, entry, combo_telemetry=True)
        if (feasibility["goalsCompleted"] != feasibility["goalsTotal"] or
                not course._specified_chain(entry, feasibility)):
            raise ValueError(f"Payoff chain no longer verifies: {entry['courseId']}")
        observation = client.request(op="restore", snapshot=entry["snapshot"],
                                     comboTelemetry=True)["observation"]
        for offset, step in enumerate(feasibility["steps"]):
            chosen = step.get("chosen")
            if chosen and step.get("matched"):
                if chosen["id"] not in {c["id"] for c in observation["candidates"]}:
                    raise ValueError("Payoff demo candidate differs from restored decision")
                if len(observation["candidates"]) > 1:
                    payoff_labels.append(bc._sample(baseline, encoder, observation,
                        chosen["id"], {"courseId": entry["courseId"],
                        "decisionId": observation["decision"]["decisionId"],
                        "traceOffset": offset, "cardId": TARGETS[entry["template"]],
                        "goal": step["goal"], "labelType": "verified_payoff_choice"}))
            if chosen:
                observation = client.request(op="step", action={**observation["decision"],
                    "actionId": chosen["id"]}, comboTelemetry=True)["observation"]
    for sample in preparation:
        sample["metadata"]["labelType"] = "verified_preparation"
    expected = set(TARGETS)
    present = {item["metadata"]["courseId"].split(":", 1)[0]
               for item in preparation}
    return preparation, payoff_labels, {"preparationByTemplate": dict(
        collections.Counter(item["metadata"]["courseId"].split(":", 1)[0]
                            for item in preparation)),
        "payoffByTemplate": dict(collections.Counter(item["metadata"]["courseId"].split(
            ":", 1)[0] for item in payoff_labels)),
        "verifiedPayoffs": evidence["verifiedPayoffs"],
        "missingPreparationTemplates": sorted(expected - present),
        "uniqueEncodedPreparationScenes": len({bc.scene_key(item) for item in preparation})}


def _preservation_scenes(client, encoder, baseline, plan):
    """Normal openings from frozen policy, unrelated countries only."""
    samples, diagnostic = [], []
    for seed in plan["retention"]["unrelatedNormalOpeningSeeds"]:
        observation = client.request(op="reset", seed=seed, mode="A",
                                     cardSet="signals")["observation"]
        seen = set()
        for _ in range(180):
            if observation is None or len(seen) == 3:
                break
            if (observation["node"] == "SOURCE" and
                    observation["decisionSeat"] in
                    ("united_kingdom", "italy", "soviet_union") and
                    observation["decisionSeat"] not in seen):
                seen.add(observation["decisionSeat"])
                snapshot = client.request(op="snapshot")["snapshot"]
                category, reason = classify_retention(observation, snapshot["state"])
                if category != "preserve":
                    raise ValueError("Unrelated country was not classified as preservation")
                selected = next((c for c in observation["candidates"] if c["kind"] ==
                                 "pass"), observation["candidates"][0])
                sample = bc._sample(baseline, encoder, observation, selected["id"],
                    {"seed": seed, "seat": observation["decisionSeat"],
                     "reason": reason, "scene": facts(snapshot["state"],
                                                      observation["decisionSeat"])})
                samples.append(sample)
                diagnostic.append({"seed": seed, "seat": observation["decisionSeat"],
                                   "reason": reason})
            state, actions = encoder.encode(observation)
            index, _, _ = ppo.select_action(baseline, state, actions,
                torch.device("cpu"), deterministic=True)
            chosen = observation["candidates"][index]
            observation = client.request(op="step", action={**observation["decision"],
                "actionId": chosen["id"]})["observation"]
    return samples, diagnostic


def _nll(model, samples):
    if not samples:
        return None
    model.eval()
    with torch.inference_mode():
        values = []
        for item, logits, _ in bc._forward_many(model, samples):
            values.append(float(-logits.log_softmax(-1)[item["chosen"]]))
    return sum(values) / len(values)


def _retention(model, controls):
    model.eval()
    kls, value_shifts = [], []
    with torch.inference_mode():
        for item, logits, value in bc._forward_many(model, controls):
            kls.append(_kl(item["teacher"], logits.softmax(-1)))
            value_shifts.append(abs(float(value - item["teacherValue"])))
    return {"maxKl": max(kls, default=0),
            "maxValueShift": max(value_shifts, default=0),
            "meanKl": statistics.fmean(kls) if kls else 0,
            "count": len(controls)}


def _balanced(groups, rng):
    chosen = []
    for template in TARGETS:
        relevant = groups.get(template, [])
        if relevant:
            chosen.append(rng.choice(relevant))
    return chosen


def _by_template(samples):
    return {key: [item for item in samples if item["metadata"]["courseId"].split(
        ":", 1)[0] == key] for key in TARGETS}


def _weighted_nll(preparation, payoff):
    return .8 * preparation + .2 * payoff if payoff is not None else preparation


def learn_bounded(baseline, preparation, payoff, validation_preparation,
                  validation_payoff, controls, cfg):
    """One preregistered Adam run; validation only stops, final test unused."""
    if any(not _by_template(preparation)[key] for key in TARGETS):
        raise ValueError("Each template needs a verified preparation label")
    if bc.validate_supervision(preparation + payoff, controls)["routeOverlap"]:
        raise ValueError("Teaching tensor cannot also be a preservation tensor")
    model = copy.deepcopy(baseline)
    optimizer = torch.optim.Adam(model.parameters(), lr=cfg["learningRate"])
    rng = random.Random(cfg["trainSeed"])
    prep_groups, payoff_groups = _by_template(preparation), _by_template(payoff)
    original_weights = bc._weights(baseline)
    history, best = [], None
    best_order, best_weights, best_step = None, None, None
    best_validation, plateau = math.inf, 0
    stop_reason, stop_step = "step_budget", cfg["maxSteps"]
    start = time.perf_counter()
    for step in range(1, cfg["maxSteps"] + 1):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        chosen_prep = _balanced(prep_groups, rng)
        chosen_payoff = _balanced(payoff_groups, rng)
        prep_loss = torch.stack([-bc._forward(model, sample)[0].log_softmax(
            -1)[sample["chosen"]] for sample in chosen_prep]).mean()
        if chosen_payoff:
            payoff_loss = torch.stack([-bc._forward(model, sample)[0].log_softmax(
                -1)[sample["chosen"]] for sample in chosen_payoff]).mean()
        else:
            payoff_loss = prep_loss * 0
        selected_keep = rng.sample(controls, min(6, len(controls)))
        kl_terms, value_terms = [], []
        for item in selected_keep:
            logits, value = bc._forward(model, item)
            teacher = item["teacher"]
            kl_terms.append((teacher * (teacher.clamp_min(1e-30).log() -
                            logits.log_softmax(-1))).sum())
            value_terms.append(F.mse_loss(value, item["teacherValue"]))
        kl_loss = torch.stack(kl_terms).mean() if kl_terms else prep_loss * 0
        value_loss = torch.stack(value_terms).mean() if value_terms else prep_loss * 0
        loss = (cfg["preparationWeight"] * prep_loss +
                cfg["payoffWeight"] * payoff_loss +
                cfg["retentionKlWeight"] * kl_loss +
                cfg["retentionValueWeight"] * value_loss)
        if not bool(torch.isfinite(loss)):
            stop_reason, stop_step = "nonfinite_loss", step
            break
        loss.backward()
        if any(p.grad is not None and not bool(torch.isfinite(p.grad).all())
               for p in model.parameters()):
            stop_reason, stop_step = "nonfinite_gradient", step
            break
        torch.nn.utils.clip_grad_norm_(model.parameters(), .5)
        optimizer.step()
        if not bc._finite_parameters(model):
            stop_reason, stop_step = "nonfinite_parameters", step
            break
        if step % cfg["checkEverySteps"]:
            continue
        train_prep = _nll(model, preparation)
        train_payoff = _nll(model, payoff)
        valid_prep = _nll(model, validation_preparation)
        valid_payoff = _nll(model, validation_payoff)
        measured = _retention(model, controls)
        record = {"step": step, "trainPreparationNll": train_prep,
            "trainPayoffNll": train_payoff,
            "validationPreparationNll": valid_prep,
            "validationPayoffNll": valid_payoff, **measured}
        record["compliant"] = (measured["maxKl"] <= cfg["maxKl"] and
                               measured["maxValueShift"] <= cfg["maxValueShift"] and
                               bc._finite(record))
        history.append(record)
        if not record["compliant"]:
            stop_reason, stop_step = "retention_limit_or_nonfinite", step
            break
        order = (_weighted_nll(train_prep, train_payoff), measured["maxKl"], step)
        if best_order is None or order < best_order:
            best_order, best_weights, best_step, best = order, bc._weights(model), step, record
        validation_nll = _weighted_nll(valid_prep, valid_payoff)
        if validation_nll < best_validation - 1e-5:
            best_validation, plateau = validation_nll, 0
        else:
            plateau += 1
            if plateau >= cfg["validationPlateauChecks"]:
                stop_reason, stop_step = "validation_plateau", step
                break
    del optimizer
    model.load_state_dict(best_weights if best_weights is not None else original_weights,
                          strict=True)
    final_retention = _retention(model, controls)
    if (final_retention["maxKl"] > cfg["maxKl"] or
            final_retention["maxValueShift"] > cfg["maxValueShift"]):
        raise ValueError("Rollback candidate violates original-baseline constraint")
    return model, {"stopReason": stop_reason, "stopStep": stop_step,
        "selectedStep": best_step, "selectedMetrics": best,
        "history": history, "afterRollbackRetention": final_retention,
        "seconds": time.perf_counter()-start, "rolledBack": best_step != stop_step,
        "selectionRule": cfg["selection"], "finalTestUsedForSelection": False,
        "parentWasNotACompliantImprovement": best_step is None}


def _probability_rows(client, encoder, baseline, candidate, entries, split):
    rows = []
    for entry in entries:
        if (entry["split"] != split or entry["layer"] != "preparation" or
                entry["variant"] != "positive"):
            continue
        observation = course.validate_preparation(client, entry)
        target = TARGETS[entry["template"]]
        candidates = [i for i, action in enumerate(observation["candidates"])
                      if action.get("definitionId") == target]
        specific = next(i for i, action in enumerate(observation["candidates"])
                        if action["id"] == entry["preparationCandidateId"])
        item = _encoded(encoder, observation)
        before, old_value = policy(baseline, item)
        after, new_value = policy(candidate, item)
        rows.append({"template": entry["template"], "split": split,
            "seed": entry["seed"], "courseId": entry["courseId"],
            "candidateCount": len(observation["candidates"]),
            "sameCardCandidates": len(candidates),
            "beforeCardProbability": sum(float(before[i]) for i in candidates),
            "afterCardProbability": sum(float(after[i]) for i in candidates),
            "beforeSpecificProbability": float(before[specific]),
            "afterSpecificProbability": float(after[specific]),
            "beforeRank": 1 + sum(bool(before[i] > before[specific]) for i in range(len(before))),
            "afterRank": 1 + sum(bool(after[i] > after[specific]) for i in range(len(after))),
            "beforeValue": old_value, "afterValue": new_value,
            "round": observation["round"],
            "distanceDecisionsToPayoff": entry["distanceDecisionsToPayoff"],
            "distanceRoundsToPayoff": entry["distanceRoundsToPayoff"]})
    return rows


def summarize_probabilities(rows, target_probability=.1):
    summary = {}
    for template in TARGETS:
        related = [row for row in rows if row["template"] == template]
        if not related:
            summary[template] = {"count": 0}
            continue
        summary[template] = {"count": len(related),
            "beforeMedian": statistics.median(r["beforeSpecificProbability"] for r in related),
            "afterMedian": statistics.median(r["afterSpecificProbability"] for r in related),
            "afterMin": min(r["afterSpecificProbability"] for r in related),
            "afterAtLeastTenPercent": sum(r["afterSpecificProbability"] >=
                target_probability for r in related),
            "beforeCardMedian": statistics.median(r["beforeCardProbability"] for r in related),
            "afterCardMedian": statistics.median(r["afterCardProbability"] for r in related),
            "afterMedianRank": statistics.median(r["afterRank"] for r in related)}
    return summary


def _rollout(client, encoder, model, entry, stochastic, seed, max_decisions):
    from scripts.ppo_combo_metrics import new_tracker, record_step, summarize
    rng = random.Random(seed)
    observation = client.request(op="restore", snapshot=entry["snapshot"],
                                 comboTelemetry=True)["observation"]
    tracker = new_tracker(course.course_id(entry), entry["snapshot"])
    decisions = 0
    preparation_selected = trigger_selected = False
    actual_result = None
    for offset in range(max_decisions):
        if observation is None:
            break
        encoded, candidates = encoder.encode(observation)
        index, _, _ = ppo.select_action(model, encoded, candidates,
            torch.device("cpu"), rng=rng, deterministic=not stochastic)
        chosen = observation["candidates"][index]
        if observation["node"] == "SOURCE" and chosen.get("definitionId") == TARGETS[
                entry["template"]]:
            preparation_selected = True
        if any(feature.get("kind") == "trigger" and feature.get("definitionId") ==
               TARGETS[entry["template"]] for feature in chosen.get("choices") or ()):
            trigger_selected = True
        result = client.request(op="step", action={**observation["decision"],
            "actionId": chosen["id"]}, comboTelemetry=True)
        record_step(tracker, result.get("comboTelemetry"), offset)
        decisions += 1
        observation = result["observation"]
        actual_result = result.get("result")
        if actual_result is not None:
            break
    summary = summarize(tracker, actual_result or {"winner": "allies",
        "allianceScores": {"axis": 0, "allies": 0}})
    achieved = summary.get("specifiedComboAchieved") is True
    reason = ("complete" if achieved else
              "preparation_not_chosen" if entry["layer"] == "preparation" and
              not preparation_selected else
              "optional_trigger_not_chosen" if not trigger_selected else
              "unresolved_or_changed_conditions")
    return {"template": entry["template"], "layer": entry["layer"],
        "seed": entry["seed"], "policySeed": seed, "stochastic": stochastic,
        "decisions": decisions, "naturalTerminal": actual_result is not None,
        "preparationChosen": preparation_selected,
        "triggerChosen": trigger_selected, "specifiedComboAchieved": achieved,
        "failureCategory": reason,
        "tacticalResultAchieved": summary.get("tacticalResultAchieved")}


def _normal_opening(client, encoder, model, seeds, max_decisions, stochastic):
    rows = []
    for seed in seeds:
        observation = client.request(op="reset", seed=seed, mode="A",
                                     cardSet="signals")["observation"]
        rng = random.Random(seed ^ 0x71A2)
        prepared = {key: False for key in TARGETS}
        opportunities = collections.Counter()
        for _ in range(max_decisions):
            if observation is None:
                break
            if observation["node"] == "SOURCE":
                for key, target in TARGETS.items():
                    if observation["decisionSeat"] == OWNERS[key] and any(
                            c.get("definitionId") == target for c in observation["candidates"]):
                        opportunities[key] += 1
            encoded, candidates = encoder.encode(observation)
            index, _, _ = ppo.select_action(model, encoded, candidates,
                torch.device("cpu"), rng=rng, deterministic=not stochastic)
            action = observation["candidates"][index]
            if observation["node"] == "SOURCE":
                for key, target in TARGETS.items():
                    if action.get("definitionId") == target:
                        prepared[key] = True
            observation = client.request(op="step", action={**observation["decision"],
                "actionId": action["id"]})["observation"]
        rows.append({"seed": seed, "stochastic": stochastic,
                     "opportunities": dict(opportunities),
                     "prepared": prepared,
                     "maxDecisionLimit": observation is not None})
    return rows


def run_experiment(client, encoder, baseline, plan, source_identity):
    output = ROOT / "course-pool.json.gz"
    data = read_pool(output, client, plan)
    entries, near_exclusions = exclude_near_split_overlap(data["entries"])
    if (ROOT / "candidate.pt").exists() or (ROOT / "experiment-audit.json").exists():
        raise FileExistsError("A completed bounded experiment must never be overwritten")
    split_counts = collections.Counter(f"{e['template']}:{e['split']}" for e in entries
                                       if e["layer"] == "preparation")
    for key in TARGETS:
        for split in ("train", "validation", "final_test"):
            if split_counts[f"{key}:{split}"] < 1:
                atomic_new_json(ROOT / "blocked-insufficient-pool.json", {
                    "reason": "missing_independent_split", "counts": dict(split_counts),
                    "poolSha256": digest(output)})
                raise ValueError(f"No independent {split} start for {key}")
    training_preparation, training_payoff, train_evidence = _samples_for_split(
        client, encoder, baseline, entries, "train")
    validation_preparation, validation_payoff, validation_evidence = _samples_for_split(
        client, encoder, baseline, entries, "validation")
    # Final test is not even encoded until after the candidate is selected.
    training_keys = {bc.scene_key(item) for item in training_preparation}
    validation_overlap = sum(bc.scene_key(item) in training_keys
                             for item in validation_preparation)
    if validation_overlap:
        atomic_new_json(ROOT / "blocked-split-overlap.json", {
            "reason": "identical_encoded_training_and_validation_preparation",
            "count": validation_overlap, "poolSha256": digest(output)})
        raise ValueError("Training and validation encoded preparations overlap")
    controls, retention_evidence = _preservation_scenes(client, encoder, baseline, plan)
    if not controls:
        raise ValueError("No semantically unrelated preservation scenes")
    cfg = plan["learning"]
    model, adaptation = learn_bounded(baseline, training_preparation, training_payoff,
        validation_preparation, validation_payoff, controls, cfg)
    if adaptation["selectedStep"] is None:
        atomic_new_json(ROOT / "failed-no-compliant-candidate.json", {
            "source": source_identity, "poolSha256": digest(output),
            "adaptation": adaptation, "trainEvidence": train_evidence,
            "validationEvidence": validation_evidence})
        return {"selectedStep": None, "stopReason": adaptation["stopReason"]}
    candidate_hash = ppo.model_weights_sha256(model)
    selection = {"source": source_identity, "poolSha256": digest(output),
        "planSha256": digest(PLAN), "selectedStep": adaptation["selectedStep"],
        "candidateWeightsSha256": candidate_hash,
        "selection": adaptation["selectionRule"],
        "selectionDidNotUseFinalTest": True}
    atomic_new_torch(ROOT / "candidate.pt", {"format": "bounded-three-course-bc-v1",
        "sourceExperimentId": "A2S1C2", "sourceFileSha256": BASE_FILE_SHA,
        "sourceWeightsSha256": BASE_WEIGHT_SHA,
        "weightsSha256": candidate_hash, "modelState": bc._weights(model),
        "networkArchitecture": A2S1_ADAPTER,
        "network": {"stateDim": encoder.state_dim,
                    "candidateDim": encoder.candidate_dim},
        "buildFingerprint": client.fingerprint,
        "rewardConfig": ppo.reward_config("signals"),
        "resourceMode": "A", "poolSha256": digest(output),
        "planSha256": digest(PLAN), "selectedStep": adaptation["selectedStep"]})
    loaded = torch.load(ROOT / "candidate.pt", map_location="cpu", weights_only=False)
    reloaded = make_network(A2S1_ADAPTER, encoder)
    reloaded.load_state_dict(loaded["modelState"], strict=True)
    if ppo.model_weights_sha256(reloaded) != candidate_hash:
        raise ValueError("Saved candidate reload differs")
    # The final-test set is accessed only now, after immutable selection.
    final_preparation, final_payoff, final_evidence = _samples_for_split(
        client, encoder, baseline, entries, "final_test")
    test_overlap = sum(bc.scene_key(item) in training_keys or
        bc.scene_key(item) in {bc.scene_key(v) for v in validation_preparation}
        for item in final_preparation)
    probabilities = {}
    for split in ("train", "validation", "final_test"):
        rows = _probability_rows(client, encoder, baseline, reloaded, entries, split)
        probabilities[split] = {"summary": summarize_probabilities(rows,
            plan["evaluation"]["targetNaturalProbability"]), "scenes": rows}
    max_decisions = plan["evaluation"]["autonomousMaxDecisions"]
    rollouts = []
    for entry in entries:
        if (entry["split"] not in ("validation", "final_test") or
                entry["variant"] != "positive"):
            continue
        rollouts.append(_rollout(client, encoder, reloaded, entry, False,
            entry["seed"] ^ 0xA7, max_decisions))
        if entry["split"] == "final_test":
            for offset in range(plan["evaluation"]["stochasticRolloutsPerScene"]):
                rollouts.append(_rollout(client, encoder, reloaded, entry, True,
                    (entry["seed"] << 4) ^ offset ^ 0xB7, max_decisions))
    openings = {"highestProbability": _normal_opening(client, encoder, reloaded,
        plan["evaluation"]["normalOpeningSeeds"],
        plan["evaluation"]["normalOpeningMaxDecisions"], False),
        "stochastic": _normal_opening(client, encoder, reloaded,
        plan["evaluation"]["normalOpeningSeeds"],
        plan["evaluation"]["normalOpeningMaxDecisions"], True)}
    report = {"format": "a2s1c2-three-course-study-v1",
        "source": source_identity, "buildFingerprint": client.fingerprint,
        "planSha256": digest(PLAN), "poolSha256": digest(output),
        "poolCounts": dict(split_counts),
        "nearDuplicateExclusions": near_exclusions,
        "trainEvidence": train_evidence, "validationEvidence": validation_evidence,
        "finalEvidence": final_evidence,
        "labelCounts": {"trainPreparation": len(training_preparation),
            "trainPayoff": len(training_payoff),
            "validationPreparation": len(validation_preparation),
            "validationPayoff": len(validation_payoff),
            "finalPreparation": len(final_preparation),
            "finalPayoff": len(final_payoff)},
        "preservationSamples": retention_evidence,
        "adaptation": adaptation, "selection": selection,
        "candidateFileSha256": digest(ROOT / "candidate.pt"),
        "candidateWeightsSha256": candidate_hash,
        "probabilities": probabilities, "autonomousRollouts": rollouts,
        "normalOpenings": openings,
        "splitOverlap": {"trainValidationEncoded": validation_overlap,
                         "finalEncoded": test_overlap},
        "limitations": ["Continuation evaluation stops after a fixed 100 decisions when no terminal occurs; it is not a full-game win-rate estimate.",
            "The normal-opening check is bounded and does not estimate long-run strength.",
            "No PPO samples, rewards, returns, advantages or old probabilities are created by this study."]}
    atomic_new_json(ROOT / "experiment-audit.json", report)
    return {"selectedStep": adaptation["selectedStep"],
        "stopReason": adaptation["stopReason"],
        "candidateWeightsSha256": candidate_hash,
        "candidateFileSha256": digest(ROOT / "candidate.pt"),
        "probabilitySummary": {key: value["summary"] for key, value in
                               probabilities.items()},
        "rolloutCount": len(rollouts)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("diagnose", "generate", "train"))
    args = parser.parse_args()
    torch.set_num_threads(2)
    plan = json.loads(PLAN.read_text(encoding="utf-8"))
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        baseline, before, identity = open_models(encoder)
        if client.fingerprint != "2bbac3d781b65eb6e29584fc037b20e476ef7167f23b7f07cd35c7da37c3c23b":
            raise ValueError("Arena build differs from reviewed C2 source")
        if args.phase == "diagnose":
            with gzip.open(BASE / "course-pool-v8.json.gz", "rt", encoding="utf-8") as stream:
                old = json.load(stream)
            audit = diagnose_old_retention(client, encoder, before, baseline,
                                           old["entries"])
            audit["source"] = identity
            audit["planSha256"] = digest(PLAN)
            atomic_new_json(ROOT / "retention-diagnosis-v2.json", audit)
            print(json.dumps({"counts": audit["counts"],
                "topKl": [{key: row[key] for key in ("courseId", "category", "reason", "kl")}
                          for row in audit["topKl"][:10]]}, ensure_ascii=False))
        elif args.phase == "generate":
            if not (ROOT / "retention-diagnosis-v2.json").exists():
                raise ValueError("Run retention diagnosis before generating the experiment")
            generator, _ = first.load_parent(BASE.parent / "A2S1C1" / "initial.pt",
                                             encoder, torch.device("cpu"))
            summary = generate_pool(client, encoder, generator, plan,
                                    ROOT / "course-pool.json.gz")
            atomic_new_json(ROOT / "generation-summary.json", summary)
            print(json.dumps(summary, ensure_ascii=False))
        elif args.phase == "train":
            if not (ROOT / "retention-diagnosis-v2.json").exists():
                raise ValueError("Retention audit is required before the bounded experiment")
            summary = run_experiment(client, encoder, baseline, plan, identity)
            print(json.dumps(summary, ensure_ascii=False))
    finally:
        client.close()


if __name__ == "__main__":
    main()
