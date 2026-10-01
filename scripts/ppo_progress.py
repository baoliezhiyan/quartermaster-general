"""Compact terminal-only progress; detailed metrics stay in the JSON report."""
from __future__ import annotations

import sys
import threading
import time


def ordinal(number: int, unit: str) -> str:
    names = "一二三四五六七八九十"
    return f"第{names[number - 1] if 1 <= number <= 10 else number}{unit}"


class ProgressDisplay:
    def __init__(self, label: str, total: int, stream=None, interval: float = 0.5):
        if total < 1:
            raise ValueError("Progress total must be positive")
        self.label, self.total = label, total
        self.stream = stream if stream is not None else sys.stdout
        self.interval = interval
        self.started = 0.0
        self.completed = 0
        self.stage = ""
        self.lock = threading.Lock()
        self.output_lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.interactive = bool(getattr(self.stream, "isatty", lambda: False)())

    def __enter__(self):
        self.started = time.perf_counter()
        self._draw()
        if self.interactive:
            self.thread.start()
        return self

    def update(self, completed: int):
        if not 0 <= completed <= self.total:
            raise ValueError("Progress count outside task range")
        with self.lock:
            self.completed = completed
        if self.interactive:
            self._draw()

    def set_stage(self, stage: str):
        with self.lock:
            self.stage = stage
        if self.interactive:
            self._draw()

    def _draw(self, final: str = ""):
        with self.lock:
            completed, stage = self.completed, self.stage
        filled = 20 * completed // self.total
        bar = "#" * filled + "-" * (20 - filled)
        elapsed = int(time.perf_counter() - self.started)
        line = f"{self.label} [{bar}] {completed}/{self.total} {elapsed}s"
        if final or stage:
            line += f" {final or stage}"
        with self.output_lock:
            self.stream.write(("\r" if self.interactive else "") + line + "   ")
            if final or not self.interactive:
                self.stream.write("\n")
            self.stream.flush()

    def _loop(self):
        while not self.stop.wait(self.interval):
            self._draw()

    def __exit__(self, exception_type, _exception, _traceback):
        self.stop.set()
        if self.thread.is_alive():
            self.thread.join()
        self._draw("失败" if exception_type else "完成")
