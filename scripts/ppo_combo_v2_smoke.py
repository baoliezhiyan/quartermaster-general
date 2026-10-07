"""One normal and one C2 continuation, followed by one disposable short PPO pass."""
from __future__ import annotations

import hashlib
import json
import random
import tempfile
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts import ppo_parallel as parallel
from scripts import ppo_combo_course_v2 as course
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network
from scripts.ppo_trajectory import TrajectoryStore


def run(initial_path: Path, pool_path: Path, *, parent_direct_test=False):
    torch.set_num_threads(2)
    with tempfile.TemporaryDirectory(prefix="a2s1c2-smoke-workers-") as folder:
        clients = parallel.open_clients(2, Path(folder), "signals")
        try:
            encoder = ppo.Encoder(clients[0].schema)
            if parent_direct_test:
                from scripts.ppo_combo_course import load_parent
                model, _ = load_parent(initial_path, encoder, torch.device("cpu"))
                selected = course.generate_one(clients[0], encoder, model, torch.device("cpu"),
                                               course.BY_KEY["U4"], 2026100500, "positive")
                if "failure" in selected:
                    raise AssertionError("Direct U4 real-engine start generation failed")
                selected.update({"template": "U4", "variant": "positive",
                    "layer": "payoff", "split": "train", "courseId": "U4:positive:payoff:2026100500"})
            else:
                initial = torch.load(initial_path, map_location="cpu", weights_only=False)
                if initial.get("experimentId") != "A2S1C2" or initial.get(
                        "networkArchitecture") != A2S1_ADAPTER:
                    raise ValueError("Smoke test requires the explicit C2 initializer")
                model = make_network(A2S1_ADAPTER, encoder)
                model.load_state_dict(initial["modelState"], strict=True)
                expected = course.pool_identity(clients[0], initial["sourceCheckpointSha256"],
                                                initial["generatorWeightsSha256"])
                pool = course.read_pool(pool_path, expected)
                selected = next(e for e in pool["entries"] if e["template"] == "U4" and
                    e["variant"] == "positive" and e["layer"] == "payoff" and e["split"] == "train")
            tasks = [{"jobId": "c2-smoke-normal", "seed": 20990001, "policyVersion": 0},
                     {"jobId": "c2-smoke-course", "seed": 20990002, "policyVersion": 0,
                      "courseId": course.course_id(selected)}]
            optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
            with tempfile.TemporaryDirectory(prefix="a2s1c2-smoke-spool-") as spool:
                with TrajectoryStore("A", 0, root=Path(spool),
                                     read_limit=32 * 1024 * 1024) as store:
                    store, episodes, timing = parallel.collect_batch(clients, encoder,
                        model, torch.device("cpu"), tasks, "A", "signals", 20261005, 3000,
                        inference_batch_size=2, inference_wait_ms=1, store=store,
                        combo_entries={course.course_id(selected): selected},
                        combo_preparation={})
                    if len(episodes) != 2 or any(e["termination"] != "natural" for e in episodes):
                        raise AssertionError("Both smoke games must finish naturally")
                    sample_count = len(store)
                    disk_bytes = timing["trajectory"]["trajectoryFileBytes"]
                    metrics = ppo.ppo_update(model, optimizer, store, torch.device("cpu"),
                        random.Random(20261005), epochs=1, minibatch=64,
                        gradient_microbatch=16, entropy_coefficient=.01,
                        sampling="chunk-shuffle-epoch-v1")
                    trajectory_path = store.directory
            return {"episodes": 2, "normalEpisodes": 1, "courseEpisodes": 1,
                    "source": "frozen-parent-interface-only" if parent_direct_test else
                              "candidate-a2s1c2-initializer-interface-only",
                    "samples": sample_count, "trajectoryBytes": disk_bytes,
                    "collectionSeconds": timing["collectionSeconds"],
                    "loss": metrics["loss"], "entropy": metrics["entropy"],
                    "temporaryTrajectoryRemoved": not trajectory_path.exists(),
                    "sourceInitializerSha256": hashlib.sha256(initial_path.read_bytes()).hexdigest()}
        finally:
            for client in clients:
                client.close()


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Disposable C2 two-game PPO smoke; no checkpoint")
    parser.add_argument("--initial", type=Path, default=ppo.ROOT / "PPO训练" /
                        ".state" / "A2S1C2" / "initial.pt")
    parser.add_argument("--pool", type=Path, default=ppo.ROOT / "PPO训练" /
                        ".state" / "A2S1C2" / "course-pool-v8.json.gz")
    parser.add_argument("--parent-direct-test", action="store_true",
                        help="Use frozen C1 parent and generate one U4 start; not a C2 migration test")
    args = parser.parse_args()
    source = (ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" / "latest.pt"
              if args.parent_direct_test else args.initial)
    print(json.dumps(run(source, args.pool, parent_direct_test=args.parent_direct_test),
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
