"""Forty complete episodes per PPO update with one model and persistent arenas."""
from __future__ import annotations

import argparse
import ctypes
import gc
import hashlib
import json
import math
import os
import random
import statistics
import subprocess
import tempfile
import threading
import time
from collections import defaultdict, deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_progress import ProgressDisplay, ordinal
from scripts.ppo_trajectory import TrajectoryStore, ROOT as TRAJECTORY_ROOT, cleanup_stale

BATCH_EPISODES = 40
POLICY_SALT = 0x9E3779B97F4A7C15


class _MemoryCounters(ctypes.Structure):
    _fields_ = [("cb", ctypes.c_ulong), ("pageFaultCount", ctypes.c_ulong),
                ("peakWorkingSetSize", ctypes.c_size_t), ("workingSetSize", ctypes.c_size_t),
                ("quotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("quotaPagedPoolUsage", ctypes.c_size_t),
                ("quotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("quotaNonPagedPoolUsage", ctypes.c_size_t),
                ("pagefileUsage", ctypes.c_size_t), ("peakPagefileUsage", ctypes.c_size_t)]


class _FileTime(ctypes.Structure):
    _fields_ = [("low", ctypes.c_ulong), ("high", ctypes.c_ulong)]


def _process_sample(pid):
    if os.name != "nt":
        return None
    kernel = ctypes.windll.kernel32
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.GetProcessTimes.argtypes = [ctypes.c_void_p, ctypes.POINTER(_FileTime),
        ctypes.POINTER(_FileTime), ctypes.POINTER(_FileTime), ctypes.POINTER(_FileTime)]
    ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p,
        ctypes.POINTER(_MemoryCounters), ctypes.c_ulong]
    handle = kernel.OpenProcess(0x1000 | 0x10, False, pid)
    if not handle:
        return None
    try:
        memory = _MemoryCounters()
        memory.cb = ctypes.sizeof(memory)
        created, exited, cpu_kernel, cpu_user = (_FileTime() for _ in range(4))
        if not ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb):
            return None
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                      ctypes.byref(cpu_kernel), ctypes.byref(cpu_user)):
            return None
        ticks = lambda value: (value.high << 32) | value.low
        return memory.workingSetSize, (ticks(cpu_kernel) + ticks(cpu_user)) / 10_000_000
    finally:
        kernel.CloseHandle(handle)


class ProcessMonitor:
    def __init__(self, clients):
        self.pids = [os.getpid()] + [client.process.pid for client in clients]
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.peak_rss = 0
        self.peak_python_rss = 0
        self.peak_worker_rss = 0
        self.cpu_start = {}
        self.cpu_end = {}

    def _loop(self):
        while not self.stop.is_set():
            samples = [_process_sample(pid) for pid in self.pids]
            resident = sum(sample[0] for sample in samples if sample)
            self.peak_rss = max(self.peak_rss, resident)
            self.peak_python_rss = max(self.peak_python_rss, samples[0][0] if samples[0] else 0)
            self.peak_worker_rss = max(self.peak_worker_rss, sum(
                sample[0] for sample in samples[1:] if sample))
            for pid, sample in zip(self.pids, samples):
                if sample:
                    self.cpu_start.setdefault(pid, sample[1])
                    self.cpu_end[pid] = sample[1]
            self.stop.wait(0.5)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join()

    def report(self, wall_seconds):
        cpu = sum(self.cpu_end[pid] - start for pid, start in self.cpu_start.items())
        return {"peakTotalRssBytes": self.peak_rss,
                "peakPythonRssBytes": self.peak_python_rss,
                "peakWorkerRssBytes": self.peak_worker_rss,
                "cpuSeconds": cpu, "cpuCoreEquivalent": cpu / max(wall_seconds, 1e-9),
                "cpuPercentOfMachine": cpu / max(wall_seconds, 1e-9) /
                max(os.cpu_count() or 1, 1) * 100}


