"""Small, separate A2S1C2 imitation pass over verified legal preparation.

This module never creates PPO samples or supplies expert returns.  Only
script-tagged decisions from training starts can become supervised labels.
"""
from __future__ import annotations

import hashlib
import json
import math
import random
import time
from pathlib import Path

import torch
import torch.nn.functional as F

from scripts import ppo_train as ppo
from scripts.ppo_combo_accept import probe
from scripts.ppo_combo_course_v2 import BY_KEY, course_id, _specified_chain

FORMAT = "a2s1c2-verified-preparation-bc-v2"
CONFIG = {"maxSteps": 32, "learningRate": 1e-5, "supervisedWeight": 0.15,
          "controlKlWeight": 2.0, "controlValueWeight": 0.4,
          "maxControlKl": 0.02, "maxControlValueShift": 0.15,
          "stopIfNoImprovementSteps": 5}

# Registered before evaluating the adapted model. Other installed cards remain
# diagnostics, not silently substituted for these direct teaching targets.
TEACHING_TARGETS = {"G1": "special_136", "G2": "special_137",
    "G3": "special_136", "U1": "special_111", "U2": "special_88",
    "U3": "special_88", "U4": "special_84", "J1": "special_199",
    "J2": "special_189"}


def scene_key(item):
    return hashlib.sha256(item["state"].numpy().tobytes() +
                          item["candidates"].numpy().tobytes()).hexdigest()


def is_training_label(entry, step, definition):
    """Supervise the registered lesson, never an auxiliary setup card."""
    return (entry["variant"] == "positive" and bool(step.get("scripted")) and
            definition == TEACHING_TARGETS[entry["template"]])


def _sample(model, encoder, observation, action_id, metadata):
    state, candidates = encoder.encode(observation)
    chosen = next(i for i, item in enumerate(observation["candidates"])
                  if item["id"] == action_id)
    item = {"state": state, "candidates": candidates, "chosen": chosen,
            "metadata": metadata}
    with torch.no_grad():
        logits, value = model(*ppo.batch_tensors([item], torch.device("cpu")))
        item["teacher"] = torch.softmax(logits[0, :len(candidates)], -1).cpu().clone()
        item["teacherValue"] = value[0].detach().cpu().clone()
    return item


