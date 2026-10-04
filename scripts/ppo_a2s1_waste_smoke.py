"""One bounded, disposable A2S1 signal-course collection and PPO update.

This does not save a checkpoint or alter any experiment result. It intentionally
updates a temporary model for one epoch on at most 32 decisions.
"""
from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent", type=Path,
                        default=ppo.ROOT / "PPO训练" / ".state" / "A2S1" / "latest.pt")
    parser.add_argument("--seed", type=int, default=20261004)
    args = parser.parse_args()
    torch.set_num_threads(2)
    started = time.perf_counter()
    saved = torch.load(args.parent, map_location="cpu", weights_only=False)
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        if (saved["networkArchitecture"] != A2S1_ADAPTER or
                saved["network"] != {"stateDim": encoder.state_dim,
                                     "candidateDim": encoder.candidate_dim}):
            raise ValueError("Parent architecture or input dimensions differ")
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        model = make_network(A2S1_ADAPTER, encoder).to(device)
        model.load_state_dict(saved["modelState"], strict=True)
        episode = ppo.play_episode(client, encoder, model, device, "A", args.seed, 600,
                                   card_set="signals", rng=random.Random(args.seed + 7))
        if episode["outcome"]["termination"] != "natural":
            raise RuntimeError("Smoke episode did not end naturally; no PPO update run")
        collected = time.perf_counter()
        batch = [item for item in episode["samples"] if not item["baseline"]][:32]
        optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
        result = ppo.ppo_update(model, optimizer, batch, device,
                                random.Random(args.seed + 11), epochs=1,
                                minibatch=16, gradient_microbatch=8,
                                entropy_coefficient=0.01)
        print(json.dumps({"termination": episode["outcome"]["termination"],
                          "decisions": episode["decisions"],
                          "sampledForShortUpdate": len(batch),
                          "wasteReasons": episode["wasteReasons"],
                          "collectionSeconds": round(collected - started, 3),
                          "shortUpdateSeconds": round(time.perf_counter() - collected, 3),
                          "update": result, "checkpointSaved": False}, ensure_ascii=False))
    finally:
        client.close()


if __name__ == "__main__":
    main()