def phase_resources(clients, store, device):
    python = _process_sample(os.getpid())
    workers = [_process_sample(client.process.pid) for client in clients]
    live_storages = {}
    for obj in gc.get_objects():
        if not issubclass(type(obj), torch.Tensor):
            continue
        try:
            storage = obj.untyped_storage()
            live_storages[storage.data_ptr()] = storage.nbytes()
        except (RuntimeError, TypeError, AttributeError):
            continue
    return {"pythonRssBytes": python[0] if python else None,
            "workerRssBytes": sum(item[0] for item in workers if item),
            "liveTensorStorageBytes": sum(live_storages.values()),
            "writeBufferBytes": len(store.buffer) if store else 0,
            "readCacheBytes": store.cache_bytes if store else 0,
            "gpuAllocatedBytes": torch.cuda.memory_allocated() if device.type == "cuda" else 0,
            "gpuReservedBytes": torch.cuda.memory_reserved() if device.type == "cuda" else 0,
            "rssMeaning": "process resident set; liveTensorStorageBytes counts reachable tensor storages; residual RSS includes allocator/native retention; OS file cache not measured"}


@dataclass
class Episode:
    task: dict
    environment: int
    observation: dict
    rng: random.Random
    started: float = field(default_factory=time.perf_counter)
    samples: list = field(default_factory=list)
    rewards: list = field(default_factory=list)
    elapsed: list = field(default_factory=list)
    choices: dict = field(default_factory=lambda: defaultdict(int))
    sources: dict = field(default_factory=lambda: defaultdict(int))
    submitted: dict = field(default_factory=lambda: defaultdict(int))
    resolved: dict = field(default_factory=lambda: defaultdict(int))
    openness: list = field(default_factory=list)
    candidate_counts: list = field(default_factory=list)
    outcome: dict | None = None


def make_tasks(start_seed: int, count: int, update: int, mode: str) -> list[dict]:
    if count < 1:
        raise ValueError("Episode count must be positive")
    return [{"jobId": f"{mode}-update-{update}-job-{i}", "seed": start_seed + i,
             "policyVersion": update - 1} for i in range(count)]


def policy_rng(seed: int, policy_version: int, training_seed: int) -> random.Random:
    return random.Random((seed << 32) ^ (policy_version << 16) ^ training_seed ^ POLICY_SALT)


def sample_probabilities(probabilities, rng: random.Random) -> int:
    draw = rng.random()
    total = 0.0
    for index, probability in enumerate(probabilities):
        total += probability
        if draw < total:
            return index
    return len(probabilities) - 1


def batched_actions(model, encoder, device, episodes: list[Episode]):
    encode_started = time.perf_counter()
    encoded = [encoder.encode(episode.observation) for episode in episodes]
    encode_seconds = time.perf_counter() - encode_started
    infer_started = time.perf_counter()
    with torch.inference_mode():
        logits, values = model(*ppo.batch_tensors([
            {"state": state, "candidates": candidates} for state, candidates in encoded], device))
        probabilities = [torch.softmax(logits[i, :len(episode.observation["candidates"])], -1)
                         .cpu().tolist() for i, episode in enumerate(episodes)]
        values = values.cpu().tolist()
    if device.type == "cuda":
        torch.cuda.synchronize()
    infer_seconds = time.perf_counter() - infer_started
    actions = []
    for episode, (state, candidates), probs, value in zip(episodes, encoded, probabilities, values):
        index = sample_probabilities(probs, episode.rng)
        actions.append((index, float(max(probs[index], 1e-38)), float(value),
                        state.to(torch.float16), candidates.to(torch.float16)))
    return actions, encode_seconds, infer_seconds


