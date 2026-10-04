"""Full training replay: legal scripted preparation, then model-only continuation."""
from __future__ import annotations

import hashlib
import json
import random
import subprocess
from pathlib import Path

import torch

from scripts import ppo_rounds as rounds
from scripts import ppo_train as ppo
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network


def record_course(model, encoder, entry: dict, target: Path, metadata: dict,
                  deterministic=True, max_decisions=3000):
    raw = target.with_name(f".{target.stem}-raw.jsonl")
    if target.exists() or raw.exists():
        raise FileExistsError(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    client = ppo.ArenaClient(log_path=raw, log_snapshots=True, card_set="signals")
    try:
        metadata = {**metadata, "recordScope": "reachable-course-preparation-plus-model-continuation",
                    "courseTemplate": entry["template"], "courseVariant": entry["variant"],
                    "courseLayer": entry["layer"], "courseStartSeed": entry["seed"],
                    "scriptedPreparationDecisionCount": len(entry["trace"]),
                    "takeoverDecisionId": entry["snapshot"]["decisionCount"],
                    "preparationTrace": [{"decisionId": item["decision"]["decisionId"],
                                          "actionId": item["actionId"],
                                          "scripted": item["scripted"]} for item in entry["trace"]],
                    "controllerAfterTakeover": "same-frozen-policy-both-teams"}
        observation = client.request(op="reset", seed=entry["seed"], mode="A",
                                     cardSet="signals", trace="full",
                                     recordMetadata=metadata)["observation"]
        for item in entry["trace"]:
            if item["actionId"] not in {choice["id"] for choice in observation["candidates"]}:
                raise ValueError("Course preparation action is no longer legal")
            observation = client.request(op="step", action={**observation["decision"],
                "actionId": item["actionId"]})["observation"]
        snapshot = client.request(op="snapshot")["snapshot"]
        # Full-fidelity recording adds only a recorder flag to the arena state.
        # Compare every other state field, including the training random streams.
        actual_state = {**snapshot["state"], "trainingCourse": {
            key: value for key, value in snapshot["state"]["trainingCourse"].items()
            if key != "captureReplay"}}
        if actual_state != entry["snapshot"]["state"]:
            raise ValueError("Replay preparation does not reach the saved takeover state")
        rng = random.Random((entry["seed"] << 32) ^ 0xA2C1)
        decisions = len(entry["trace"])
        outcome = None
        model.eval()
        while observation is not None and decisions < max_decisions:
            state, candidates = encoder.encode(observation)
            index, _, _ = ppo.select_action(model, state, candidates, torch.device("cpu"),
                                             deterministic=deterministic, rng=rng)
            chosen = observation["candidates"][index]
            response = client.request(op="step", action={**observation["decision"],
                                                          "actionId": chosen["id"]})
            decisions += 1
            outcome = response["result"]
            observation = response["observation"]
        if not outcome or outcome["termination"] != "natural":
            raise RuntimeError("Course replay did not reach natural ending")
    finally:
        client.close()
    digest = rounds.validate_record(raw, decisions, entry["seed"])
    with raw.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps({"recordType": "trainingSummary", "courseTemplate": entry["template"],
            "courseVariant": entry["variant"], "courseLayer": entry["layer"],
            "preparationDecisions": len(entry["trace"]),
            "modelDecisions": decisions - len(entry["trace"]),
            "winner": outcome["winner"], "allianceScores": outcome["allianceScores"],
            "sha256OfPriorLines": digest}, ensure_ascii=False, separators=(",", ":")) + "\n")
    subprocess.run(["node", "scripts/ppo-export-training-replay.mjs", str(raw), str(target)],
                   cwd=ppo.ROOT, check=True)
    raw.unlink()
    return {"template": entry["template"], "variant": entry["variant"],
            "layer": entry["layer"], "preparationDecisions": len(entry["trace"]),
            "modelDecisions": decisions - len(entry["trace"]), "winner": outcome["winner"],
            "scoreDifferenceAxisMinusAllies": outcome["allianceScores"]["axis"] -
                                              outcome["allianceScores"]["allies"],
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}


def main():
    import argparse
    import gzip
    parser = argparse.ArgumentParser(description="Export one clearly marked course demonstration")
    parser.add_argument("--template", choices=("G2", "U2", "J2"), required=True)
    parser.add_argument("--pool", type=Path, default=ppo.ROOT / "PPO训练" / ".state" /
                        "A2S1C1" / "course-pool-v1.json.gz")
    parser.add_argument("--initial", type=Path, default=ppo.ROOT / "PPO训练" / ".state" /
                        "A2S1C1" / "initial.pt")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    with gzip.open(args.pool, "rt", encoding="utf-8") as stream:
        pool = json.load(stream)
    entry = next(item for item in pool["entries"] if item["template"] == args.template and
                 item["variant"] == "positive" and item["layer"] == "preparation")
    initial = torch.load(args.initial, map_location="cpu", weights_only=False)
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        model = make_network(A2S1_ADAPTER, encoder)
        model.load_state_dict(initial["modelState"], strict=True)
    finally:
        client.close()
    output = args.output or (ppo.ROOT / "PPO训练" / "A2S1C1" / "课程短验收" /
                             f"课程-{args.template}.jsonl")
    print(json.dumps(record_course(model, encoder, entry, output,
        {"experimentId": "A2S1C1", "modelSha256": initial["weightsSha256"],
         "purpose": "short-acceptance-frozen-source-model"}), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
