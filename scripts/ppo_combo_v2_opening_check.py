"""Read-only fixed-seed normal-opening comparison for a rejected C2 candidate."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch

from scripts import ppo_combo_v2_prepare as prepare
from scripts import ppo_train as ppo
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network


def _prediction(model, encoder, observation):
    state, candidates = encoder.encode(observation)
    with torch.inference_mode():
        logits, value = model(*ppo.batch_tensors([{"state": state,
            "candidates": candidates}], torch.device("cpu")))
        scores = logits[0, :len(candidates)]
        index = int(scores.argmax())
        probability = float(scores.softmax(-1)[index])
    action = observation["candidates"][index]
    return index, {"cardId": action.get("definitionId"), "kind": action.get("kind"),
                   "probability": probability, "value": float(value[0])}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--seeds", type=int, nargs="+", default=[20261001, 20261002])
    args = parser.parse_args()
    torch.set_num_threads(2)
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        _, parent = prepare.verify_parent(prepare.PARENT, client, encoder)
        saved = torch.load(args.candidate, map_location="cpu", weights_only=False)
        if (saved.get("stage") != "rejected-short-adaptation" or
                saved.get("parentCheckpointSha256") != prepare.sha(prepare.PARENT)):
            raise ValueError("Candidate does not belong to reviewed rejected C2 attempt")
        candidate = make_network(A2S1_ADAPTER, encoder)
        candidate.load_state_dict(saved["modelState"], strict=True)
        parent.eval(), candidate.eval()
        rows = []
        for seed in args.seeds:
            observation = client.request(op="reset", seed=seed, mode="A",
                                         cardSet="signals")["observation"]
            seen = set()
            for _ in range(180):
                if observation is None or len(seen) == 6:
                    break
                old_index, old = _prediction(parent, encoder, observation)
                _, new = _prediction(candidate, encoder, observation)
                if observation["node"] == "SOURCE" and observation["activeSeat"] not in seen:
                    seen.add(observation["activeSeat"])
                    rows.append({"seed": seed, "seat": observation["activeSeat"],
                                 "round": observation["round"], "parent": old,
                                 "candidate": new})
                observation = client.request(op="step", action={**observation["decision"],
                    "actionId": observation["candidates"][old_index]["id"]})["observation"]
        print(json.dumps({"seeds": args.seeds, "normalOpeningFirstSources": rows},
                         ensure_ascii=False, indent=2))
    finally:
        client.close()


if __name__ == "__main__":
    main()
