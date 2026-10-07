"""Explicit, read-only old/new arena comparison before migrating C1 weights."""
from __future__ import annotations

import argparse
import random
from pathlib import Path

from scripts.ppo_diff_arena import normalized
from scripts.ppo_train import ArenaClient


def compare(reference, current, seed, limit=250):
    observations = [client.request(op="reset", seed=seed, mode="A",
        cardSet="signals")["observation"] for client in (reference, current)]
    rng = random.Random(seed ^ 0xC2C2)
    count = 0
    for index in range(limit):
        if normalized(observations[0]) != normalized(observations[1]):
            raise AssertionError(f"C1/C2 observation or candidate difference at {seed}:{index}")
        snapshots = [client.request(op="snapshot")["snapshot"] for client in
                     (reference, current)]
        if normalized(snapshots[0]) != normalized(snapshots[1]):
            raise AssertionError(f"C1/C2 state difference at {seed}:{index}")
        chosen = observations[0]["candidates"][rng.randrange(len(
            observations[0]["candidates"]))]
        replies = [client.request(op="step", action={**observation["decision"],
            "actionId": chosen["id"]}) for client, observation in zip(
                (reference, current), observations)]
        if normalized(replies[0]["info"]) != normalized(replies[1]["info"]):
            raise AssertionError(f"C1/C2 step info difference at {seed}:{index}")
        observations = [reply["observation"] for reply in replies]
        count += 1
        if observations[0] is None:
            break
    return count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--old-arena", type=Path, required=True)
    parser.add_argument("--seeds", type=int, nargs="+", default=[2026100500, 2026100504,
        2026102406, 2026103400, 2026104406])
    args = parser.parse_args()
    reference = ArenaClient(card_set="signals", entry_path=str(args.old_arena))
    current = ArenaClient(card_set="signals")
    try:
        print({"referenceBuild": reference.fingerprint,
            "currentBuild": current.fingerprint,
            "matchedDecisions": {seed: compare(reference, current, seed)
                                 for seed in args.seeds}})
    finally:
        reference.close()
        current.close()


if __name__ == "__main__":
    main()