def episode_summary(episode: Episode, snapshot: dict) -> dict:
    state = snapshot["state"]
    decks = state["decks"]
    consumed = sum(1 for deck in decks.values()
                   for zone in ("discardPile", "active", "removed", "faceDown")
                   for card in deck[zone] if card["definitionId"].startswith("special_"))
    outcome = episode.outcome
    action_digest = hashlib.sha256(json.dumps([(sample["seat"], sample["action"])
        for sample in episode.samples], separators=(",", ":")).encode()).hexdigest()
    return {"jobId": episode.task["jobId"], "seed": episode.task["seed"],
            "policyVersion": episode.task["policyVersion"],
            "termination": outcome["termination"], "winner": outcome["winner"],
            "round": outcome["round"], "allianceScores": outcome["allianceScores"],
            "decisions": len(episode.samples), "countryTurns": sum(episode.elapsed),
            "actionSequenceSha256": action_digest,
            "choices": dict(episode.choices), "sources": dict(episode.sources),
            "submitted": dict(episode.submitted), "resolved": dict(episode.resolved),
            "shaped": {team: sum(r[team] for r in episode.rewards)
                       for team in ("axis", "allies")},
            "consumedEvents": consumed,
            "meanOpenFraction": statistics.fmean(episode.openness) if episode.openness else 0.0,
            "remainingBySeat": {seat: len(deck["hand"]) for seat, deck in decks.items()},
            "discardedBySeat": {seat: len(deck["discardPile"]) for seat, deck in decks.items()},
            "candidateMean": statistics.fmean(episode.candidate_counts),
            "candidateMax": max(episode.candidate_counts),
            "wallSeconds": time.perf_counter() - episode.started}


