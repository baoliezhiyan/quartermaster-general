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
from collections import Counter, defaultdict, deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_train import decision_rewards
from scripts.ppo_progress import ProgressDisplay, ordinal
from scripts.ppo_trajectory import TrajectoryStore, ROOT as TRAJECTORY_ROOT, cleanup_stale

BATCH_EPISODES = 40
POLICY_SALT = 0x9E3779B97F4A7C15
AUTO_EXPERIMENTS = ("A2AUTOBASE", "A2AUTOCAND", "A2AUTO")


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


class _MemoryStatus(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ulong), ("memoryLoad", ctypes.c_ulong),
                ("totalPhysical", ctypes.c_ulonglong), ("availablePhysical", ctypes.c_ulonglong),
                ("totalPageFile", ctypes.c_ulonglong), ("availablePageFile", ctypes.c_ulonglong),
                ("totalVirtual", ctypes.c_ulonglong), ("availableVirtual", ctypes.c_ulonglong),
                ("availableExtendedVirtual", ctypes.c_ulonglong)]


def _available_physical_memory():
    if os.name != "nt":
        return None
    status = _MemoryStatus()
    status.length = ctypes.sizeof(status)
    return status.availablePhysical if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)) else None


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
            "systemAvailablePhysicalBytes": _available_physical_memory(),
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
    start_decision_count: int = 0
    course_tracker: dict | None = None
    landing_tracker: dict | None = None
    last_chosen: dict | None = None
    started: float = field(default_factory=time.perf_counter)
    samples: list = field(default_factory=list)
    rewards: list = field(default_factory=list)
    base_reward_totals: dict = field(default_factory=lambda: defaultdict(float))
    waste_reasons: dict = field(default_factory=lambda: defaultdict(int))
    waste_exemptions: dict = field(default_factory=lambda: defaultdict(int))
    waste_exemptions_by_card: dict = field(default_factory=lambda: defaultdict(lambda: defaultdict(int)))
    waste_penalties: dict = field(default_factory=lambda: defaultdict(int))
    waste_opportunity_decisions: int = 0
    waste_opportunity_choices: int = 0
    policy_entropy_total: float = 0.0
    normalized_entropy_total: float = 0.0
    max_probability_total: float = 0.0
    single_candidate_decisions: int = 0
    elapsed: list = field(default_factory=list)
    choices: dict = field(default_factory=lambda: defaultdict(int))
    sources: dict = field(default_factory=lambda: defaultdict(int))
    source_types: dict = field(default_factory=lambda: defaultdict(int))
    trigger_opportunities: dict = field(default_factory=lambda: defaultdict(int))
    trigger_activations: dict = field(default_factory=lambda: defaultdict(int))
    trigger_skips: int = 0
    trigger_depths: dict = field(default_factory=lambda: defaultdict(int))
    fee_cards_spent: int = 0
    waste_by_card: dict = field(default_factory=lambda: defaultdict(int))
    submitted: dict = field(default_factory=lambda: defaultdict(int))
    resolved: dict = field(default_factory=lambda: defaultdict(int))
    openness: list = field(default_factory=list)
    candidate_counts: list = field(default_factory=list)
    outcome: dict | None = None


