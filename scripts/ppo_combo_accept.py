"""Bounded, engine-driven tactical feasibility checks for saved combo starts.

This does not create PPO samples or grant rewards. It records every actual
candidate/selection so a failed claimed combo remains diagnosable.
"""
from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path

from scripts import ppo_train as ppo
from scripts.ppo_combo_course import TEMPLATES


GOALS = {
    "G1": [("source", "land_battle", "ukraine"), ("trigger", "special_136", None),
           ("choice", "build_army", "ukraine")],
    "G2": [("source", "land_battle", "ukraine"), ("trigger", "special_136", None),
           ("choice", "build_army", "ukraine"), ("trigger", "special_137", None),
           ("choice", "land_battle", "moscow")],
    "G3": [("source", "land_battle", "western_europe"), ("trigger", "special_134", None),
           ("choice", "land_battle", "western_europe"), ("trigger", "special_136", None),
           ("choice", "build_army", "western_europe")],
    "U1": [("source", "special_111", None), ("choice", "build_army", "western_europe"),
           ("choice", "land_battle", "italy")],
    "U2": [("source", "build_navy", "sea_east_pacific"),
           ("trigger", "special_78", None), ("choice", "land_battle", "hawaii"),
           ("trigger", "special_88", None), ("choice", "build_army", "hawaii")],
    "U3": [("source", "land_battle", "western_europe"),
           ("trigger", "special_88", None), ("choice", "build_army", "western_europe")],
    "J1": [("source", "land_battle", "eastern_china"),
           ("trigger", "special_199", None), ("choice", "build_army", "eastern_china")],
    "J2": [("trigger", "special_190", None), ("choice", "destroy", "eastern_china"),
           ("trigger", "special_189", None), ("choice", "recruit_army", "eastern_china")],
    "U4": [("source", "build_navy", "sea_north_atlantic"),
           ("trigger", "special_84", None),
           ("choice", "build_navy", "sea_north_sea")],
}


def _matches(candidate, goal):
    kind, card, region = goal
    if kind == "source":
        return candidate.get("kind") == "source" and candidate.get("definitionId") == card and (
            region is None or any(feature.get("regionId") == region for feature in
                                  candidate.get("choices") or ()))
    if kind == "trigger":
        return bool(candidate.get("choiceIds")) and any(
            feature.get("kind") == "trigger" and feature.get("definitionId") == card
            for feature in candidate.get("choices") or ())
    return any(feature.get("action") == card and (
        region is None or feature.get("regionId") == region) for feature in
               candidate.get("choices") or ())


def _already_resolved(goal, record):
    """Some mandatory children execute inside the trigger click with no AI choice."""
    kind, action, region = goal
    if kind != "choice":
        return False
    events = record.get("events") or ()
    if action in ("build_army", "build_navy", "recruit_army"):
        return any(event.get("type") == "UNIT_PLACED" and
                   event.get("regionId") == region and not event.get("repeated") for event in events)
    if action == "land_battle":
        applied = any(event.get("type") == "TRAINING_BOARD_APPLIED" and
                   event.get("action") == action and event.get("regionId") == region
                   for event in events)
        before = {unit["id"]: unit for unit in record.get("before", {}).get("units", ())}
        after = {unit["id"] for unit in record.get("after", {}).get("units", ())}
        return applied or any(unit["regionId"] == region and unit_id not in after
                              for unit_id, unit in before.items())
    if action == "destroy":
        before = {unit["id"]: unit for unit in record.get("before", {}).get("units", ())}
        after = {unit["id"] for unit in record.get("after", {}).get("units", ())}
        return any(unit["regionId"] == region and unit_id not in after
                   for unit_id, unit in before.items())
    return False


def probe(client, entry, max_steps=25, combo_telemetry=False):
    template = entry["template"]
    response = client.request(op="restore", snapshot=entry["snapshot"], trace="full",
                              comboTelemetry=combo_telemetry)
    observation = response["observation"]
    goals = GOALS[template]
    steps = []
    cursor = 0
    for _ in range(max_steps):
        if observation is None or cursor >= len(goals):
            break
        goal = goals[cursor]
        chosen = next((candidate for candidate in observation["candidates"]
                       if _matches(candidate, goal)), None)
        # A mandatory singleton may be a fee or acknowledgement between goals.
        if chosen is None and len(observation["candidates"]) == 1:
            chosen = observation["candidates"][0]
            matched = False
        elif chosen is None:
            steps.append({"goal": goal, "blocked": True, "node": observation["node"],
                          "choiceKind": observation.get("choiceKind"),
                          "candidates": [{"kind": item["kind"],
                                           "definitionId": item.get("definitionId"),
                                           "choices": item.get("choices")}
                                          for item in observation["candidates"][:12]]})
            break
        else:
            matched = True
        result = client.request(op="step", action={**observation["decision"],
                                                    "actionId": chosen["id"]},
                                comboTelemetry=combo_telemetry)
        steps.append({"goal": goal, "matched": matched, "seat": observation["decisionSeat"],
                      "node": observation["node"], "choiceKind": observation.get("choiceKind"),
                      "source": observation.get("currentSourceDefinition"),
                      "chosen": chosen, "events": (result.get("record") or {}).get("events", []),
                      "telemetry": result.get("comboTelemetry"),
                      "resolved": result["info"].get("resolvedCardDefinitions")})
        if matched:
            cursor += 1
        record = result.get("record") or {}
        while cursor < len(goals) and _already_resolved(goals[cursor], record):
            cursor += 1
        observation = result["observation"]
    return {"template": template, "variant": entry["variant"], "seed": entry["seed"],
            "goalsCompleted": cursor, "goalsTotal": len(goals), "steps": steps}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pool", type=Path, default=ppo.ROOT / "PPO训练" / ".state" /
                        "A2S1C1" / "course-pool-v1.json.gz")
    parser.add_argument("--template", choices=[item.key for item in TEMPLATES])
    args = parser.parse_args()
    with gzip.open(args.pool, "rt", encoding="utf-8") as stream:
        entries = json.load(stream)["entries"]
    client = ppo.ArenaClient(card_set="signals")
    try:
        for entry in entries:
            if entry["variant"] != "positive" or entry["layer"] != "payoff" or (
                    args.template and entry["template"] != args.template):
                continue
            result = probe(client, entry)
            print(json.dumps({"template": result["template"], "completed": result["goalsCompleted"],
                              "total": result["goalsTotal"],
                              "steps": len(result["steps"]),
                              "blockedAt": next((step["goal"] for step in result["steps"]
                                  if step.get("blocked")), None),
                              "actions": [(step.get("seat"), step.get("chosen", {}).get("definitionId"),
                                           step.get("chosen", {}).get("choiceIds"))
                                          for step in result["steps"] if step.get("chosen")]},
                             ensure_ascii=False), flush=True)
    finally:
        client.close()


if __name__ == "__main__":
    main()
