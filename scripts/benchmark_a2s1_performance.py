"""Bounded synthetic A2S1 encoding/spool/update benchmark; never saves a model."""
from __future__ import annotations

import argparse
import copy
import json
import random
import tempfile
import time
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network
from scripts.ppo_parallel import _available_physical_memory, _process_sample
from scripts.ppo_trajectory import TrajectoryStore


def run(count: int, rows: int, legacy: bool = False):
    client = ppo.ArenaClient(card_set="signals")
    try:
        observation = client.request(op="reset", seed=20266930, mode="A",
                                     cardSet="signals")["observation"]
        encoder = ppo.Encoder(client.schema)
        timings = {}
        for name, encode in (("reference", encoder.encode_reference),
                             ("optimized", encoder.encode)):
            started = time.perf_counter()
            for _ in range(20):
                state, candidates = encode(observation)
            timings[name] = (time.perf_counter() - started) / 20
        with tempfile.TemporaryDirectory(prefix="ppo-a2s1-benchmark-") as directory:
            with TrajectoryStore("A", 2, root=Path(directory), read_limit=1536 * 1024 ** 2) as store:
                write_started = time.perf_counter()
                for index in range(count):
                    # Actual A2S1 dimensions, deliberately varied and sometimes
                    # larger than the measured opening; no game or PPO rollout.
                    width = rows + (index % 3) * rows // 2
                    item = {"state": state.to(torch.float16),
                            "candidates": candidates[0].expand(width, -1).clone().to(torch.float16),
                            "seat": "germany", "action": index % width,
                            "logprob": -1.0, "value": 0.0, "baseline": False}
                    sample_id = store.append(item)
                    store.finish_episode([{"sampleId": sample_id, "advantage": (index % 7 - 3) / 10,
                                           "target": .01 * index, "actualReturn": .01 * index}])
                store.seal()
                write_seconds = time.perf_counter() - write_started
                read_started = time.perf_counter()
                for batch in store.epoch_batches(list(range(count)), random.Random(1), 64):
                    store.load_batch(batch)
                read_seconds = time.perf_counter() - read_started
                device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
                legacy_result = None
                torch.manual_seed(20266930)
                def warmup(network):
                    with torch.inference_mode():
                        network(*ppo.batch_tensors([{"state": state, "candidates": candidates}], device))
                    if device.type == "cuda":
                        torch.cuda.synchronize()

                def clear_read_cache():
                    store.cache.clear()
                    store.cache_bytes = 0

                if legacy:
                    old_model = make_network(A2S1_ADAPTER, encoder).to(device)
                    initial_state = copy.deepcopy(old_model.state_dict())
                    old_optimizer = torch.optim.Adam(old_model.parameters(), lr=3e-4)
                    warmup(old_model)
                    clear_read_cache()
                    started_old = time.perf_counter()
                    old_metrics = ppo.ppo_update(old_model, old_optimizer, store, device,
                        random.Random(2), epochs=1, minibatch=64, gradient_microbatch=16,
                        entropy_coefficient=.01, sampling="global-shuffle-v1")
                    if device.type == "cuda":
                        torch.cuda.synchronize()
                    legacy_result = {"updateSeconds": time.perf_counter() - started_old,
                                     "sampling": old_metrics["sampling"], "microbatch": 16}
                    del old_optimizer, old_model
                model = make_network(A2S1_ADAPTER, encoder).to(device)
                if legacy:
                    model.load_state_dict(initial_state)
                optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
                warmup(model)
                clear_read_cache()
                if device.type == "cuda":
                    torch.cuda.reset_peak_memory_stats()
                before_rss = _process_sample(__import__("os").getpid())
                before_available = _available_physical_memory()
                started = time.perf_counter()
                metrics = ppo.ppo_update(model, optimizer, store, device, random.Random(2),
                    epochs=1, minibatch=64, gradient_microbatch=64,
                    entropy_coefficient=.01, sampling="chunk-shuffle-epoch-v1")
                if device.type == "cuda":
                    torch.cuda.synchronize()
                update_seconds = time.perf_counter() - started
                after_rss = _process_sample(__import__("os").getpid())
                result = {"scope": "synthetic fixed observation and trajectory; one PPO epoch only",
                          "samples": count, "candidateRowsBase": rows,
                          "encodingSecondsPerObservation": timings,
                          "writeSeconds": write_seconds, "readPassSeconds": read_seconds,
                          "updateSeconds": update_seconds,
                          "legacyUpdate": legacy_result,
                          "trajectory": store.stats(), "optimization": metrics,
                          "rssBeforeBytes": before_rss[0] if before_rss else None,
                          "rssAfterBytes": after_rss[0] if after_rss else None,
                          "systemAvailableBeforeBytes": before_available,
                          "systemAvailableAfterBytes": _available_physical_memory(),
                          "gpuPeakAllocatedBytes": torch.cuda.max_memory_allocated() if device.type == "cuda" else 0,
                          "gpuPeakReservedBytes": torch.cuda.max_memory_reserved() if device.type == "cuda" else 0}
            result["temporaryRemoved"] = not any(Path(directory).iterdir())
        return result
    finally:
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=int, default=64)
    parser.add_argument("--rows", type=int, default=32)
    parser.add_argument("--legacy", action="store_true")
    arguments = parser.parse_args()
    if not (1 <= arguments.samples <= 64 and 1 <= arguments.rows <= 64):
        parser.error("Short benchmark is capped at 64 samples and 64 base candidates")
    print(json.dumps(run(arguments.samples, arguments.rows, arguments.legacy), ensure_ascii=False, indent=2))