def collect_batch(clients, encoder, model, device, tasks, mode, card_set, training_seed,
                  max_decisions, inference_batch_size=8, inference_wait_ms=2.0,
                  diagnostic_path: Path | None = None, trace="none", on_progress=None,
                  store: TrajectoryStore | None = None):
    """No weight changes occur here. Each task is claimed once, then finishes naturally."""
    if len({task["jobId"] for task in tasks}) != len(tasks):
        raise ValueError("Duplicate episode jobs")
    if len({task["seed"] for task in tasks}) != len(tasks):
        raise ValueError("Duplicate episode seeds")
    if len({task["policyVersion"] for task in tasks}) != 1:
        raise ValueError("Mixed policy versions in collection batch")
    if store is None:
        raise ValueError("A bounded trajectory store is required")
    waiting = deque(tasks)
    active: dict[int, Episode] = {}
    pending = {}
    ready: list[int] = []
    completed = []
    summaries = []
    timing = defaultdict(float)
    started = time.perf_counter()
    model.eval()

    with ThreadPoolExecutor(max_workers=len(clients)) as executor:
        def submit(environment, kind, episode=None, **request):
            future = executor.submit(clients[environment].request, **request)
            pending[future] = (environment, kind, episode, request.get("tag"))

        def start_next(environment):
            if not waiting:
                return
            task = waiting.popleft()
            tag = {"environmentId": environment, "jobId": task["jobId"],
                   "episodeId": f"ppo-{mode}-{task['seed']}", "decisionId": -1,
                   "policyVersion": task["policyVersion"]}
            submit(environment, "reset", task, op="reset", seed=task["seed"], mode=mode,
                   cardSet=card_set, trace=trace, gameId=tag["episodeId"], tag=tag)

        for environment in range(min(len(clients), len(tasks))):
            start_next(environment)
        try:
            while len(completed) < len(tasks):
                if ready:
                    if pending and len(ready) < inference_batch_size:
                        finished, _ = wait(pending, timeout=inference_wait_ms / 1000,
                                           return_when=FIRST_COMPLETED)
                    else:
                        finished = set()
                else:
                    if not pending:
                        raise RuntimeError("No active tasks before batch completed")
                    finished, _ = wait(pending, return_when=FIRST_COMPLETED)
                for future in finished:
                    environment, kind, item, tag = pending.pop(future)
                    response = future.result()
                    if response.get("tag") != tag:
                        raise RuntimeError("Stale or misrouted arena response")
                    if kind == "reset":
                        obs = response["observation"]
                        if obs is None:
                            raise RuntimeError("Reset produced no decision")
                        if response["header"]["gameId"] != tag["episodeId"]:
                            raise RuntimeError("Reset game ID mismatch")
                        active[environment] = Episode(item, environment, obs,
                            policy_rng(item["seed"], item["policyVersion"], training_seed))
                        ready.append(environment)
                    elif kind == "step":
                        episode = item
                        if active.get(environment) is not episode:
                            raise RuntimeError("Action result routed to wrong episode")
                        info = response["info"]
                        if info["decision"] != tag["decision"]:
                            raise RuntimeError("Stale decision result")
                        previous = episode.observation
                        outcome = response["result"]
                        after = outcome["allianceScores"] if outcome else response["observation"]["allianceScores"]
                        natural = bool(outcome and outcome["termination"] == "natural")
                        episode.rewards.append({team: ppo.shaped_reward(
                            previous["allianceScores"], after, team, natural,
                            outcome["winner"] if outcome else None) for team in ("axis", "allies")})
                        episode.elapsed.append(info["turnsAdvanced"])
                        for name in info.get("submittedCardDefinitions", []):
                            episode.submitted[name] += 1
                        for name in info.get("resolvedCardDefinitions", []):
                            episode.resolved[name] += 1
                        if outcome:
                            if outcome["termination"] != "natural":
                                raise RuntimeError(f"Episode {episode.task['jobId']} truncated: {outcome.get('reason')}")
                            episode.outcome = outcome
                            submit(environment, "snapshot", episode, op="snapshot", tag=tag)
                        else:
                            episode.observation = response["observation"]
                            if len(episode.samples) >= max_decisions:
                                raise RuntimeError(f"Episode {episode.task['jobId']} exceeded {max_decisions} decisions")
                            ready.append(environment)
                    elif kind == "snapshot":
                        episode = item
                        if episode.outcome is None:
                            raise RuntimeError("Snapshot before natural termination")
                        ppo.assign_advantages(episode.samples, episode.rewards, episode.elapsed)
                        store.finish_episode(episode.samples)
                        summaries.append(episode_summary(episode, response["snapshot"]))
                        completed.append(episode.task["seed"])
                        if on_progress:
                            on_progress(len(completed))
                        del active[environment]
                        start_next(environment)
                    else:
                        raise RuntimeError(f"Unknown worker operation {kind}")
                if ready:
                    selected = ready[:inference_batch_size]
                    del ready[:len(selected)]
                    episodes = [active[environment] for environment in selected]
                    actions, encode_seconds, infer_seconds = batched_actions(
                        model, encoder, device, episodes)
                    timing["encodeSeconds"] += encode_seconds
                    timing["inferenceSeconds"] += infer_seconds
                    timing["inferenceBatches"] += 1
                    for episode, (index, probability, value, state, candidates) in zip(episodes, actions):
                        observation = episode.observation
                        if len(episode.samples) >= max_decisions:
                            raise RuntimeError(f"Episode {episode.task['jobId']} exceeded {max_decisions} decisions")
                        chosen = observation["candidates"][index]
                        sample = {"seat": observation["decisionSeat"],
                            "state": state, "candidates": candidates, "action": index,
                            "logprob": math.log(probability), "value": value, "baseline": False}
                        sample_id = store.append(sample)
                        episode.samples.append({"seat": sample["seat"], "action": index,
                            "logprob": sample["logprob"], "value": value,
                            "baseline": False, "sampleId": sample_id})
                        episode.candidate_counts.append(len(observation["candidates"]))
                        episode.choices[chosen["kind"]] += 1
                        if chosen["kind"] == "source":
                            episode.sources[chosen.get("definitionId") or "unknown"] += 1
                        own = observation["ownResources"]
                        remaining = sum(own["remaining"].values())
                        if remaining:
                            episode.openness.append(sum(own["open"].values()) / remaining)
                        decision = observation["decision"]
                        tag = {"environmentId": episode.environment,
                               "jobId": episode.task["jobId"],
                               "episodeId": decision["episodeId"],
                               "decisionId": decision["decisionId"],
                               "policyVersion": episode.task["policyVersion"],
                               "decision": decision}
                        submit(episode.environment, "step", episode, op="step",
                               action={**decision, "actionId": chosen["id"]}, tag=tag)
        except Exception as error:
            if diagnostic_path:
                for future in pending:
                    try:
                        future.result(timeout=10)
                    except Exception:
                        pass
                snapshots = {}
                for environment, episode in active.items():
                    try:
                        snapshots[str(environment)] = clients[environment].request(op="snapshot")["snapshot"]
                    except Exception as snapshot_error:
                        snapshots[str(environment)] = {"error": str(snapshot_error)}
                diagnostic_path.parent.mkdir(parents=True, exist_ok=True)
                diagnostic_path.write_text(json.dumps({
                    "error": str(error), "policyVersion": tasks[0]["policyVersion"],
                    "tasks": tasks, "completed": summaries,
                    "waiting": list(waiting), "activeSnapshots": snapshots,
                    "resumePolicy": "restart entire batch from last completed update"
                }, ensure_ascii=False, indent=2), encoding="utf-8")
            raise
    timing["collectionSeconds"] = time.perf_counter() - started
    timing["transport"] = {name: sum(client.transport[name] for client in clients)
                           for name in clients[0].transport}
    timing["summedServerOperationSeconds"] = timing["transport"]["serverOperationSeconds"]
    timing["summedTransportAndQueueSecondsUpperBound"] = max(0.0,
        timing["transport"]["waitSeconds"] - timing["transport"]["serverOperationSeconds"])
    if len(completed) != len(tasks) or sorted(completed) != sorted(task["seed"] for task in tasks):
        raise RuntimeError("Batch task accounting mismatch")
    store.seal()
    timing["trajectory"] = store.stats()
    return store, summaries, dict(timing)


