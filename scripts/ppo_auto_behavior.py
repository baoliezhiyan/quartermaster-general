"""Small independent engine rollouts guarding off-policy imitation.

Thresholds are fixed before auxiliary optimization. These are regression
checks, not a win-rate estimate or a substitute for longer evaluation.
"""
from __future__ import annotations

import time

import torch

from scripts.ppo_auto_explore import FrozenPolicy, run_branch

VERSION = "auto-behavior-holdout-v1"
MAX_CASES = 7
MAX_DECISIONS_PER_CASE = 16
MAX_NEW_INVALID_EVENTS = 0
MAX_SIGNAL_COMPLETION_DROP = 0
MAX_USEFUL_ACTION_DROP = 2


def probe(client, model, encoder, device, cases, archive, *, source_hash):
    if not cases:
        return None
    deadline = archive.phase_deadline("p3", 1800)
    policy = FrozenPolicy.from_live(model, encoder, device, source_hash=source_hash)
    totals = {"invalidEvents": 0, "successfulSignalEvents": 0,
              "usefulActions": 0, "decisionSteps": 0, "cases": 0}
    for case in cases[:MAX_CASES]:
        if time.time() >= deadline or archive.remaining_budget("p3_engine_steps", 20_000) < 1:
            return None
        root = {"id": case["id"], "snapshot": case["snapshot"],
                "observation": case["observation"], "prefix": []}
        probabilities, _ = policy.probabilities(case["observation"])
        first = max(range(len(probabilities)), key=lambda item: probabilities[item])
        result = run_branch(client, root, policy, first, kind="sentinel",
            seed=case["seed"], max_steps=MAX_DECISIONS_PER_CASE,
            max_extra_interventions=0, stop_after_two_turns=False,
            archive=archive, budget_key="p3_engine_steps", budget_ceiling=20_000,
            deadline=deadline, save_observations=False)
        if not result["steps"]:
            return None
        totals["cases"] += 1
        totals["decisionSteps"] += result["steps"]
        for step in result["path"]:
            for commit in step["events"]:
                for event in commit.get("events", ()):
                    if event.get("outcome") == "invalid":
                        totals["invalidEvents"] += 1
                    if event.get("outcome") == "succeeded" and event.get("applied"):
                        if event.get("kind") in ("action", "remove", "score"):
                            totals["usefulActions"] += 1
                        if encoder.schema.get("cardTypes", {}).get(
                                event.get("sourceDefinitionId")) in ("状态", "响应") and \
                                event.get("frameCardId") and event.get("kind") in (
                                    "action", "remove", "score"):
                            totals["successfulSignalEvents"] += 1
    return {"version": VERSION, **totals}


def acceptable(before, after):
    if before is None or after is None or before["cases"] != after["cases"]:
        return False, "holdout_unverified"
    if after["invalidEvents"] > before["invalidEvents"] + MAX_NEW_INVALID_EVENTS:
        return False, "new_invalid_actions"
    if after["successfulSignalEvents"] < before["successfulSignalEvents"] - \
            MAX_SIGNAL_COMPLETION_DROP:
        return False, "signal_completion_regressed"
    if after["usefulActions"] < before["usefulActions"] - MAX_USEFUL_ACTION_DROP:
        return False, "useful_actions_regressed"
    return True, "accepted"
