"""Two complete games and one short PPO update; never writes a training checkpoint."""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import tempfile
from pathlib import Path

import torch

from scripts import ppo_parallel as parallel
from scripts import ppo_train as ppo
from scripts.ppo_combo_course import TEMPLATES, pool_identity, read_pool
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network
from scripts.ppo_trajectory import TrajectoryStore


def run(pool_path: Path, initial_path: Path, parent_path: Path, all_templates=False):
    torch.set_num_threads(2)
    bundle_directory = tempfile.TemporaryDirectory(prefix="combo-smoke-bundle-")
    clients = parallel.open_clients(2, Path(bundle_directory.name), "signals")
    try:
        encoder = ppo.Encoder(clients[0].schema)
        initial = torch.load(initial_path, map_location="cpu", weights_only=False)
        model = make_network(A2S1_ADAPTER, encoder)
        model.load_state_dict(initial["modelState"], strict=True)
        expected = pool_identity(clients[0], hashlib.sha256(parent_path.read_bytes()).hexdigest(),
                                 ppo.model_weights_sha256(model))
        pool = read_pool(pool_path, expected)
        entries = {f"{entry['template']}:{entry['variant']}:{entry['layer']}": entry
                   for entry in pool["entries"]}
        templates = [item.key for item in TEMPLATES] if all_templates else ["G1"]
        tasks = [{"jobId": "smoke-normal", "seed": 2900001, "policyVersion": 0}]
        tasks.extend({"jobId": f"smoke-{template}", "seed": 2900002 + index,
                      "policyVersion": 0, "courseId": f"{template}:positive:payoff"}
                     for index, template in enumerate(templates))
        optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
        with tempfile.TemporaryDirectory(prefix="combo-smoke-spool-") as temp:
            with TrajectoryStore("A", 0, root=Path(temp), read_limit=32 * 1024 * 1024) as store:
                store, summaries, timing = parallel.collect_batch(
                    clients, encoder, model, torch.device("cpu"), tasks, "A", "signals", 20261004,
                    3000, inference_batch_size=2, inference_wait_ms=1, store=store,
                    combo_entries=entries)
                if len(summaries) != len(tasks) or any(item["termination"] != "natural" for item in summaries):
                    raise AssertionError("Short games did not all finish naturally")
                metrics = ({} if all_templates else ppo.ppo_update(model, optimizer, store,
                    torch.device("cpu"), random.Random(20261004), epochs=1, minibatch=64,
                    gradient_microbatch=16, entropy_coefficient=.01,
                    sampling="chunk-shuffle-epoch-v1"))
                result = {"episodes": summaries, "decisions": len(store),
                          "trajectoryBytes": timing["trajectory"]["trajectoryFileBytes"],
                          "collectionSeconds": timing["collectionSeconds"],
                          "optimization": metrics, "spoolRemovedAfterClose": None}
                path = store.directory
        result["spoolRemovedAfterClose"] = not path.exists()
        return result
    finally:
        for client in clients:
            client.close()
        bundle_directory.cleanup()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--all-templates", action="store_true")
    parser.add_argument("--pool", type=Path, default=ppo.ROOT / "PPO训练" / ".state" /
                        "A2S1C1" / "course-pool-v1.json.gz")
    parser.add_argument("--initial", type=Path, default=ppo.ROOT / "PPO训练" / ".state" /
                        "A2S1C1" / "initial.pt")
    parser.add_argument("--parent", type=Path, default=ppo.ROOT / "PPO训练" / ".state" /
                        "A2S1" / "latest.pt")
    args = parser.parse_args()
    result = run(args.pool, args.initial, args.parent, args.all_templates)
    print(json.dumps({"episodeCount": len(result["episodes"]),
                      "decisions": result["decisions"],
                      "trajectoryBytes": result["trajectoryBytes"],
                      "collectionSeconds": result["collectionSeconds"],
                      "spoolRemoved": result["spoolRemovedAfterClose"],
                      "course": [{"id": item["courseId"], "decisions": item["decisions"],
                                  "tactical": (item.get("comboCourse") or {}).get("tacticalResultAchieved")}
                                 for item in result["episodes"] if item["courseId"]],
                      "loss": result["optimization"].get("loss")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
