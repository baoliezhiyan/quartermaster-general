"""Stepwise comparison of an optimized arena with a frozen source checkout.

The reference source is copied into an ignored directory before running this tool.
No model is involved: both arenas receive the same explicit action at each decision.
"""
from __future__ import annotations

import argparse
import copy
import json
import random
from pathlib import Path

from scripts.ppo_train import ArenaClient


def normalized(value):
    value = copy.deepcopy(value)
    if isinstance(value, dict):
        value.pop("episodeId", None)
        value.pop("buildFingerprint", None)
        value.pop("configHash", None)
        for key, nested in value.items():
            value[key] = normalized(nested)
    elif isinstance(value, list):
        value = [normalized(nested) for nested in value]
    return value


def compare(reference: ArenaClient, optimized: ArenaClient, mode: str, seed: int,
            limit: int) -> dict:
    responses = [client.request(op="reset", mode=mode, seed=seed, cardSet="events",
                                gameId=f"diff-{mode}-{seed}")
                 for client in (reference, optimized)]
    rng = random.Random(seed ^ 0xFACEB00C)
    coverage = {"decisions": 0, "actions": {}, "choices": {}, "terminated": False}
    for index in range(limit):
        observations = [response["observation"] for response in responses]
        if normalized(observations[0]) != normalized(observations[1]):
            raise AssertionError(f"Observation differs: {mode} seed {seed} decision {index}")
        snapshots = [client.request(op="snapshot")["snapshot"]
                     for client in (reference, optimized)]
        if normalized(snapshots[0]) != normalized(snapshots[1]):
            raise AssertionError(f"Intermediate state differs: {mode} seed {seed} decision {index}")
        candidates = observations[0]["candidates"]
        chosen = candidates[rng.randrange(len(candidates))]
        coverage["actions"][chosen["kind"]] = coverage["actions"].get(chosen["kind"], 0) + 1
        if chosen["kind"] == "source":
            card = chosen.get("definitionId", "unknown")
            coverage["choices"][card] = coverage["choices"].get(card, 0) + 1
        responses = [client.request(op="step", action={**obs["decision"],
                                                       "actionId": chosen["id"]})
                     for client, obs in zip((reference, optimized), observations)]
        if normalized(responses[0]["info"]) != normalized(responses[1]["info"]):
            raise AssertionError(f"Step info differs: {mode} seed {seed} decision {index}")
        if normalized(responses[0]["result"]) != normalized(responses[1]["result"]):
            raise AssertionError(f"Result differs: {mode} seed {seed} decision {index}")
        coverage["decisions"] += 1
        if responses[0]["result"] is not None:
            coverage["terminated"] = True
            break
    return coverage


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--seeds", type=int, default=4)
    parser.add_argument("--limit", type=int, default=300)
    args = parser.parse_args()
    reference = ArenaClient(entry_path=str(args.reference))
    optimized = ArenaClient()
    try:
        reports = {}
        for mode in ("A", "B"):
            for seed in range(930701, 930701 + args.seeds):
                reports[f"{mode}:{seed}"] = compare(reference, optimized, mode, seed, args.limit)
        print(json.dumps(reports, ensure_ascii=False, indent=2))
    finally:
        reference.close()
        optimized.close()


if __name__ == "__main__":
    main()
