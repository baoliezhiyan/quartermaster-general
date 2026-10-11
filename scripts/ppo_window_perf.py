"""Fixed-workload, window-state-labelled training process diagnostic.

The script never changes window focus, size or visibility. The operator labels
the actual state; unattended runs must use 'unobserved', not claim foreground.
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_auto_archive import ExplorationArchive
from scripts.ppo_auto_explore import FrozenPolicy, run_branch
from scripts.ppo_process_qos import disable_execution_speed_throttling, query


def run(checkpoint, archive_path, label, repeats, no_throttling):
    client = ppo.ArenaClient(card_set="signals")
    try:
        policy = FrozenPolicy(checkpoint, client,
            device="cuda" if torch.cuda.is_available() else "cpu")
        identity = {"sourceCheckpointSha256": policy.file_hash,
                    "sourceWeightsSha256": policy.weight_hash,
                    "buildFingerprint": client.fingerprint,
                    "encoderVersion": ppo.encoder_version("signals"),
                    "rewardConfig": ppo.reward_config("signals"),
                    "explorerVersion": "auto-explorer-v2-causal-review"}
        with ExplorationArchive(archive_path, identity) as archive:
            roots = archive.roots()
            if not roots:
                raise ValueError("The fixed-workload archive has no root")
            root = archive.read_root(roots[0])
            initial_probs, _ = policy.probabilities(root["observation"])
            first_index = max(range(len(initial_probs)), key=initial_probs.__getitem__)
            from contextlib import ExitStack
            with ExitStack() as stack:
                qos = [query(os.getpid()), query(client.process.pid)]
                applied = []
                if no_throttling:
                    applied = [stack.enter_context(disable_execution_speed_throttling(pid))
                               for pid in (os.getpid(), client.process.pid)]
                results = []
                for repeat in range(repeats+1):
                    before = {key: getattr(client, "transport")[key] for key in
                        ("serializeSeconds", "waitSeconds", "parseSeconds",
                         "serverOperationSeconds", "sentBytes", "receivedBytes")}
                    policy_before = dict(policy.timing)
                    started = time.perf_counter()
                    branch = run_branch(client, root, policy, first_index,
                        kind="fixed-benchmark", seed=20261011, max_steps=80)
                    duration = time.perf_counter()-started
                    if repeat == 0:  # JIT, cache and GPU warm-up, reported separately
                        warmup = duration
                        continue
                    transport = {key: client.transport[key]-value for key, value in before.items()}
                    model_timing = {key: policy.timing[key]-value for key, value in policy_before.items()}
                    results.append({"repeat": repeat, "steps": branch["steps"],
                        "endHash": branch["endHash"], "wallSeconds": duration,
                        "environmentSeconds": transport["serverOperationSeconds"],
                        "ipcWaitSeconds": transport["waitSeconds"],
                        "transport": transport, "model": model_timing,
                        "gpuAllocatedBytes": torch.cuda.memory_allocated() if
                            policy.device.type == "cuda" else None,
                        "gpuReservedBytes": torch.cuda.memory_reserved() if
                            policy.device.type == "cuda" else None})
                if len({item["endHash"] for item in results}) != 1 or \
                        len({item["steps"] for item in results}) != 1:
                    raise ValueError("Fixed workload changed its rule result or step count")
                return {"label": label, "pid": os.getpid(), "workerPid": client.process.pid,
                    "device": str(policy.device), "warmupSeconds": warmup,
                    "processBefore": qos, "requestedProcessSetting": applied,
                    "repeats": results, "windowStateOperatorLabel": label,
                    "windowStateVerifiedByProgram": False}
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--label", choices=("foreground", "visible_background",
        "occluded", "minimized", "unobserved"), default="unobserved")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--no-execution-speed-throttling", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.repeats < 1 or args.repeats > 10:
        parser.error("repeats must be between 1 and 10")
    result = run(args.checkpoint, args.archive, args.label, args.repeats,
                 args.no_execution_speed_throttling)
    serialized = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("a", encoding="utf-8") as stream:
            stream.write(serialized + "\n")
    print(serialized)


if __name__ == "__main__":
    main()