def extract(client, encoder, frozen, entries):
    frozen.eval()
    labels, controls, diagnostics, verified = [], [], [], []
    for entry in entries:
        if entry["split"] != "train" or entry["layer"] != "payoff":
            continue
        if entry["variant"] == "positive":
            feasible = probe(client, entry, combo_telemetry=True)
            if (feasible["goalsCompleted"] != feasible["goalsTotal"] or
                    not _specified_chain(entry, feasible)):
                diagnostics.append({"courseId": course_id(entry), "reason": "payoff_probe_blocked",
                                    "completed": feasible["goalsCompleted"],
                                    "total": feasible["goalsTotal"]})
                continue
            settled = client.request(op="snapshot")["snapshot"]["state"]
            starting = entry["snapshot"]["state"]
            old_units = {unit["id"] for unit in starting["units"]}
            new_units = {unit["id"] for unit in settled["units"]}
            owner = BY_KEY[entry["template"]].owner
            old_discard = {card["id"] for card in starting["decks"][owner]["discardPile"]}
            new_discard = {card["id"] for card in settled["decks"][owner]["discardPile"]}
            verified.append({"courseId": course_id(entry), "completedGoals":
                feasible["goalsCompleted"], "totalGoals": feasible["goalsTotal"],
                "settlementDecisions": len(feasible["steps"]),
                "newUnitIds": sorted(new_units - old_units),
                "removedUnitIds": sorted(old_units - new_units),
                "ownerCardsNewlyDiscarded": sorted(new_discard - old_discard),
                "scoreDelta": {side: settled["scores"][side] - starting["scores"][side]
                    for side in starting["scores"]},
                "actualUnitPlacements": sum(event.get("type") == "UNIT_PLACED" and
                    not event.get("repeated") for step in feasible["steps"]
                    for event in step.get("events") or ()),
                "actualEffects": sum(event.get("type") == "RULE_EVENT" and
                    event.get("code") == "EFFECT_APPLIED" for step in feasible["steps"]
                    for event in step.get("events") or ())})
            if entry["template"] == "U1":
                # Patton is an event. The SOURCE selection and its actual
                # build+attack are verified by the payoff probe above; it must
                # not be tested for installation in the active-card pile.
                starting = client.request(op="restore", snapshot=entry["snapshot"])["observation"]
                chosen = next((step["chosen"] for step in feasible["steps"] if
                    step.get("matched") and step.get("node") == "SOURCE" and
                    step.get("chosen", {}).get("definitionId") == "special_111"), None)
                if chosen is not None and entry["layer"] == "payoff":
                    labels.append(_sample(frozen, encoder, starting, chosen["id"],
                        {"courseId": course_id(entry), "decisionId": starting["decision"]["decisionId"],
                         "traceOffset": len(entry["trace"]), "cardId": "special_111",
                         "scriptReason": "verified_patton_event_payoff"}))
        observation = client.request(op="reset", seed=entry["seed"], mode="A",
                                     cardSet="signals")["observation"]
        for offset, step in enumerate(entry["trace"]):
            if step["actionId"] not in {c["id"] for c in observation["candidates"]}:
                raise ValueError("Demonstration trace diverged from legal arena candidates")
            selected = next(c for c in observation["candidates"] if c["id"] == step["actionId"])
            definition = selected.get("definitionId")
            meta = {"courseId": course_id(entry), "decisionId": step["decision"]["decisionId"],
                    "traceOffset": offset, "cardId": definition,
                    "scriptReason": step.get("scriptReason")}
            # A supporting setup card (for example the American shipyard on a
            # European-front course) is not evidence that installing that card
            # was the lesson of this template.  Only supervise its own cards.
            target_label = is_training_label(entry, step, definition)
            pending_label = _sample(frozen, encoder, observation, step["actionId"], meta) if (
                target_label) else None
            install_pile = ("faceDown" if definition in
                ("special_199", "special_190", "special_189") else "active")
            before_installed = (sum(card["definitionId"] == definition for card in
                client.request(op="snapshot")["snapshot"]["state"]["decks"]
                    [step["activeSeat"]][install_pile]) if pending_label is not None else None)
            if (entry["variant"] == "control" and observation["node"] == "SOURCE" and
                  any(c.get("definitionId") in ("special_136", "special_137", "special_134",
                      "special_78", "special_88", "special_199", "special_190", "special_189",
                      "special_84") for c in observation["candidates"])):
                meta["comparisonCardIds"] = [c["definitionId"] for c in
                    observation["candidates"] if c.get("definitionId") in (
                    "special_136", "special_137", "special_134", "special_78",
                    "special_88", "special_199", "special_190", "special_189", "special_84")]
                meta["comparisonIndices"] = [i for i, c in enumerate(observation["candidates"])
                    if c.get("definitionId") in meta["comparisonCardIds"]]
                meta["controlRole"] = entry.get("controlRole", "unclassified")
                controls.append(_sample(frozen, encoder, observation, step["actionId"], meta))
            observation = client.request(op="step", action={**observation["decision"],
                                                          "actionId": step["actionId"]})["observation"]
            if pending_label is not None:
                actual = client.request(op="snapshot")["snapshot"]["state"]
                seat = step["activeSeat"]
                after_installed = sum(card["definitionId"] == definition for card in
                    actual["decks"][seat][install_pile])
                if after_installed > before_installed:
                    labels.append(pending_label)
                else:
                    diagnostics.append({"courseId": course_id(entry),
                        "decisionId": meta["decisionId"], "cardId": definition,
                        "reason": "scripted_selection_not_installed"})
        actual = client.request(op="snapshot")["snapshot"]
        if actual["state"] != entry["snapshot"]["state"]:
            raise ValueError("Demonstration trace no longer reaches its saved state")
    # Same scripted opening may occur in multiple seeds. Keep counts explicit;
    # duplicate scene observations do not masquerade as diverse examples.
    unique = {scene_key(item) for item in labels}
    # Route comparisons may share exact tensors with positives; they cannot
    # receive the opposite supervision. Keep them as diagnostic scenes only.
    positive_keys = {scene_key(item) for item in labels}
    conflicting = [item for item in controls if scene_key(item) in positive_keys]
    controls = [item for item in controls if scene_key(item) not in positive_keys]
    return labels, controls, {"scriptLabels": len(labels), "uniqueEncodedScenes": len(unique),
                              "controlObservations": len(controls), "verifiedPayoffs": verified,
                              "identicalRouteComparisonsExcluded": len(conflicting),
                              "excluded": diagnostics,
                              "format": FORMAT}


def _forward(model, item):
    logits, value = model(*ppo.batch_tensors([item], torch.device("cpu")))
    return logits[0, :len(item["candidates"])], value[0]


def _forward_many(model, items, batch_size=8):
    for start in range(0, len(items), batch_size):
        chunk = items[start:start + batch_size]
        logits, values = model(*ppo.batch_tensors(chunk, torch.device("cpu")))
        for index, item in enumerate(chunk):
            yield item, logits[index, :len(item["candidates"])], values[index]