def make_tasks(start_seed: int, count: int, update: int, mode: str,
               combo_entries: dict | None = None, combo_version: str | None = None) -> list[dict]:
    if count < 1:
        raise ValueError("Episode count must be positive")
    tasks = [{"jobId": f"{mode}-update-{update}-job-{i}", "seed": start_seed + i,
              "policyVersion": update - 1} for i in range(count)]
    if combo_entries is not None:
        if count != BATCH_EPISODES:
            raise ValueError("Combo course requires exactly 40 complete episodes")
        if combo_version in AUTO_EXPERIMENTS:
            from scripts.ppo_combo_sampler_v2 import plan
            quota = plan(combo_entries, update)
            if len(quota["courseIds"]) != 20:
                raise ValueError("Reviewed C4 sampler no longer has twenty course slots")
            strata = ((0, 9, 2), (9, 12, 1), (12, 18, 3), (18, 20, 1))
            selected = [quota["courseIds"][first + (update - 1 + offset) % (last-first)]
                        for first, last, offset in strata]
            for index, course_id in enumerate(selected):
                tasks[36 + index]["courseId"] = course_id
            for task in tasks:
                task["comboDetail"] = True
            return tasks
        if combo_version == "A2S1C4":
            from scripts.ppo_combo_sampler_v2 import plan
            quota = plan(combo_entries, update)
            for index, course_id in enumerate(quota["courseIds"]):
                tasks[20 + index]["courseId"] = course_id
            for task in tasks:
                task["comboDetail"] = True
            return tasks
        if combo_version in ("A2S1C2", "A2S1C3", "A2S1C4"):
            from scripts.ppo_combo_course_v2 import TEMPLATES
        else:
            from scripts.ppo_combo_course import TEMPLATES
        for index in range(12):
            global_slot = (update - 1) * 12 + index
            template = TEMPLATES[global_slot % len(TEMPLATES)].key
            layer = ("preparation" if (index + update - 1) % 3 == 2 else "payoff") if (
                combo_version in ("A2S1C2", "A2S1C3", "A2S1C4")) else ("preparation" if index % 3 == 2 else "payoff")
            # Each template alternates its own variant across appearances.
            # Slot parity would permanently pair even templates with positives.
            variant = "control" if (global_slot // len(TEMPLATES)) % 2 else "positive"
            prefix = f"{template}:{variant}:{layer}"
            matches = sorted(key for key, entry in combo_entries.items() if
                             (key == prefix or combo_version in ("A2S1C2", "A2S1C3", "A2S1C4") and
                              key.startswith(prefix + ":")) and
                             (combo_version not in ("A2S1C2", "A2S1C3", "A2S1C4") or entry["split"] == "train"))
            if not matches:
                raise ValueError(f"Course pool lacks deterministic quota: {prefix}")
            tasks[28 + index]["courseId"] = matches[(global_slot // (len(TEMPLATES) * 2)) % len(matches)]
        if combo_version == "A2S1C3":
            for task in tasks:
                task["comboDetail"] = True
    return tasks


def discover_off_policy(clients, model, encoder, device, *, update, training_seed,
                        source_hash, archive_root, pairs, review_parent,
                        review_seconds):
    """Separate real-engine exploration; never appends to the PPO trajectory store."""
    from scripts.ppo_auto_archive import ExplorationArchive
    from scripts.ppo_auto_explore import (VERSION, FrozenPolicy, capture_roots,
        explore_pairs, review_routes)
    archive_path = archive_root / f"update-{update:04d}" / "exploration.sqlite"
    policy = FrozenPolicy.from_live(model, encoder, device, source_hash=source_hash)
    identity = {"sourceCheckpointSha256": source_hash,
        "sourceWeightsSha256": policy.weight_hash,
        "buildFingerprint": clients[0].fingerprint,
        "encoderVersion": ppo.encoder_version("signals"),
        "rewardConfig": ppo.reward_config("signals"),
        "explorerVersion": VERSION, "policyVersion": update-1}
    started = time.perf_counter()
    with ExplorationArchive(archive_path, identity) as archive:
        capture = capture_roots(clients[0], policy, archive,
                                training_seed+update*100_003+9_000_000,
                                max_roots=12, max_decisions=240)
        missing = max(0, pairs - archive.branch_pairs())
        branching = explore_pairs(clients[:2], policy, archive,
            max_pairs=missing, max_steps=6000, wall_seconds=1200,
            seed=training_seed+update*100_003+9_100_000)
        pending = len(archive.routes("candidate"))
        if pending:
            parent = FrozenPolicy(review_parent, clients[0], device="cpu")
            review = review_routes(clients[:2], policy, parent, archive,
                max_routes=3, max_steps=20_000, wall_seconds=review_seconds,
                seed=training_seed+update*100_003+9_200_000)
        else:
            review = {"reviewed": [], "steps": 0, "remainingCandidates": 0}
        demonstrations = archive.demonstration_batch(64, training_seed+update)
        sentinel = [archive.read_root(root)["observation"]
                    for root in archive.roots()[:4]]
        stats = archive.stats()
    return {"version": VERSION, "archive": str(archive_path),
            "identity": identity, "capture": capture,
            "branching": {key: value for key, value in branching.items() if key != "branches"},
            "review": review, "archiveStats": stats,
            "environmentSteps": capture["decisions"]+branching["steps"]+review["steps"],
            "seconds": time.perf_counter()-started,
            "demonstrationBatch": len(demonstrations)}, demonstrations, sentinel


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
        entropy = -sum(p * math.log(max(p, 1e-38)) for p in probs if p > 0)
        normalized = entropy / math.log(len(probs)) if len(probs) > 1 else 0.0
        actions.append((index, float(max(probs[index], 1e-38)), float(value),
                        entropy, normalized, max(probs),
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
    summary = {"jobId": episode.task["jobId"], "seed": episode.task["seed"],
            "arenaSeed": (episode.course_tracker or {}).get("preparationSeed", episode.task["seed"]),
            "policySampleSeed": episode.task["seed"],
            "startType": "course" if episode.task.get("courseId") else "normal",
            "courseId": episode.task.get("courseId"),
            "startDecisionCount": episode.start_decision_count,
            "policyVersion": episode.task["policyVersion"],
            "termination": outcome["termination"], "winner": outcome["winner"],
            "round": outcome["round"], "allianceScores": outcome["allianceScores"],
            "decisions": len(episode.samples), "countryTurns": sum(episode.elapsed),
            "actionSequenceSha256": action_digest,
            "choices": dict(episode.choices), "sources": dict(episode.sources),
            "sourceTypes": dict(episode.source_types),
            "triggerOpportunities": dict(episode.trigger_opportunities),
            "triggerActivations": dict(episode.trigger_activations),
            "triggerSkips": episode.trigger_skips,
            "triggerDepths": dict(episode.trigger_depths),
            "feeCardsSpent": episode.fee_cards_spent,
            "wastePenaltiesByCard": dict(episode.waste_by_card),
            "submitted": dict(episode.submitted), "resolved": dict(episode.resolved),
            "shaped": dict(episode.base_reward_totals),
            "trainingReward": {team: sum(r[team] for r in episode.rewards)
                               for team in ("axis", "allies")},
            "wasteCheckReasons": dict(episode.waste_reasons),
            "wasteExemptionReasons": dict(episode.waste_exemptions),
            "wasteExemptionsByCard": {card: dict(reasons) for card, reasons in
                                      episode.waste_exemptions_by_card.items()},
            "wastePenaltiesBySeat": dict(episode.waste_penalties),
            "wastePenaltyTotal": ppo.REWARD_CONFIG["actionWastePenalty"] *
                sum(episode.waste_penalties.values()),
            "wasteOpportunityDecisions": episode.waste_opportunity_decisions,
            "wasteOpportunityChoices": episode.waste_opportunity_choices,
            "policyEntropyMean": episode.policy_entropy_total / len(episode.samples),
            "normalizedEntropyMean": episode.normalized_entropy_total / len(episode.samples),
            "maxActionProbabilityMean": episode.max_probability_total / len(episode.samples),
            "singleCandidateDecisions": episode.single_candidate_decisions,
            "consumedEvents": consumed,
            "meanOpenFraction": statistics.fmean(episode.openness) if episode.openness else 0.0,
            "remainingBySeat": {seat: len(deck["hand"]) for seat, deck in decks.items()},
            "discardedBySeat": {seat: len(deck["discardPile"]) for seat, deck in decks.items()},
            "candidateMean": statistics.fmean(episode.candidate_counts),
            "candidateMax": max(episode.candidate_counts),
            "wallSeconds": time.perf_counter() - episode.started}
    if episode.course_tracker is not None:
        from scripts.ppo_combo_metrics import summarize
        summary["comboCourse"] = summarize(episode.course_tracker, outcome, state)
    if episode.course_tracker is not None or episode.landing_tracker is not None:
        from scripts.ppo_combo_metrics import landing_summary
        summary["landing"] = landing_summary(
            episode.course_tracker or episode.landing_tracker)
    if episode.task.get("comboDetail"):
        from scripts.ppo_combo_c3_metrics import summarize_detail
        summary["comboDetail"] = summarize_detail(
            episode.course_tracker or episode.landing_tracker,
            episode.task, episode.fee_cards_spent)
    return summary


def collect_batch(clients, encoder, model, device, tasks, mode, card_set, training_seed,
                  max_decisions, inference_batch_size=8, inference_wait_ms=2.0,
                  diagnostic_path: Path | None = None, trace="none", on_progress=None,
                  store: TrajectoryStore | None = None, combo_entries: dict | None = None,
                  combo_preparation: dict | None = None):
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
            course = combo_entries[task["courseId"]] if "courseId" in task else None
            tag = {"environmentId": environment, "jobId": task["jobId"],
                   "episodeId": course["snapshot"]["header"]["gameId"] if course else
                       f"ppo-{mode}-{task['seed']}", "decisionId": -1,
                   "policyVersion": task["policyVersion"]}
            if course:
                submit(environment, "reset", task, op="restore",
                       snapshot=course["snapshot"], trace="full", tag=tag,
                       comboTelemetry=True)
            else:
                submit(environment, "reset", task, op="reset", seed=task["seed"], mode=mode,
                       cardSet=card_set, trace=trace, gameId=tag["episodeId"], tag=tag,
                       comboTelemetry=(True if task.get("comboDetail") else
                                       "landing" if combo_entries is not None else False))

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
                        course = combo_entries[item["courseId"]] if "courseId" in item else None
                        if combo_entries is not None:
                            from scripts.ppo_combo_metrics import new_tracker
                        active[environment] = Episode(item, environment, obs,
                            policy_rng(item["seed"], item["policyVersion"], training_seed),
                            course["snapshot"]["decisionCount"] if course else 0,
                            new_tracker(item["courseId"], course["snapshot"],
                                (combo_preparation or {}).get(item["courseId"]),
                                detail=bool(item.get("comboDetail"))) if course else None,
                            new_tracker(None, obs, detail=bool(item.get("comboDetail")))
                                if combo_entries is not None and not course else None)
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
                        if episode.course_tracker is not None:
                            from scripts.ppo_combo_metrics import record_step
                            record_step(episode.course_tracker, response.get("comboTelemetry"),
                                        previous["decision"]["decisionId"],
                                        fee_cards_spent=info.get("feeCardsSpent", 0))
                        if episode.landing_tracker is not None:
                            from scripts.ppo_combo_metrics import record_step
                            record_step(episode.landing_tracker, response.get("comboTelemetry"),
                                        previous["decision"]["decisionId"],
                                        fee_cards_spent=info.get("feeCardsSpent", 0))
                        after = outcome["allianceScores"] if outcome else response["observation"]["allianceScores"]
                        base, reward = decision_rewards(previous, after, outcome, info)
                        for team in ("axis", "allies"):
                            episode.base_reward_totals[team] += base[team]
                        waste = info.get("wasteCheck")
                        opportunity = info.get("wasteOpportunity", {})
                        episode.waste_opportunity_decisions += int(opportunity.get("candidateCount", 0) > 0)
                        episode.waste_opportunity_choices += int(opportunity.get("chosen", False))
                        if waste:
                            if waste["seat"] != previous["decisionSeat"]:
                                raise RuntimeError("Waste penalty seat differs from initiating decision")
                            episode.waste_reasons[waste["reason"]] += 1
                            if waste["penalty"]:
                                episode.waste_penalties[waste["seat"]] += 1
                                episode.waste_by_card[waste["definitionId"]] += 1
                        episode.rewards.append(reward)
                        adjustment_info = info
                        if episode.start_decision_count and info.get("rewardAdjustments"):
                            adjustment_info = {**info, "rewardAdjustments": [{**item,
                                "decisionId": item["decisionId"] - episode.start_decision_count}
                                for item in info["rewardAdjustments"] if
                                item["decisionId"] >= episode.start_decision_count]}
                        for adjustment in ppo.apply_reward_adjustments(
                                episode.rewards, episode.samples, adjustment_info):
                            episode.waste_penalties[adjustment["seat"]] += 1
                            episode.waste_reasons[adjustment["reason"]] += 1
                            episode.waste_by_card[adjustment["cardId"].split(":")[1]] += 1
                        episode.fee_cards_spent += info.get("feeCardsSpent", 0)
                        if info.get("triggerDepth"):
                            episode.trigger_depths[str(info["triggerDepth"])] += 1
                        for assessment in info.get("wasteAssessments") or ():
                            if not assessment["penalized"]:
                                episode.waste_exemptions[assessment["reason"]] += 1
                                card_id = assessment["cardId"].split(":")[1]
                                episode.waste_exemptions_by_card[card_id][assessment["reason"]] += 1
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
                    for episode, (index, probability, value, entropy, normalized, max_probability,
                                  state, candidates) in zip(episodes, actions):
                        observation = episode.observation
                        if len(episode.samples) >= max_decisions:
                            raise RuntimeError(f"Episode {episode.task['jobId']} exceeded {max_decisions} decisions")
                        chosen = observation["candidates"][index]
                        episode.last_chosen = chosen
                        sample = {"seat": observation["decisionSeat"],
                            "state": state, "candidates": candidates, "action": index,
                            "logprob": math.log(probability), "value": value, "baseline": False}
                        sample_id = store.append(sample)
                        episode.samples.append({"seat": sample["seat"], "action": index,
                            "logprob": sample["logprob"], "value": value,
                            "baseline": False, "sampleId": sample_id})
                        episode.candidate_counts.append(len(observation["candidates"]))
                        episode.policy_entropy_total += entropy
                        episode.normalized_entropy_total += normalized
                        episode.max_probability_total += max_probability
                        episode.single_candidate_decisions += int(len(observation["candidates"]) == 1)
                        episode.choices[chosen["kind"]] += 1
                        if chosen["kind"] == "source":
                            episode.sources[chosen.get("definitionId") or "unknown"] += 1
                            episode.source_types[chosen.get("cardType") or "unknown"] += 1
                        if observation.get("choiceKind") == "TRIGGER":
                            for candidate in observation["candidates"]:
                                for feature in candidate.get("choices") or []:
                                    if feature.get("kind") == "trigger":
                                        episode.trigger_opportunities[
                                            feature.get("definitionId") or "unknown"] += 1
                            if chosen.get("choiceIds"):
                                for feature in chosen.get("choices") or []:
                                    if feature.get("kind") == "trigger":
                                        episode.trigger_activations[
                                            feature.get("definitionId") or "unknown"] += 1
                            else:
                                episode.trigger_skips += 1
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
                               action={**decision, "actionId": chosen["id"]}, tag=tag,
                               comboTelemetry=(True if episode.task.get("courseId") or
                                                    episode.task.get("comboDetail") else
                                               "landing" if combo_entries is not None else False))
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


def open_clients(count: int, directory: Path, card_set="events"):
    clients = []
    bundle = directory / "ppo-arena-bundle.mjs"
    try:
        for _ in range(count):
            client = ppo.ArenaClient(bundle_path=bundle, card_set=card_set)
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
    parser.add_argument("--experiment-id", choices=["A1", "A2", "A1S1", "S2FLAT", "S2MAP", "A1S2", "A2S1", "A2S1W1", "A2S1C1", "A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS], default=None)
    parser.add_argument("--architecture", choices=["flat-v1-effective-straits",
        "shared-regions-actor-adjacency-ordered-actions-v2", "map-contextual-opening-adapter-v1",
        "map-contextual-opening-adapter-a2s1-v1"], default=None)
    parser.add_argument("--auxiliary-data", type=Path)
    parser.add_argument("--auxiliary-weight", type=float, default=0.05)
    parser.add_argument("--auxiliary-decay-updates", type=int, default=20)
    parser.add_argument("--no-auxiliary", action="store_true")
    parser.add_argument("--entropy-coefficient", type=float,
                        default=ppo.OPTIMIZER_CONFIG["entropy"])
    parser.add_argument("--initial-weights", type=Path, default=None)
    parser.add_argument("--combo-pool", type=Path, default=None)
    parser.add_argument("--expected-initial-hash", default=None)
    parser.add_argument("--card-set", choices=["basics", "events", "signals"], default="events")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--inference-batch-size", type=int, default=8)
    parser.add_argument("--inference-wait-ms", type=float, default=2.0)
    parser.add_argument("--updates", type=int, default=1)
    parser.add_argument("--episodes-per-update", type=int, default=BATCH_EPISODES)
    parser.add_argument("--max-episode-decisions", type=int, default=3000)
    parser.add_argument("--seed", type=int, default=20260930)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--approved-resume-parent-sha256", default=None)
    parser.add_argument("--trace", choices=["none", "summary", "full"], default="none")
    # Accepted for old short-benchmark commands; automatic baseline evaluations
    # are no longer part of training or round output.
    parser.add_argument("--eval-seeds", type=int, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--no-eval", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--cpu", action="store_true")
    parser.add_argument("--background-performance", action="store_true",
                        help="Opt in to process-local execution-speed unthrottling for Python and Node workers")
    parser.add_argument("--auto-exploration-pairs", type=int, default=0)
    parser.add_argument("--auto-exploration-root", type=Path)
    parser.add_argument("--auto-review-parent", type=Path)
    parser.add_argument("--auto-review-seconds", type=int, default=120)
    parser.add_argument("--auto-frozen-library", type=Path)
    args = parser.parse_args()
    if args.workers < 1 or args.inference_batch_size < 1 or args.inference_wait_ms < 0:
        parser.error("Invalid worker or inference batch configuration")
    if args.episodes_per_update != BATCH_EPISODES:
        parser.error("Production PPO updates require exactly 40 complete episodes")
    if args.updates < 0:
        parser.error("updates must be nonnegative")
    if args.auto_exploration_pairs < 0 or args.auto_exploration_pairs > 100:
        parser.error("auto exploration pairs must be between 0 and 100")
    if args.auto_review_seconds < 1 or args.auto_review_seconds > 1800:
        parser.error("auto review budget must be 1..1800 seconds")
    if args.auto_exploration_pairs and (args.experiment_id not in AUTO_EXPERIMENTS or
            args.auto_exploration_root is None or args.auto_review_parent is None):
        parser.error("Automatic exploration needs an isolated experiment and explicit archive/parent")
    if args.experiment_id not in AUTO_EXPERIMENTS and (args.auto_exploration_root or
            args.auto_review_parent or args.auto_frozen_library):
        parser.error("Automatic exploration is exclusive to its own experiments")
    if not math.isfinite(args.entropy_coefficient) or args.entropy_coefficient < 0:
        parser.error("entropy coefficient must be finite and nonnegative")
    if args.experiment_id and (args.mode != "A" or args.entropy_coefficient !=
                               {"A1": 0.01, "A2": 0.02, "A1S1": 0.01,
                                "S2FLAT": 0.01, "S2MAP": 0.01, "A1S2": 0.01,
                                "A2S1": 0.01, "A2S1W1": 0.01, "A2S1C1": 0.01,
                                "A2S1C2": 0.01, "A2S1C3": 0.01, "A2S1C4": 0.01,
                                **{name: 0.01 for name in AUTO_EXPERIMENTS}}[args.experiment_id] or
                               not args.initial_weights or not args.expected_initial_hash):
        parser.error("A1/A2 require A resource mode, the prescribed entropy, and shared initialization")
    from scripts.ppo_network_factory import STAGE2_EXPERIMENTS, ACTIVE_EXPERIMENTS, make_network
    allowed_architectures = {**STAGE2_EXPERIMENTS, **ACTIVE_EXPERIMENTS}
    if args.experiment_id in allowed_architectures and args.architecture != allowed_architectures[args.experiment_id]:
        parser.error("Second-stage experiment and network architecture disagree")
    if args.experiment_id not in allowed_architectures and args.architecture is not None:
        parser.error("Architecture override is reserved for the second-stage experiment")
    if args.experiment_id == "A1S2":
        if args.auxiliary_data is None:
            parser.error("A1S2 requires explicit auxiliary data even when disabled")
        if not math.isfinite(args.auxiliary_weight) or args.auxiliary_weight < 0 or args.auxiliary_decay_updates < 1:
            parser.error("Invalid A1S2 auxiliary configuration")
    elif args.auxiliary_data is not None or args.no_auxiliary:
        parser.error("Auxiliary learning is exclusive to A1S2")
    if args.experiment_id in ("A2S1", "A2S1W1", "A2S1C1", "A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS) and args.card_set != "signals":
        parser.error("A2S1 requires the signals course")
    if (args.experiment_id in ("A2S1C1", "A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS)) != (args.combo_pool is not None):
        parser.error("Combo experiments require their own reachable start pool")
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    device = torch.device("cpu" if args.cpu or not torch.cuda.is_available() else "cuda")
    rng = random.Random(args.seed)
    torch.manual_seed(args.seed)
    trajectory_root = TRAJECTORY_ROOT / args.experiment_id if args.experiment_id else TRAJECTORY_ROOT
    cleanup_stale(trajectory_root)
    with tempfile.TemporaryDirectory(prefix="ppo-parallel-") as directory:
        print(f"{args.experiment_id or args.mode}（资源{args.mode}，熵{args.entropy_coefficient:.2f}）："
              f"启动 {min(args.workers, BATCH_EPISODES)} 个环境并加载模型...", flush=True)
        startup_started = time.perf_counter()
        clients = open_clients(min(args.workers, BATCH_EPISODES), Path(directory), args.card_set)
        qos_stack = ExitStack()
        qos_status = {}
        def ensure_worker_qos():
            if not args.background_performance:
                return
            from scripts.ppo_process_qos import disable_execution_speed_throttling
            for pid in [os.getpid(), *(client.process.pid for client in clients)]:
                if pid not in qos_status:
                    qos_status[pid] = qos_stack.enter_context(
                        disable_execution_speed_throttling(pid))
                    status = qos_status[pid]
                    if not status.get("applied"):
                        print(f"Background performance unavailable for PID {pid}: "
                              f"{status.get('reason', 'not applied')}", flush=True)
        try:
            ensure_worker_qos()
            encoder = ppo.Encoder(clients[0].schema)
            model = (make_network(args.architecture, encoder) if args.architecture else
                     ppo.PpoNetwork(encoder.state_dim, encoder.candidate_dim)).to(device)
            if args.initial_weights:
                initial = torch.load(args.initial_weights, map_location="cpu", weights_only=False)
                if (initial.get("format") != "quartermaster-ppo-comparison-initial-v1" or
                    initial.get("buildFingerprint") != clients[0].fingerprint or
                    initial.get("network") != {"stateDim": encoder.state_dim,
                                                "candidateDim": encoder.candidate_dim} or
                    args.architecture is not None and initial.get("networkArchitecture") != args.architecture):
                    raise ValueError("Comparison initialization schema differs")
                if args.experiment_id in ("A2S1W1", "A2S1C1", "A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS) and (
                        initial.get("experimentId") != args.experiment_id or
                        initial.get("rewardConfig") != ppo.reward_config("signals") or
                        initial.get("optimizerMigration") != "new-Adam-no-old-momentum"):
                    raise ValueError("Revised A2S1 requires its explicit v3 reward migration initializer")
                if args.experiment_id == "A2S1C2" and (
                        initial.get("sourceExperimentId") != "A2S1C1" or
                        initial.get("sourceUpdate") != 30):
                    raise ValueError("A2S1C2 must descend from A2S1C1 update 30")
                if args.experiment_id == "A2S1C3" and (
                        initial.get("sourceExperimentId") != "A2S1C2-G1-U4-J1-diagnostic-v1" or
                        initial.get("candidateFileSha256") !=
                        "6b954aa526462bb9eec80c4d65391379c855230ead001e0fa43d75c56b4dc51a" or
                        initial.get("sourceCandidateWeightsSha256") !=
                        "8af92d1a069eed3981ca013ebcaa924bf86737a2c9e9a12f00571914b7474234"):
                    raise ValueError("A2S1C3 initializer is not the reviewed three-course candidate")
                if args.experiment_id == "A2S1C4" and (
                        initial.get("sourceExperimentId") != "A2S1C3" or
                        initial.get("sourceUpdate") != 20 or
                        initial.get("sourceCompletedEpisodes") != 800 or
                        initial.get("sourceC3CheckpointSha256") !=
                        "ed32ba1f9e6927be8a4cec739942533ff5d949137b39239429b53c9855b5c0b7"):
                    raise ValueError("A2S1C4 initializer is not the completed C3 update-20 model")
                if args.experiment_id in AUTO_EXPERIMENTS and (
                        initial.get("sourceExperimentId") != "A2S1C4" or
                        initial.get("sourceUpdate") != 20 or
                        initial.get("sourceCompletedEpisodes") != 800 or
                        initial.get("experimentId") != args.experiment_id or
                        initial.get("sourceC4CheckpointSha256") !=
                        "165152a554bc68ee2a97bdbd4ab338537e21037190c6c091aec61288ebdc2e70"):
                    raise ValueError("Automatic exploration initializer is not the completed C4 update-20 model")
                if args.experiment_id in ("A2S1W1", "A2S1C1") and initial.get("sourceExperimentId") != "A2S1":
                    raise ValueError("Historical A2S1 initializer has a different parent")
                model.load_state_dict(initial["modelState"])
            initial_hash = ppo.model_weights_sha256(model)
            if args.expected_initial_hash and initial_hash != args.expected_initial_hash:
                raise ValueError("Comparison initialization weight hash differs")
            combo_entries, course_config, combo_generation, combo_preparation = None, None, None, None
            if args.combo_pool:
                if args.experiment_id in ("A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS):
                    from scripts import ppo_combo_course_v2 as combo_module
                else:
                    from scripts import ppo_combo_course as combo_module
                if not args.initial_weights:
                    raise ValueError("Combo training requires an explicit migrated initializer")
                expected = combo_module.pool_identity(clients[0], initial["sourceCheckpointSha256"],
                    initial.get("generatorWeightsSha256", initial_hash)
                    if args.experiment_id in ("A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS) else initial_hash)
                pool = combo_module.read_pool(args.combo_pool, expected)
                combo_entries = {combo_module.course_id(item) if args.experiment_id in ("A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS)
                                 else f"{item['template']}:{item['variant']}:{item['layer']}": item
                                 for item in pool["entries"]}
                if args.experiment_id == "A2S1C1" and (len(combo_entries) != 32 or len(pool["entries"]) != 32):
                    raise ValueError("A2S1C1 pool requires all eight templates and 32 starts")
                if args.experiment_id in ("A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS):
                    required = {f"{template.key}:{variant}:{layer}" for template in combo_module.TEMPLATES
                                for variant in ("positive", "control") for layer in ("payoff", "preparation")}
                    if not all(any(key.startswith(prefix + ":") for key in combo_entries) for prefix in required):
                        raise ValueError("A2S1C2 pool is missing a template/variant/layer")
                    combo_generation = combo_module.generation_summary(pool)
                else:
                    combo_generation = combo_module.generation_summary(pool)
                from scripts.ppo_combo_metrics import VERSION as COMBO_METRICS_VERSION, preparation_metadata
                combo_preparation = preparation_metadata(args.combo_pool, pool["entries"], clients[0])
                course_config = {"version": combo_module.VERSION, "mix": combo_module.MIX,
                                 "poolIdentitySha256": expected["identitySha256"],
                                 "poolFileSha256": hashlib.sha256(args.combo_pool.read_bytes()).hexdigest(),
                                 "metricsVersion": COMBO_METRICS_VERSION + ("-c3" if args.experiment_id == "A2S1C3" else "-c2")
                                    if args.experiment_id in ("A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS) else COMBO_METRICS_VERSION}
                if args.experiment_id == "A2S1C4":
                    from scripts.ppo_combo_sampler_v2 import VERSION as SAMPLER_VERSION
                    course_config["mix"] = {"normal": 20, "positivePreparation": 9,
                        "controlPreparation": 3, "positivePayoff": 6,
                        "controlPayoff": 2}
                    course_config["samplerVersion"] = SAMPLER_VERSION
                    from scripts.ppo_combo_metrics import C4_VERSION as C4_METRICS_VERSION
                    course_config["metricsVersion"] = C4_METRICS_VERSION + "-c4"
                if args.experiment_id in AUTO_EXPERIMENTS:
                    from scripts.ppo_combo_sampler_v2 import VERSION as SAMPLER_VERSION
                    from scripts.ppo_combo_metrics import C4_VERSION as C4_METRICS_VERSION
                    course_config["mix"] = {"normal": 36, "handWrittenCourse": 4}
                    course_config["samplerVersion"] = SAMPLER_VERSION
                    course_config["metricsVersion"] = C4_METRICS_VERSION + "-auto-v1"
                    course_config["automaticExploration"] = {
                        "version": "auto-exploration-per-complete-batch-v1",
                        "pairsPerUpdate": args.auto_exploration_pairs,
                        "reviewMaxSeconds": args.auto_review_seconds,
                        "reviewParentSha256": (hashlib.sha256(
                            args.auto_review_parent.read_bytes()).hexdigest()
                            if args.auto_review_parent else None),
                        "frozenLibrarySha256": (hashlib.sha256(
                            args.auto_frozen_library.read_bytes()).hexdigest()
                            if args.auto_frozen_library else None),
                        "imitation": "reviewed-only-max2x64-lr1e-5-sentinel-kl-0.01"}
                if args.experiment_id in ("A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS):
                    from scripts.ppo_combo_c3_metrics import VERSION as C3_METRICS_VERSION
                    if args.experiment_id == "A2S1C4" or args.experiment_id in AUTO_EXPERIMENTS:
                        from scripts.ppo_combo_c3_metrics import C4_VERSION as C4_DETAIL_VERSION
                        course_config["detailMetricsVersion"] = C4_DETAIL_VERSION
                    else:
                        course_config["detailMetricsVersion"] = C3_METRICS_VERSION
                if args.experiment_id in ("A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS):
                    if not initial.get("demonstrationAuditSha256"):
                        raise ValueError("A2S1C2 requires an auditable separate imitation pass")
                    course_config["demonstrationAuditSha256"] = initial["demonstrationAuditSha256"]
            auxiliary_config = None
            auxiliary_bundle = None
            if args.experiment_id == "A1S2":
                from scripts import ppo_auxiliary
                auxiliary_config = ppo_auxiliary.config(args.auxiliary_data,
                    0.0 if args.no_auxiliary else args.auxiliary_weight,
                    args.auxiliary_decay_updates)
                auxiliary_bundle = ppo_auxiliary.load(args.auxiliary_data,
                    initial_hash, clients[0].fingerprint, encoder)
            optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
            startup_seconds = time.perf_counter() - startup_started
            print(f"{args.experiment_id or args.mode}：环境就绪，耗时 {startup_seconds:.1f}s。", flush=True)
            next_seed, completed_decisions, completed_episodes, start_update = args.seed, 0, 0, 0
            if args.resume:
                saved = ppo.restore_checkpoint(args.checkpoint, model, optimizer, encoder,
                                               clients[0], args.mode, rng, args.card_set,
                                               training_seed=args.seed,
                                               experiment_id=args.experiment_id,
                                               entropy_coefficient=args.entropy_coefficient,
                                               initial_weights_sha256=initial_hash if args.experiment_id else None,
                                               architecture=args.architecture,
                                               auxiliary_config=auxiliary_config,
                                               course_config=course_config,
                                               approved_resume_parent_sha256=args.approved_resume_parent_sha256)
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
            gradient_microbatch = (64 if args.experiment_id in ("A2S1", "A2S1W1", "A2S1C1", "A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS) else
                                   32 if args.experiment_id in ("S2MAP", "A1S2") else
                                   ppo.OPTIMIZER_CONFIG["minibatch"])
            report = {"mode": args.mode, "experimentId": args.experiment_id,
                      "entropyCoefficient": args.entropy_coefficient,
                      "optimizerConfig": {**ppo.OPTIMIZER_CONFIG, "entropy": args.entropy_coefficient},
                      "rewardConfig": ppo.reward_config(args.card_set),
                      "initialWeightsSha256": initial_hash, "cardSet": args.card_set,
                      "experimentConfigSha256": ppo.experiment_config_sha256(args.experiment_id,
                          args.mode, args.entropy_coefficient, initial_hash if args.experiment_id else None,
                          args.seed, clients[0].fingerprint, args.card_set, args.architecture,
                          auxiliary_config, course_config),
                      "auxiliaryConfig": auxiliary_config,
                      "comboCourseConfig": course_config,
                      "comboStartGeneration": combo_generation,
                      "networkArchitecture": args.architecture,
                      "sourceCommit": source_commit, "sourceDirty": source_dirty,
                      "trainerSourceSha256": ppo.TRAINER_SOURCE_HASH,
                      "buildFingerprint": clients[0].fingerprint,
                      "observationSchemaVersion": clients[0].schema["observationSchemaVersion"],
                      "actionSchemaVersion": clients[0].schema["actionSchemaVersion"],
                      "encoderVersion": ppo.encoder_version(args.card_set),
                      "courseVersion": clients[0].schema["courseVersion"],
                      "overridesVersion": clients[0].schema["overridesVersion"],
                      "device": str(device), "workers": len(clients),
                      "backgroundPerformance": {"requested": args.background_performance,
                                                 "processes": list(qos_status.values())},
                      "startupSeconds": startup_seconds,
                      "inferenceBatchSize": args.inference_batch_size,
                      "inferenceWaitMs": args.inference_wait_ms,
                      "stateDim": encoder.state_dim, "candidateDim": encoder.candidate_dim,
                      "parameters": sum(p.numel() for p in model.parameters()), "updates": []}
            if args.resume and args.report and args.report.exists():
                previous_report = json.loads(args.report.read_text(encoding="utf-8"))
                previous_updates = previous_report.get("updates", [])
                if (previous_report.get("mode") != args.mode or
                    previous_report.get("experimentId") != args.experiment_id or
                    previous_report.get("networkArchitecture") != args.architecture or
                    args.experiment_id is not None and (
                        previous_report.get("entropyCoefficient") != args.entropy_coefficient or
                        previous_report.get("initialWeightsSha256") != initial_hash or
                        previous_report.get("experimentConfigSha256") != report["experimentConfigSha256"]) or
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
            report["gradientMicrobatch"] = gradient_microbatch
            if args.experiment_id in ("A2S1C1", "A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS):
                report["samplingConfig"] = {"version": "chunk-shuffle-epoch-v1",
                    "cacheLimitBytes": 1536 * 1024 ** 2,
                    "prefetchLimitBytes": 256 * 1024 ** 2,
                    "gradientMicrobatch": gradient_microbatch,
                    "logicalMinibatch": 256, "epochs": 4}
            elif args.experiment_id in ("A2S1", "A2S1W1"):
                report["performanceMigration"] = {
                    "parentCheckpointSha256": args.approved_resume_parent_sha256,
                    "fromUpdate": start_update, "effectiveFromUpdate": start_update + 1,
                    "sourceSha256": ppo.TRAINER_SOURCE_HASH,
                    "sampling": "chunk-shuffle-epoch-v1", "cacheLimitBytes": 1536 * 1024 ** 2,
                    "prefetchLimitBytes": 256 * 1024 ** 2,
                    "gradientMicrobatch": gradient_microbatch}
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
                ensure_worker_qos()
                if device.type == "cuda":
                    torch.cuda.reset_peak_memory_stats()
                tasks = make_tasks(next_seed, BATCH_EPISODES, update, args.mode,
                                   combo_entries, args.experiment_id)
                course_quota = None
                if args.experiment_id == "A2S1C4":
                    from scripts.ppo_combo_sampler_v2 import plan
                    course_quota = plan(combo_entries, update)
                    print(f"A2S1C4 更新 {update} 预定课程配额："
                          f"{course_quota['plannedCounts']}；缺失组合："
                          f"{course_quota['missingCombinations']}", flush=True)
                if args.experiment_id in AUTO_EXPERIMENTS:
                    chosen = [task["courseId"] for task in tasks if task.get("courseId")]
                    course_quota = {"version": "auto-36-normal-4-course-v1",
                        "plannedCounts": dict(Counter(":".join(key.split(":")[:3]) for key in chosen)),
                        "missingCombinations": [], "cursor": 4 * (update - 1)}
                    print(f"{args.experiment_id} 更新 {update} 预定课程：{chosen}", flush=True)
                diagnostic = args.checkpoint.with_suffix(f".failed-update-{update}.json")
                monitored_started = time.perf_counter()
                label = (f"{args.experiment_id or args.mode}（资源{args.mode}，熵{args.entropy_coefficient:.2f}） "
                         f"{ordinal((update - 1) // 10 + 1, '轮')} · "
                         f"{ordinal((update - 1) % 10 + 1, '次更新')}")
                store = TrajectoryStore(args.mode, update, root=trajectory_root,
                    read_limit=(1536 * 1024 ** 2 if args.experiment_id in ("A2S1", "A2S1W1", "A2S1C1", "A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS) else 16 * 1024 ** 2))
                phases = {"beforeCollection": phase_resources(clients, store, device)}
                result = None
                try:
                    with ProgressDisplay(label, BATCH_EPISODES) as progress:
                        with ProcessMonitor(clients) as monitor:
                            samples, episodes, timing = collect_batch(clients, encoder, model, device,
                                tasks, args.mode, args.card_set, args.seed, args.max_episode_decisions,
                                args.inference_batch_size, args.inference_wait_ms, diagnostic, args.trace,
                                on_progress=progress.update, store=store,
                                combo_entries=combo_entries,
                                combo_preparation=combo_preparation)
                            if course_quota is not None:
                                actual = Counter(":".join(e["courseId"].split(":")[:3])
                                                 for e in episodes if e.get("courseId"))
                                if dict(actual) != course_quota["plannedCounts"]:
                                    raise ValueError(f"C4 course quota mismatch before PPO update: {dict(actual)}")
                            phases["afterCollection"] = phase_resources(clients, store, device)
                            exploration, reviewed_demonstrations, sentinel = None, [], []
                            if args.auto_exploration_pairs:
                                progress.set_stage("离策略探索中")
                                source_hash = hashlib.sha256((args.checkpoint if
                                    args.checkpoint.exists() else args.initial_weights).read_bytes()).hexdigest()
                                exploration, reviewed_demonstrations, sentinel = discover_off_policy(
                                    clients, model, encoder, device, update=update,
                                    training_seed=args.seed, source_hash=source_hash,
                                    archive_root=args.auto_exploration_root,
                                    pairs=args.auto_exploration_pairs,
                                    review_parent=args.auto_review_parent,
                                    review_seconds=args.auto_review_seconds)
                                if args.auto_frozen_library:
                                    from scripts.ppo_auto_library import load_batch
                                    frozen = load_batch(args.auto_frozen_library,
                                        expected_sha=course_config["automaticExploration"][
                                            "frozenLibrarySha256"],
                                        build_fingerprint=clients[0].fingerprint,
                                        encoder_version=ppo.encoder_version("signals"),
                                        reward_config=ppo.reward_config("signals"),
                                        limit=max(1, 64-len(reviewed_demonstrations)),
                                        seed=args.seed+update)
                                    reviewed_demonstrations.extend(frozen[:64-len(reviewed_demonstrations)])
                                    exploration["frozenReviewedDemonstrations"] = len(frozen)
                            progress.set_stage("优化中")
                            optimization_started = time.perf_counter()
                            model.train()
                            metrics = ppo.ppo_update(model, optimizer, store, device, rng,
                                                     entropy_coefficient=args.entropy_coefficient,
                                                     gradient_microbatch=gradient_microbatch,
                                                     sampling=("chunk-shuffle-epoch-v1" if
                                                         args.experiment_id in ("A2S1", "A2S1W1", "A2S1C1", "A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS) else
                                                         "global-shuffle-v1"))
                            auxiliary_metrics = (ppo_auxiliary.update(model, optimizer,
                                auxiliary_bundle, device,
                                ppo_auxiliary.weight_at_update(auxiliary_config, update), update)
                                if auxiliary_config is not None else None)
                            auto_auxiliary_metrics = None
                            if args.auto_exploration_pairs:
                                from scripts.ppo_auto_imitate import auxiliary_update
                                auto_auxiliary_metrics = auxiliary_update(model, encoder,
                                    reviewed_demonstrations, sentinel, device,
                                    seed=args.seed+update)
                                auto_auxiliary_metrics.pop("optimizerState", None)
                                del reviewed_demonstrations, sentinel
                            optimization_seconds = time.perf_counter() - optimization_started
                            phases["afterUpdate"] = phase_resources(clients, store, device)
                    resource = monitor.report(time.perf_counter() - monitored_started)
                    batch_decisions = len(store)
                    completed_decisions += batch_decisions
                    completed_episodes += BATCH_EPISODES
                    next_seed += BATCH_EPISODES
                    payload = ppo.checkpoint_payload(model, optimizer, encoder, clients[0],
                        args.mode, update, completed_decisions, rng, next_seed, args.card_set,
                        completed_episodes=completed_episodes, training_seed=args.seed,
                        experiment_id=args.experiment_id,
                        entropy_coefficient=args.entropy_coefficient,
                        initial_weights_sha256=initial_hash if args.experiment_id else None,
                        architecture=args.architecture,
                        auxiliary_config=auxiliary_config,
                        course_config=course_config,
                        sampling_config=({"version": "chunk-shuffle-epoch-v1",
                            "cacheLimitBytes": 1536 * 1024 ** 2,
                            "prefetchLimitBytes": 256 * 1024 ** 2,
                            "gradientMicrobatch": 64, "logicalMinibatch": 256,
                            "epochs": 4} if args.experiment_id in ("A2S1", "A2S1W1", "A2S1C1", "A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS) else None))
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
                              "optimization": metrics, "auxiliary": auxiliary_metrics,
                              "automaticExploration": exploration,
                              "automaticImitation": auto_auxiliary_metrics,
                              "signals": {
                                  "sourceTypes": {kind: sum(e["sourceTypes"].get(kind, 0) for e in episodes)
                                      for kind in ("基本牌", "事件", "状态", "响应")},
                                  "triggerOpportunities": {card: sum(e["triggerOpportunities"].get(card, 0)
                                      for e in episodes) for card in sorted({card for e in episodes
                                      for card in e["triggerOpportunities"]})},
                                  "triggerActivations": {card: sum(e["triggerActivations"].get(card, 0)
                                      for e in episodes) for card in sorted({card for e in episodes
                                      for card in e["triggerActivations"]})},
                                  "triggerSkips": sum(e["triggerSkips"] for e in episodes),
                                  "feeCardsSpent": sum(e["feeCardsSpent"] for e in episodes),
                                  "triggerDepths": {depth: sum(e["triggerDepths"].get(depth, 0)
                                      for e in episodes) for depth in sorted({depth for e in episodes
                                      for depth in e["triggerDepths"]})},
                                  "wastePenaltiesByCard": {card: sum(e["wastePenaltiesByCard"].get(card, 0)
                                      for e in episodes) for card in sorted({card for e in episodes
                                      for card in e["wastePenaltiesByCard"]})}},
                              "actionWaste": {
                                  "opportunityDecisions": sum(e["wasteOpportunityDecisions"] for e in episodes),
                                  "opportunityChoices": sum(e["wasteOpportunityChoices"] for e in episodes),
                                  "choiceRate": (sum(e["wasteOpportunityChoices"] for e in episodes) /
                                      sum(e["wasteOpportunityDecisions"] for e in episodes))
                                      if sum(e["wasteOpportunityDecisions"] for e in episodes) else None,
                                  "repeatedBasicBuilds": sum(sum(count for reason, count in
                                      episode["wasteCheckReasons"].items() if reason != "not_repeated")
                                      for episode in episodes),
                                  "penaltiesBySeat": {seat: sum(episode["wastePenaltiesBySeat"].get(seat, 0)
                                      for episode in episodes) for seat in encoder.seats},
                                  "reasons": {reason: sum(episode["wasteCheckReasons"].get(reason, 0)
                                      for episode in episodes) for reason in sorted({reason for episode in episodes
                                      for reason in episode["wasteCheckReasons"]})},
                                  "exemptions": {reason: sum(episode["wasteExemptionReasons"].get(reason, 0)
                                      for episode in episodes) for reason in sorted({reason for episode in episodes
                                      for reason in episode["wasteExemptionReasons"]})},
                                  "exemptionsByCard": {card: {reason: sum(episode.get(
                                      "wasteExemptionsByCard", {}).get(card, {}).get(reason, 0)
                                      for episode in episodes) for reason in sorted({reason for episode in episodes
                                      for reason in episode.get("wasteExemptionsByCard", {}).get(card, {})})}
                                      for card in sorted({card for episode in episodes
                                      for card in episode.get("wasteExemptionsByCard", {})})},
                                  "penaltyTotal": sum(episode["wastePenaltyTotal"] for episode in episodes)},
                              "policyDistribution": {
                                  "entropyMean": sum(e["policyEntropyMean"] * e["decisions"] for e in episodes) / batch_decisions,
                                  "normalizedEntropyMean": sum(e["normalizedEntropyMean"] * e["decisions"] for e in episodes) / batch_decisions,
                                  "maxActionProbabilityMean": sum(e["maxActionProbabilityMean"] * e["decisions"] for e in episodes) / batch_decisions,
                                  "singleCandidateDecisions": sum(e["singleCandidateDecisions"] for e in episodes)},
                              "gpuPeakAllocatedBytes": torch.cuda.max_memory_allocated()
                              if device.type == "cuda" else 0,
                              "gpuPeakReservedBytes": torch.cuda.max_memory_reserved()
                              if device.type == "cuda" else 0}
                    if course_quota is not None:
                        actual = Counter(":".join(e["courseId"].split(":")[:3])
                                         for e in episodes if e.get("courseId"))
                        if dict(actual) != course_quota["plannedCounts"]:
                            raise ValueError(f"C4 course quota mismatch: {dict(actual)}")
                        result["courseQuota"] = {"version": course_quota["version"],
                            "planned": course_quota["plannedCounts"],
                            "actual": dict(actual), "missingCombinations":
                            course_quota["missingCombinations"],
                            "cursor": course_quota["cursor"]}
                    if combo_entries is not None:
                        from scripts.ppo_combo_metrics import aggregate
                        result["comboCourseSummary"] = aggregate(episodes,
                            group_by_template=args.experiment_id in ("A2S1C2", "A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS))
                    if args.experiment_id in ("A2S1C3", "A2S1C4", *AUTO_EXPERIMENTS):
                        from scripts.ppo_combo_c3_metrics import aggregate_detail
                        result["comboDetailSummary"] = aggregate_detail(episodes)
                        if args.experiment_id == "A2S1C4" or args.experiment_id in AUTO_EXPERIMENTS:
                            from scripts.ppo_combo_c3_metrics import C4_VERSION
                            from scripts.ppo_combo_sampler_v2 import outcome_summary
                            result["comboDetailSummary"]["version"] = C4_VERSION
                            result["courseStrataSummary"] = outcome_summary(episodes)
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
            print(f"{args.experiment_id or args.mode}（资源{args.mode}，熵{args.entropy_coefficient:.2f}）："
                  f"本轮训练检查点已保存；详细指标见 {args.report or args.checkpoint.parent}。",
                  flush=True)
        finally:
            qos_stack.close()
            for client in clients:
                client.close()


if __name__ == "__main__":
    main()