def open_clients(count: int, directory: Path):
    clients = []
    bundle = directory / "ppo-arena-bundle.mjs"
    try:
        for _ in range(count):
            client = ppo.ArenaClient(bundle_path=bundle)
            if clients and (client.fingerprint != clients[0].fingerprint or client.schema != clients[0].schema):
                client.close()
                raise RuntimeError("Workers have different rule builds")
            clients.append(client)
        return clients
    except Exception:
        for client in clients:
            client.close()
        raise


def summarize_evaluation(games):
    summary = {}
    for learner in ("axis", "allies"):
        rows = [game for game in games if game["learnerTeam"] == learner]
        if not rows:
            continue
        gaps = [game["scoreDifference"] * (1 if learner == "axis" else -1) for game in rows]
        summary[learner] = {"games": len(rows),
            "wins": sum(game["winner"] == learner for game in rows),
            "winRate": sum(game["winner"] == learner for game in rows) / len(rows),
            "scoreDifferenceMean": statistics.fmean(gaps),
            "roundMean": statistics.fmean(game["round"] for game in rows),
            "countryTurnsMean": statistics.fmean(game["countryTurns"] for game in rows),
            "passMean": statistics.fmean(game["choices"].get("pass", 0) for game in rows),
            "sourceSelectionsMean": statistics.fmean(game["choices"].get("source", 0)
                                                 for game in rows),
            "consumedEventsMean": statistics.fmean(game["consumedEvents"] for game in rows)}
    return summary


