"""Replay seeded headless games and detect identical vectors for distinct choices."""
import argparse
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.ppo_train import ArenaClient, Encoder


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-seed", type=int, default=929600)
    parser.add_argument("--seeds-per-mode", type=int, default=6)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    client = ArenaClient()
    started = time.perf_counter()
    runs, collisions, errors, branches = [], [], [], {}
    try:
        encoder = Encoder(client.schema)
        for mode in ("A", "B"):
            for offset in range(args.seeds_per_mode):
                seed = args.start_seed + offset
                rng = random.Random(seed)
                obs = client.request(op="reset", seed=seed, mode=mode, cardSet="events")["observation"]
                step = 0
                try:
                    while obs is not None and step < 1000:
                        encoder.encode(obs)
                        branch = (f"{obs.get('choiceKind')}:{obs.get('choiceField')}"
                                  if obs["node"] == "ENGINE_CHOICE" else obs["node"])
                        branches[branch] = branches.get(branch, 0) + 1
                        groups = {}
                        for candidate in obs["candidates"]:
                            vector = tuple(encoder.encode_candidate(obs, candidate))
                            groups.setdefault(vector, []).append(candidate)
                        for group in groups.values():
                            if len(group) > 1:
                                collisions.append({"seed": seed, "mode": mode, "step": step,
                                                   "branch": branch,
                                                   "candidates": [{"id": c["id"],
                                                                   "choices": c.get("choices"),
                                                                   "effects": c.get("effects")}
                                                                  for c in group]})
                        chosen = rng.choice(obs["candidates"])
                        response = client.request(op="step", action={
                            **obs["decision"], "actionId": chosen["id"]})
                        obs = response["observation"]
                        step += 1
                    if obs is not None or response["result"]["termination"] != "natural":
                        raise RuntimeError("episode did not end naturally")
                    runs.append({"seed": seed, "mode": mode, "steps": step})
                except Exception as exc:
                    errors.append({"seed": seed, "mode": mode, "step": step,
                                   "branch": branch, "error": str(exc)})
        output = {"fingerprint": client.fingerprint, "stateDim": encoder.state_dim,
                  "candidateDim": encoder.candidate_dim, "runs": runs, "branches": branches,
                  "collisions": collisions, "errors": errors,
                  "wallSeconds": time.perf_counter() - started}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"runs": len(runs), "decisions": sum(r["steps"] for r in runs),
                          "collisions": len(collisions), "errors": errors}, ensure_ascii=False))
        return 1 if errors else 0
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
