"""Bounded, lossless float16 trajectory spool for one complete PPO update."""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import shutil
import struct
import tempfile
import threading
import time
from collections import OrderedDict, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import torch


ROOT = Path(__file__).resolve().parents[1] / "PPO训练" / ".trajectory-temp"
WRITE_LIMIT = 8 * 1024 * 1024
READ_LIMIT = 16 * 1024 * 1024
PREFETCH_LIMIT = 256 * 1024 * 1024
SAMPLER_VERSION = "chunk-shuffle-epoch-v1"
HEADER = struct.Struct("<IIII")  # sample id, state width, candidate rows, candidate width


def _within_root(root: Path, child: Path) -> bool:
    if child.is_symlink() or getattr(child, "is_junction", lambda: False)():
        return False
    root, child = root.resolve(), child.resolve()
    return child != root and child.parent == root


def _remove_owned_directory(root: Path, child: Path) -> None:
    if not _within_root(root, child) or not (child / "owner.json").is_file():
        raise ValueError(f"Refusing to delete unowned trajectory directory: {child}")
    shutil.rmtree(child)


def _pid_alive(pid: int) -> bool:
    if pid < 1:
        return False
    if os.name == "nt":
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and exit_code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def cleanup_stale(root: Path = ROOT, min_age_seconds: int = 24 * 3600) -> list[str]:
    """Only remove marked, old, directly-owned dirs whose process is no longer alive."""
    removed = []
    if not root.exists():
        return removed
    for child in root.iterdir():
        if not child.is_dir() or not _within_root(root, child):
            continue
        marker = child / "owner.json"
        try:
            owner = json.loads(marker.read_text(encoding="utf-8"))
            if owner.get("format") != "ppo-trajectory-v1" or not isinstance(owner.get("pid"), int):
                continue
            if time.time() - float(owner["createdAt"]) < min_age_seconds or _pid_alive(owner["pid"]):
                continue
            _remove_owned_directory(root, child)
            removed.append(child.name)
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            continue
    return removed