def main():
    parser = argparse.ArgumentParser(description="Parallel complete-episode PPO training")
    parser.add_argument("--mode", choices=["A", "B"], required=True)
    parser.add_argument("--card-set", choices=["basics", "events"], default="events")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--inference-batch-size", type=int, default=8)
    parser.add_argument("--inference-wait-ms", type=float, default=2.0)
    parser.add_argument("--updates", type=int, default=1)
    parser.add_argument("--episodes-per-update", type=int, default=BATCH_EPISODES)
    parser.add_argument("--max-episode-decisions", type=int, default=3000)
    parser.add_argument("--seed", type=int, default=20260930)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--trace", choices=["none", "summary", "full"], default="none")
    # Accepted for old short-benchmark commands; automatic baseline evaluations
    # are no longer part of training or round output.
    parser.add_argument("--eval-seeds", type=int, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--no-eval", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--cpu", action="store_true")
    args = parser.parse_args()
    if args.workers < 1 or args.inference_batch_size < 1 or args.inference_wait_ms < 0:
        parser.error("Invalid worker or inference batch configuration")
    if args.episodes_per_update != BATCH_EPISODES:
        parser.error("Production PPO updates require exactly 40 complete episodes")
    if args.updates < 0:
        parser.error("updates must be nonnegative")
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    device = torch.device("cpu" if args.cpu or not torch.cuda.is_available() else "cuda")
    rng = random.Random(args.seed)
    torch.manual_seed(args.seed)
    cleanup_stale(TRAJECTORY_ROOT)
    with tempfile.TemporaryDirectory(prefix="ppo-parallel-") as directory:
        print(f"{args.mode}：启动 {min(args.workers, BATCH_EPISODES)} 个环境并加载模型...", flush=True)
        startup_started = time.perf_counter()
        clients = open_clients(min(args.workers, BATCH_EPISODES), Path(directory))
        try:
            encoder = ppo.Encoder(clients[0].schema)
            model = ppo.PpoNetwork(encoder.state_dim, encoder.candidate_dim).to(device)
            optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
            startup_seconds = time.perf_counter() - startup_started
            print(f"{args.mode}：环境就绪，耗时 {startup_seconds:.1f}s。", flush=True)
            next_seed, completed_decisions, completed_episodes, start_update = args.seed, 0, 0, 0
            if args.resume:
                saved = ppo.restore_checkpoint(args.checkpoint, model, optimizer, encoder,
                                               clients[0], args.mode, rng, args.card_set,
                                               training_seed=args.seed)
                next_seed = saved["nextSeed"]
                completed_decisions = saved["completedDecisions"]
                completed_episodes = saved["completedEpisodes"]
                start_update = saved["update"]
            try:
                source_commit = subprocess.check_output(
                    ["git", "rev-parse", "HEAD"], cwd=ppo.ROOT, text=True).strip()
                source_dirty = bool(subprocess.check_output(
                    ["git", "status", "--porcelain"], cwd=ppo.ROOT, text=True).strip())
            except (OSError, subprocess.CalledProcessError):
                source_commit, source_dirty = None, None
            report = {"mode": args.mode, "cardSet": args.card_set,
                      "sourceCommit": source_commit, "sourceDirty": source_dirty,
                      "trainerSourceSha256": ppo.TRAINER_SOURCE_HASH,
                      "buildFingerprint": clients[0].fingerprint,
                      "observationSchemaVersion": clients[0].schema["observationSchemaVersion"],
                      "actionSchemaVersion": clients[0].schema["actionSchemaVersion"],
                      "encoderVersion": ppo.ENCODER_VERSION,
                      "courseVersion": clients[0].schema["courseVersion"],
                      "overridesVersion": clients[0].schema["overridesVersion"],
                      "device": str(device), "workers": len(clients),
                      "startupSeconds": startup_seconds,
                      "inferenceBatchSize": args.inference_batch_size,
                      "inferenceWaitMs": args.inference_wait_ms,
                      "stateDim": encoder.state_dim, "candidateDim": encoder.candidate_dim,
                      "parameters": sum(p.numel() for p in model.parameters()), "updates": []}
            if args.resume and args.report and args.report.exists():
                previous_report = json.loads(args.report.read_text(encoding="utf-8"))
                previous_updates = previous_report.get("updates", [])
                if (previous_report.get("mode") != args.mode or
                    previous_report.get("cardSet") != args.card_set or
                    previous_report.get("buildFingerprint") != clients[0].fingerprint or
                    not previous_updates or previous_updates[-1]["number"] != start_update):
                    raise ValueError("Existing report does not match the resumed checkpoint")
                report = previous_report
                if report.get("trainerSourceSha256") != ppo.TRAINER_SOURCE_HASH:
                    report["priorTrainerSourceSha256"] = report.get("trainerSourceSha256")
                    report["trainerSourceSha256"] = ppo.TRAINER_SOURCE_HASH
                # Older reports may retain the removed fixed-opponent evaluations.
                for obsolete in ("baselineEvaluation", "baselineEvaluationSeconds", "evaluations"):
                    report.pop(obsolete, None)
            warmup_started = time.perf_counter()
            dummy = encoder._dummy()
            dummy["candidates"] = [{"kind": "pass", "id": "warmup"}]
            with torch.inference_mode():
                state, candidates = encoder.encode(dummy)
                model(*ppo.batch_tensors([{"state": state, "candidates": candidates}], device))
                if device.type == "cuda":
                    torch.cuda.synchronize()
            report["warmupSeconds"] = time.perf_counter() - warmup_started
            for update in range(start_update + 1, start_update + args.updates + 1):
                if device.type == "cuda":
                    torch.cuda.reset_peak_memory_stats()
                tasks = make_tasks(next_seed, BATCH_EPISODES, update, args.mode)
                diagnostic = args.checkpoint.with_suffix(f".failed-update-{update}.json")
                monitored_started = time.perf_counter()
                label = (f"{args.mode} {ordinal((update - 1) // 10 + 1, '轮')} · "
                         f"{ordinal((update - 1) % 10 + 1, '次更新')}")
                store = TrajectoryStore(args.mode, update, root=TRAJECTORY_ROOT)
                phases = {"beforeCollection": phase_resources(clients, store, device)}
                result = None
                try:
                    with ProgressDisplay(label, BATCH_EPISODES) as progress:
                        with ProcessMonitor(clients) as monitor:
                            samples, episodes, timing = collect_batch(clients, encoder, model, device,
                                tasks, args.mode, args.card_set, args.seed, args.max_episode_decisions,
                                args.inference_batch_size, args.inference_wait_ms, diagnostic, args.trace,
                                on_progress=progress.update, store=store)
                            phases["afterCollection"] = phase_resources(clients, store, device)
                            progress.set_stage("优化中")
                            optimization_started = time.perf_counter()
                            model.train()
                            metrics = ppo.ppo_update(model, optimizer, store, device, rng)
                            optimization_seconds = time.perf_counter() - optimization_started
                            phases["afterUpdate"] = phase_resources(clients, store, device)
                    resource = monitor.report(time.perf_counter() - monitored_started)
                    batch_decisions = len(store)
                    completed_decisions += batch_decisions
                    completed_episodes += BATCH_EPISODES
                    next_seed += BATCH_EPISODES
                    payload = ppo.checkpoint_payload(model, optimizer, encoder, clients[0],
                        args.mode, update, completed_decisions, rng, next_seed, args.card_set,
                        completed_episodes=completed_episodes, training_seed=args.seed)
                    args.checkpoint.parent.mkdir(parents=True, exist_ok=True)
                    temporary = args.checkpoint.with_suffix(".tmp")
                    torch.save(payload, temporary)
                    temporary.replace(args.checkpoint)
                    del payload
                    lengths = [episode["decisions"] for episode in episodes]
                    result = {"number": update, "episodeCount": len(episodes),
                              "tasks": tasks, "episodes": sorted(episodes, key=lambda e: e["seed"]),
                              "completedDecisions": batch_decisions,
                              "completedCountryTurns": sum(e["countryTurns"] for e in episodes),
                              "episodeLength": {"min": min(lengths), "max": max(lengths),
                                                "mean": statistics.fmean(lengths),
                                                "median": statistics.median(lengths)},
                              "collection": timing, "optimizationSeconds": optimization_seconds,
                              "resource": resource, "resourceStages": phases,
                              "trajectory": store.stats(),
                              "completedDecisionsPerSecond": batch_decisions / timing["collectionSeconds"],
                              "optimization": metrics,
                              "gpuPeakAllocatedBytes": torch.cuda.max_memory_allocated()
                              if device.type == "cuda" else 0,
                              "gpuPeakReservedBytes": torch.cuda.max_memory_reserved()
                              if device.type == "cuda" else 0}
                    report["updates"].append(result)
                    if args.report:
                        args.report.parent.mkdir(parents=True, exist_ok=True)
                        temporary_report = args.report.with_suffix(args.report.suffix + ".tmp")
                        temporary_report.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                                                    encoding="utf-8")
                        temporary_report.replace(args.report)
                finally:
                    cleanup_result = store.close()
                    # `samples` aliases `store`; delete it before the next collect_batch call.
                    if "samples" in locals() and samples is store:
                        del samples
                    del store
                if result is not None:
                    result["trajectoryCleanup"] = cleanup_result
                    phases["afterCleanup"] = phase_resources(clients, None, device)
                    if args.report:
                        temporary_report = args.report.with_suffix(args.report.suffix + ".tmp")
                        temporary_report.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                                                    encoding="utf-8")
                        temporary_report.replace(args.report)
            if args.report:
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"{args.mode}：本轮训练检查点已保存；详细指标见 {args.report or args.checkpoint.parent}。",
                  flush=True)
        finally:
            for client in clients:
                client.close()


if __name__ == "__main__":
    main()
