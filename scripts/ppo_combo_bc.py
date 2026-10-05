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

FORMAT = "a2s1c2-verified-preparation-bc-v1"
CONFIG = {"maxSteps": 32, "learningRate": 1e-5, "supervisedWeight": 0.15,
          "controlKlWeight": 2.0, "controlValueWeight": 0.4,
          "controlCardWeight": 1.0, "controlAllowedLogRise": 0.05,
          "contrastWeight": 0.6, "contrastMargin": 0.15,
          "minimumContrastRatio": 1.1,
          "maxControlKl": 0.02, "maxControlValueShift": 0.15,
          "stopIfNoImprovementSteps": 5}


def is_training_label(entry, step, definition):
    """A legal scripted installation is supervision only for its own template."""
    return (entry["variant"] == "positive" and bool(step.get("scripted")) and
            definition in BY_KEY[entry["template"]].cards)


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
            verified.append({"courseId": course_id(entry), "completedGoals":
                feasible["goalsCompleted"], "totalGoals": feasible["goalsTotal"],
                "settlementDecisions": len(feasible["steps"]),
                "actualUnitPlacements": sum(event.get("type") == "UNIT_PLACED" and
                    not event.get("repeated") for step in feasible["steps"]
                    for event in step.get("events") or ()),
                "actualEffects": sum(event.get("type") == "RULE_EVENT" and
                    event.get("code") == "EFFECT_APPLIED" for step in feasible["steps"]
                    for event in step.get("events") or ())})
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
    unique = {hashlib.sha256(item["state"].numpy().tobytes() +
        item["candidates"].numpy().tobytes()).hexdigest() for item in labels}
    return labels, controls, {"scriptLabels": len(labels), "uniqueEncodedScenes": len(unique),
                              "controlObservations": len(controls), "verifiedPayoffs": verified,
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


def contrast_ratio(before, after):
    """Relative lift of verified preparations over same-template controls."""
    positive = [math.log(max(new["probability"], 1e-30) /
                         max(old["probability"], 1e-30))
        for old, new in zip(before["positive"], after["positive"])]
    negative_by_key = {}
    for old, new in zip(before["controlCardProbabilities"],
                        after["controlCardProbabilities"]):
        template = old["courseId"].split(":", 1)[0]
        for first, second in zip(old["comparison"], new["comparison"]):
            if first["cardId"] != second["cardId"]:
                raise ValueError("Contrast control candidate order changed")
            negative_by_key.setdefault((template, first["cardId"]), []).append(
                math.log(max(second["probability"], 1e-30) /
                         max(first["probability"], 1e-30)))
    matched = [sum(negative_by_key[key]) / len(negative_by_key[key])
        for row in before["positive"]
        if (key := (row["courseId"].split(":", 1)[0], row["cardId"]))
        in negative_by_key]
    if not positive or len(matched) != len(positive):
        raise ValueError("Each demonstrated card needs a same-template negative control")
    return {"positiveGeometricLift": math.exp(sum(positive) / len(positive)),
            "matchedControlGeometricLift": math.exp(sum(matched) / len(matched)),
            "positiveOverControl": math.exp((sum(positive) - sum(matched)) / len(positive))}


def summarize_holdout(rows, *, minimum_pairs=4, minimum_ratio=1.05):
    """Unseen starts must distinguish prepared opportunities from controls."""
    grouped = {}
    for row in rows:
        key = (row["template"], row["cardId"])
        grouped.setdefault(key, {}).setdefault(row["variant"], []).append(
            math.log(max(row["afterProbability"], 1e-30) /
                     max(row["beforeProbability"], 1e-30)))
    pairs = []
    for (template, card), variants in sorted(grouped.items()):
        if not variants.get("positive") or not variants.get("control"):
            continue
        positive = sum(variants["positive"]) / len(variants["positive"])
        control = sum(variants["control"]) / len(variants["control"])
        pairs.append({"template": template, "cardId": card,
            "positiveLift": math.exp(positive), "controlLift": math.exp(control),
            "relativeContrast": math.exp(positive - control)})
    return {"accepted": len(pairs) >= minimum_pairs and all(
            pair["relativeContrast"] >= minimum_ratio for pair in pairs),
        "minimumPairs": minimum_pairs, "minimumRatio": minimum_ratio,
        "pairs": pairs, "scenes": rows}


def assess_holdout(client, encoder, parent, adapted, entries):
    rows = []
    for entry in entries:
        if entry["split"] != "evaluation" or entry["layer"] != "preparation":
            continue
        observation = client.request(op="restore", snapshot=entry["snapshot"])["observation"]
        if not observation or observation["node"] != "SOURCE":
            continue
        for card in BY_KEY[entry["template"]].cards:
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
                "beforeProbability": float(before_p[index]),
                "afterProbability": float(after_p[index]),
                "beforeRank": int((before > before[index]).sum()) + 1,
                "afterRank": int((after > after[index]).sum()) + 1})
    return summarize_holdout(rows)