class TrajectoryStore:
    """One binary file, bounded write/read chunk caches, small scalar index in RAM."""

    def __init__(self, mode: str, update: int, root: Path = ROOT,
                 write_limit: int = WRITE_LIMIT, read_limit: int = READ_LIMIT,
                 prefetch_limit: int = PREFETCH_LIMIT):
        if (mode not in ("A", "B") or update < 0 or write_limit < HEADER.size or
            read_limit < 1 or prefetch_limit < 0):
            raise ValueError("Invalid trajectory spool configuration")
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.directory = Path(tempfile.mkdtemp(prefix=f"ppo-{mode}-u{update:04d}-", dir=self.root))
        (self.directory / "owner.json").write_text(json.dumps({
            "format": "ppo-trajectory-v1", "pid": os.getpid(), "createdAt": time.time(),
            "mode": mode, "update": update}), encoding="utf-8")
        self.path = self.directory / "samples.bin"
        self.writer = self.path.open("wb")
        self.reader = None
        self.write_limit, self.read_limit = write_limit, read_limit
        self.prefetch_limit = min(prefetch_limit, read_limit)
        self.buffer = bytearray()
        self.chunks: list[tuple[int, int]] = []
        self.index: list[tuple[int, int, int, int]] = []  # chunk, offset, rows, width
        self.metadata: list[dict] = []
        self.training_order: list[int] = []
        self.candidate_total = 0
        self.peak_write_bytes = self.peak_read_bytes = 0
        self.cache: OrderedDict[int, bytes] = OrderedDict()
        self.cache_bytes = 0
        self.lock = threading.Lock()
        self.prefetcher = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ppo-spool-read")
        self.prefetch_future = None
        self.write_seconds = self.read_seconds = self.batch_load_seconds = 0.0
        self.closed = False

    def _flush(self) -> None:
        if not self.buffer:
            return
        start = self.writer.tell()
        self.writer.write(self.buffer)
        self.chunks.append((start, len(self.buffer)))
        self.buffer.clear()

    def append(self, sample: dict) -> int:
        if self.reader or self.closed:
            raise RuntimeError("Trajectory spool is sealed")
        started = time.perf_counter()
        state, candidates = sample["state"], sample["candidates"]
        if state.dtype != torch.float16 or candidates.dtype != torch.float16 or state.ndim != 1 or candidates.ndim != 2:
            raise ValueError("Trajectory tensors must be current float16 encoder output")
        state, candidates = state.contiguous(), candidates.contiguous()
        sample_id = len(self.index)
        header = HEADER.pack(sample_id, state.numel(), candidates.shape[0], candidates.shape[1])
        state_bytes = memoryview(state.numpy()).cast("B")
        candidate_bytes = memoryview(candidates.numpy()).cast("B")
        size = len(header) + len(state_bytes) + len(candidate_bytes)
        if self.buffer and len(self.buffer) + size > self.write_limit:
            self._flush()
        chunk_id = len(self.chunks)
        offset = len(self.buffer)
        if size > self.write_limit:
            start = self.writer.tell()
            self.writer.write(header)
            self.writer.write(state_bytes)
            self.writer.write(candidate_bytes)
            self.chunks.append((start, size))
        else:
            self.buffer.extend(header)
            self.buffer.extend(state_bytes)
            self.buffer.extend(candidate_bytes)
            self.peak_write_bytes = max(self.peak_write_bytes, len(self.buffer))
        self.index.append((chunk_id, offset, candidates.shape[0], candidates.shape[1]))
        self.metadata.append({**{key: value for key, value in sample.items()
                                if key not in ("state", "candidates")}, "stateWidth": state.numel()})
        self.candidate_total += candidates.shape[0]
        self.write_seconds += time.perf_counter() - started
        return sample_id

    def finish_episode(self, samples: list[dict]) -> None:
        for sample in samples:
            sample_id = sample["sampleId"]
            self.metadata[sample_id].update({"advantage": sample["advantage"], "target": sample["target"],
                                             "actualReturn": sample["actualReturn"]})
            self.training_order.append(sample_id)

    def seal(self) -> None:
        if self.reader:
            return
        started = time.perf_counter()
        self._flush()
        self.writer.close()
        self.writer = None
        self.reader = self.path.open("rb")
        self.write_seconds += time.perf_counter() - started
        if len(self.training_order) != len(self.index):
            raise RuntimeError("Not all episode trajectories were completed")

    def __len__(self) -> int:
        return len(self.training_order)

    def training_metadata(self) -> list[dict]:
        return [self.metadata[sample_id] for sample_id in self.training_order]

    def _chunk(self, chunk_id: int) -> bytes | None:
        start, size = self.chunks[chunk_id]
        if size > self.read_limit:
            return None
        with self.lock:
            cached = self.cache.get(chunk_id)
            if cached is not None:
                self.cache.move_to_end(chunk_id)
                return cached
            t0 = time.perf_counter()
            self.reader.seek(start)
            data = self.reader.read(size)
            if len(data) != size:
                raise IOError("Incomplete trajectory chunk")
            self.read_seconds += time.perf_counter() - t0
            while self.cache and self.cache_bytes + size > self.read_limit:
                _, old = self.cache.popitem(last=False)
                self.cache_bytes -= len(old)
            self.cache[chunk_id] = data
            self.cache_bytes += size
            self.peak_read_bytes = max(self.peak_read_bytes, self.cache_bytes)
            return data

    def prefetch(self, order_indices: list[int]) -> None:
        if not order_indices or self.closed:
            return
        if self.prefetch_future and not self.prefetch_future.done():
            return  # one bounded in-flight request; never queue more
        counts = defaultdict(int)
        for index in order_indices:
            counts[self.index[self.training_order[index]][0]] += 1
        chosen, total = [], 0
        for chunk_id in sorted(counts, key=lambda key: (-counts[key], key)):
            size = self.chunks[chunk_id][1]
            if total + size <= self.prefetch_limit:
                chosen.append(chunk_id)
                total += size
        if chosen:
            self.prefetch_future = self.prefetcher.submit(lambda: [self._chunk(chunk) for chunk in chosen])

    def epoch_batches(self, positions: list[int], rng, minibatch: int):
        """Shuffle disk blocks and records each epoch, carrying short block tails.

        Positions refer to training_order, while rewards/GAE remain attached to
        their original sample IDs. No observation payload is materialized here.
        """
        groups = defaultdict(list)
        for position in positions:
            sample_id = self.training_order[position]
            groups[self.index[sample_id][0]].append(position)
        blocks, block, size = [], [], 0
        for chunk in sorted(groups):
            chunk_size = self.chunks[chunk][1]
            if block and size + chunk_size > self.read_limit:
                blocks.append(block)
                block, size = [], 0
            block.extend(groups[chunk])
            size += chunk_size
        if block:
            blocks.append(block)
        rng.shuffle(blocks)
        carry = []
        for block in blocks:
            rng.shuffle(block)
            carry.extend(block)
            while len(carry) >= minibatch:
                yield carry[:minibatch]
                del carry[:minibatch]
        if carry:
            yield carry

    def load_batch(self, order_indices: list[int]) -> list[dict]:
        if not self.reader or self.closed:
            raise RuntimeError("Trajectory spool is not readable")
        started = time.perf_counter()
        if self.prefetch_future:
            self.prefetch_future.result()
            self.prefetch_future = None
        groups = defaultdict(list)
        for position, order_index in enumerate(order_indices):
            sample_id = self.training_order[order_index]
            groups[self.index[sample_id][0]].append((position, sample_id))
        result = [None] * len(order_indices)
        for chunk_id in sorted(groups):
            data = self._chunk(chunk_id)
            chunk_start = self.chunks[chunk_id][0]
            for position, sample_id in groups[chunk_id]:
                _, offset, rows, width = self.index[sample_id]
                length = HEADER.size + 2 * (self.metadata[sample_id]["stateWidth"] + rows * width)
                if data is None:
                    with self.lock:
                        t0 = time.perf_counter()
                        self.reader.seek(chunk_start + offset)
                        record = self.reader.read(length)
                        self.read_seconds += time.perf_counter() - t0
                else:
                    record = memoryview(data)[offset:offset + length]
                found, state_width, found_rows, found_width = HEADER.unpack_from(record)
                if (found, state_width, found_rows, found_width) != (
                        sample_id, self.metadata[sample_id]["stateWidth"], rows, width) or len(record) != length:
                    raise IOError("Trajectory sample index mismatch")
                start = HEADER.size
                state = torch.from_numpy(np.frombuffer(record, dtype="<f2", count=state_width,
                                                       offset=start).copy())
                candidates = torch.from_numpy(np.frombuffer(record, dtype="<f2", count=rows * width,
                                                            offset=start + state_width * 2).copy()).reshape(rows, width)
                result[position] = {**self.metadata[sample_id], "state": state, "candidates": candidates}
        self.batch_load_seconds += time.perf_counter() - started
        return result

    def stats(self) -> dict:
        return {"sampleCount": len(self.index), "candidateTotal": self.candidate_total,
                "trajectoryFileBytes": self.path.stat().st_size if self.path.exists() else 0,
                "chunkCount": len(self.chunks), "writeBufferBytes": len(self.buffer),
                "peakWriteBufferBytes": self.peak_write_bytes, "readCacheBytes": self.cache_bytes,
                "peakReadCacheBytes": self.peak_read_bytes, "writeSeconds": self.write_seconds,
                "readSeconds": self.read_seconds, "batchLoadSeconds": self.batch_load_seconds,
                "writeLimitBytes": self.write_limit,
                "readLimitBytes": self.read_limit, "prefetchLimitBytes": self.prefetch_limit,
                "samplerVersion": SAMPLER_VERSION,
                "prefetchPending": bool(self.prefetch_future and not self.prefetch_future.done())}

    def close(self) -> dict:
        if self.closed:
            return {"removed": not self.directory.exists()}
        self.closed = True
        self.prefetcher.shutdown(wait=True, cancel_futures=True)
        self.prefetch_future = None
        self.prefetcher = None
        if self.reader:
            self.reader.close()
            self.reader = None
        if self.writer:
            self.writer.close()
            self.writer = None
        self.cache.clear()
        self.cache_bytes = 0
        self.buffer.clear()
        self.metadata.clear()
        self.index.clear()
        self.training_order.clear()
        self.chunks.clear()
        _remove_owned_directory(self.root, self.directory)
        return {"removed": not self.directory.exists(), "directory": self.directory.name}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Safely remove abandoned PPO trajectory batches")
    parser.add_argument("--cleanup-stale", action="store_true", required=True)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    print(json.dumps({"removed": cleanup_stale(args.root)}, ensure_ascii=False))