def assess(model, labels, controls):
    model.eval()
    with torch.inference_mode():
        positive = []
        for item, logits, value in _forward_many(model, labels):
            probs = torch.softmax(logits, -1)
            positive.append({**item["metadata"], "probability": float(probs[item["chosen"]]),
                             "rank": int((logits > logits[item["chosen"]]).sum()) + 1,
                             "value": float(value)})
        kl, drift, negative = [], [], []
        for item, logits, value in _forward_many(model, controls):
            probabilities = torch.softmax(logits, -1)
            teacher = item["teacher"]
            kl.append(float((teacher * (teacher.clamp_min(1e-30).log() -
                                      logits.log_softmax(-1))).sum()))
            drift.append(abs(float(value - item["teacherValue"])))
            negative.append({"courseId": item["metadata"]["courseId"],
                "decisionId": item["metadata"]["decisionId"],
                "comparison": [{"cardId": card, "probability": float(probabilities[index]),
                    "rank": int((logits > logits[index]).sum()) + 1}
                    for card, index in zip(item["metadata"].get("comparisonCardIds", ()),
                                           item["metadata"].get("comparisonIndices", ()))]})
    return {"positive": positive, "meanPositiveProbability":
            sum(row["probability"] for row in positive) / len(positive) if positive else None,
            "controlCardProbabilities": negative,
            "maxControlKl": max(kl, default=0), "maxControlValueShift": max(drift, default=0)}


def validate_supervision(labels, controls):
    """Identical tensors may be compared as routes, never opposed as labels."""
    targets = {}
    for item in labels:
        key = scene_key(item)
        prior = targets.setdefault(key, item)
        if prior["chosen"] != item["chosen"]:
            first = prior.get("metadata") or {}
            second = item.get("metadata") or {}
            raise ValueError("Conflicting supervised actions for identical encoded scene: "
                             f"{first.get('courseId')} / {first.get('cardId')} "
                             f"vs {second.get('courseId')} / {second.get('cardId')}")
    return {"uniqueScenes": len(targets), "routeOverlap": sum(
        scene_key(item) in targets for item in controls)}


def summarize_holdout(rows, training_labels=()):
    """Every registered lesson must have train and unseen coverage.

    Route controls and unverified condition contrasts are reported, never
    interpreted as negative expert answers. The predeclared retention limits
    in CONFIG and autonomous-settlement checks are separate acceptance gates.
    """
    training = {(row["metadata"]["courseId"].split(":", 1)[0],
                 row["metadata"]["cardId"]) for row in training_labels}
    coverage = []
    for template, target in TEACHING_TARGETS.items():
        relevant = [row for row in rows if row["template"] == template and
                    row["cardId"] == target]
        positives = [row for row in relevant if row["variant"] == "positive"]
        adverse = [row for row in relevant if row.get("controlRole") ==
                   "verified_adverse_condition"]
        coverage.append({"template": template, "teachingTarget": target,
            "trainLabelPresent": (template, target) in training,
            "heldoutPositiveCount": len(positives),
            "heldoutAdverseCount": len(adverse),
            "routeComparisonCount": sum(row.get("controlRole") == "route_comparison"
                for row in relevant),
            "positiveProbabilityBefore": [row["beforeProbability"] for row in positives],
            "positiveProbabilityAfter": [row["afterProbability"] for row in positives],
            "missingReason": ("no_verified_training_label" if (template, target) not in training
                else "no_legal_heldout_target" if not positives else None)})
    return {"accepted": all(item["missingReason"] is None for item in coverage),
            "coverage": coverage, "scenes": rows}


def assess_holdout(client, encoder, parent, adapted, entries, training_labels=()):
    rows = []
    for entry in entries:
        if entry["split"] != "evaluation" or entry["layer"] != "preparation":
            continue
        observation = client.request(op="restore", snapshot=entry["snapshot"],
                                     comboTelemetry=True)["observation"]
        if not observation or observation["node"] != "SOURCE":
            continue
        for card in (TEACHING_TARGETS[entry["template"]],):
            action = next((candidate for candidate in observation["candidates"]
                           if candidate.get("definitionId") == card), None)
            if action is None:
                continue
            state, encoded = encoder.encode(observation)
            item = {"state": state, "candidates": encoded}
            index = next(i for i, candidate in enumerate(observation["candidates"])
                         if candidate["id"] == action["id"])
            with torch.inference_mode():
                before, _ = _forward(parent, item)
                after, _ = _forward(adapted, item)
                before_p = before.softmax(-1)
                after_p = after.softmax(-1)
            rows.append({"courseId": course_id(entry), "template": entry["template"],
                "variant": entry["variant"], "cardId": card,
                "controlRole": entry.get("controlRole"),
                "beforeProbability": float(before_p[index]),
                "afterProbability": float(after_p[index]),
                "beforeRank": int((before > before[index]).sum()) + 1,
                "afterRank": int((after > after[index]).sum()) + 1})
    return summarize_holdout(rows, training_labels)