def adapt(parent, labels, controls, *, config=None):
    cfg = {**CONFIG, **(config or {})}
    if not labels or not controls:
        raise ValueError("BC requires verified positive labels and unrelated/control observations")
    model = parent
    before = assess(model, labels, controls)
    optimizer = torch.optim.Adam(model.parameters(), lr=cfg["learningRate"])
    rng = random.Random(20261005)
    matched = {}
    for item in controls:
        template = item["metadata"]["courseId"].split(":", 1)[0]
        for card in item["metadata"].get("comparisonCardIds", ()):
            matched.setdefault((template, card), []).append(item)
    history, best_probability, stale = [], before["meanPositiveProbability"], 0
    start = time.perf_counter()
    for step in range(cfg["maxSteps"]):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        chosen = rng.sample(labels, min(4, len(labels)))
        keep = rng.sample(controls, min(6, len(controls)))
        for item in chosen:
            key = (item["metadata"]["courseId"].split(":", 1)[0],
                   item["metadata"]["cardId"])
            if matched.get(key):
                keep.append(rng.choice(matched[key]))
        supervised_terms, contrast_terms = [], []
        for item in chosen:
            target_logits, _ = _forward(model, item)
            target_logp = target_logits.log_softmax(-1)[item["chosen"]]
            supervised_terms.append(-target_logp)
            key = (item["metadata"]["courseId"].split(":", 1)[0],
                   item["metadata"]["cardId"])
            if matched.get(key):
                negative = rng.choice(matched[key])
                card = item["metadata"]["cardId"]
                control_index = next(index for cid, index in zip(
                    negative["metadata"]["comparisonCardIds"],
                    negative["metadata"]["comparisonIndices"]) if cid == card)
                control_logits, _ = _forward(model, negative)
                control_logp = control_logits.log_softmax(-1)[control_index]
                relative_lift = (target_logp - item["teacher"][item["chosen"]].clamp_min(1e-30).log()
                    - control_logp + negative["teacher"][control_index].clamp_min(1e-30).log())
                contrast_terms.append(F.softplus(cfg["contrastMargin"] - relative_lift))
        supervised = torch.stack(supervised_terms).mean()
        kl_terms, value_terms, card_terms = [], [], []
        for item in keep:
            logits, value = _forward(model, item)
            teacher = item["teacher"]
            kl_terms.append((teacher * (teacher.clamp_min(1e-30).log() -
                                       logits.log_softmax(-1))).sum())
            value_terms.append(F.mse_loss(value, item["teacherValue"]))
            for index in item["metadata"].get("comparisonIndices", ()):
                # Retain the parent's probability of installing the same card
                # where this template's opportunity/cost did not justify it.
                current = logits.log_softmax(-1)[index]
                baseline = teacher[index].clamp_min(1e-30).log()
                card_terms.append(F.relu(current - baseline -
                    cfg["controlAllowedLogRise"]).square())
        kl = torch.stack(kl_terms).mean()
        value_loss = torch.stack(value_terms).mean()
        card_loss = torch.stack(card_terms).mean() if card_terms else supervised * 0
        contrast_loss = (torch.stack(contrast_terms).mean() if contrast_terms
                         else supervised * 0)
        loss = (cfg["supervisedWeight"] * supervised + cfg["controlKlWeight"] * kl +
                cfg["controlValueWeight"] * value_loss +
                cfg["controlCardWeight"] * card_loss +
                cfg["contrastWeight"] * contrast_loss)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), .5)
        optimizer.step()
        measured = assess(model, labels, controls)
        negative_increase = max((after["probability"] - baseline["probability"]
            for later, earlier in zip(measured["controlCardProbabilities"],
                                      before["controlCardProbabilities"])
            for after, baseline in zip(later["comparison"], earlier["comparison"])),
            default=0.0)
        history.append({"step": step + 1, "supervisedLoss": float(supervised.detach()),
                        "retentionKl": float(kl.detach()), "valueLoss": float(value_loss.detach()),
                        "controlCardLoss": float(card_loss.detach()),
                        "contrastLoss": float(contrast_loss.detach()),
                        "meanPositiveProbability": measured["meanPositiveProbability"],
                        "maxControlKl": measured["maxControlKl"],
                        "maxControlValueShift": measured["maxControlValueShift"],
                        "maxControlCardProbabilityIncrease": negative_increase})
        if measured["maxControlKl"] > cfg["maxControlKl"] or measured[
                "maxControlValueShift"] > cfg["maxControlValueShift"] or negative_increase > .05:
            return {"accepted": False, "reason": "control_drift_limit", "before": before,
                    "after": measured, "history": history, "seconds": time.perf_counter() - start}
        if measured["meanPositiveProbability"] > best_probability * 1.001:
            best_probability, stale = measured["meanPositiveProbability"], 0
        else:
            stale += 1
        if stale >= cfg["stopIfNoImprovementSteps"]:
            break
    after = assess(model, labels, controls)
    distinction = contrast_ratio(before, after)
    final_negative_increase = max((new["probability"] - old["probability"]
        for later, earlier in zip(after["controlCardProbabilities"],
                                  before["controlCardProbabilities"])
        for new, old in zip(later["comparison"], earlier["comparison"])), default=0.0)
    return {"accepted": after["meanPositiveProbability"] > before["meanPositiveProbability"] and
            distinction["positiveOverControl"] >= cfg["minimumContrastRatio"] and
            after["maxControlKl"] <= cfg["maxControlKl"] and
            after["maxControlValueShift"] <= cfg["maxControlValueShift"] and
            final_negative_increase <= .05,
            "reason": "bounded_steps_or_plateau", "before": before, "after": after,
            "history": history, "seconds": time.perf_counter() - start,
            "maxControlCardProbabilityIncrease": final_negative_increase,
            "contrast": distinction, "config": cfg}