def assess_autonomous(client, encoder, model, entries, max_decisions=80):
    """Unforced held-out continuation; diagnostic only, never a PPO sample."""
    from scripts.ppo_combo_metrics import new_tracker, record_step, summarize
    model.eval()
    rows = []
    for entry in entries:
        if (entry["split"] != "evaluation" or entry["layer"] != "preparation" or
                entry["variant"] != "positive" or
                entry.get("auxiliaryPreparation")):
            continue
        observation = client.request(op="restore", snapshot=entry["snapshot"],
                                     comboTelemetry=True)["observation"]
        tracker = new_tracker(course_id(entry), entry["snapshot"])
        first_action = None
        result = None
        count = 0
        for count in range(max_decisions):
            if observation is None:
                break
            state, candidates = encoder.encode(observation)
            index, _, _ = ppo.select_action(model, state, candidates,
                torch.device("cpu"), deterministic=True)
            selected = observation["candidates"][index]
            if first_action is None:
                first_action = selected.get("definitionId") or selected.get("kind")
            result = client.request(op="step", action={**observation["decision"],
                "actionId": selected["id"]}, comboTelemetry=True)
            record_step(tracker, result.get("comboTelemetry"), count)
            observation = result["observation"]
            if result.get("result") is not None:
                break
        summary = summarize(tracker, result.get("result") if result and result.get(
            "result") else {"winner": "allies", "allianceScores": {"axis": 0,
            "allies": 0}})
        rows.append({"template": entry["template"], "seed": entry["seed"],
            "firstAutonomousAction": first_action, "decisions": count + 1,
            "naturalTerminal": bool(result and result.get("result") is not None),
            "specifiedComboAchieved": summary.get("specifiedComboAchieved"),
            "tacticalResultAchieved": summary.get("tacticalResultAchieved")})
    return rows


def adapt(parent, labels, controls, *, config=None):
    cfg = {**CONFIG, **(config or {})}
    if not labels:
        raise ValueError("BC requires verified positive labels")
    consistency = validate_supervision(labels, controls)
    if consistency["routeOverlap"]:
        raise ValueError("An identical route comparison cannot be used as a retention constraint")
    model = parent
    before = assess(model, labels, controls)
    optimizer = torch.optim.Adam(model.parameters(), lr=cfg["learningRate"])
    rng = random.Random(20261005)
    history, best_probability, stale = [], before["meanPositiveProbability"], 0
    start = time.perf_counter()
    for step in range(cfg["maxSteps"]):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        chosen = rng.sample(labels, min(4, len(labels)))
        keep = rng.sample(controls, min(6, len(controls)))
        supervised_terms = []
        for item in chosen:
            target_logits, _ = _forward(model, item)
            target_logp = target_logits.log_softmax(-1)[item["chosen"]]
            supervised_terms.append(-target_logp)
        supervised = torch.stack(supervised_terms).mean()
        kl_terms, value_terms = [], []
        for item in keep:
            logits, value = _forward(model, item)
            teacher = item["teacher"]
            kl_terms.append((teacher * (teacher.clamp_min(1e-30).log() -
                                       logits.log_softmax(-1))).sum())
            value_terms.append(F.mse_loss(value, item["teacherValue"]))
        kl = torch.stack(kl_terms).mean() if kl_terms else supervised * 0
        value_loss = torch.stack(value_terms).mean() if value_terms else supervised * 0
        loss = (cfg["supervisedWeight"] * supervised + cfg["controlKlWeight"] * kl +
                cfg["controlValueWeight"] * value_loss)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), .5)
        optimizer.step()
        measured = assess(model, labels, controls)
        history.append({"step": step + 1, "supervisedLoss": float(supervised.detach()),
                        "retentionKl": float(kl.detach()), "valueLoss": float(value_loss.detach()),
                        "meanPositiveProbability": measured["meanPositiveProbability"],
                        "maxControlKl": measured["maxControlKl"],
                        "maxControlValueShift": measured["maxControlValueShift"]})
        if measured["maxControlKl"] > cfg["maxControlKl"] or measured[
                "maxControlValueShift"] > cfg["maxControlValueShift"]:
            return {"accepted": False, "reason": "control_drift_limit", "before": before,
                    "after": measured, "history": history, "seconds": time.perf_counter() - start}
        if measured["meanPositiveProbability"] > best_probability * 1.001:
            best_probability, stale = measured["meanPositiveProbability"], 0
        else:
            stale += 1
        if stale >= cfg["stopIfNoImprovementSteps"]:
            break
    after = assess(model, labels, controls)
    return {"accepted": after["meanPositiveProbability"] > before["meanPositiveProbability"] and
            after["maxControlKl"] <= cfg["maxControlKl"] and
            after["maxControlValueShift"] <= cfg["maxControlValueShift"],
            "reason": "bounded_steps_or_plateau", "before": before, "after": after,
            "history": history, "seconds": time.perf_counter() - start,
            "supervisionConsistency": consistency, "config": cfg}
