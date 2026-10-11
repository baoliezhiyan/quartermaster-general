"""Bounded, resumable archive for training-only, off-policy exploration.

Snapshots contain full engine truth and must never be passed to the actor as an
observation. SQLite transactions make a branch and its coverage counters atomic.
"""
from __future__ import annotations

import hashlib
import json
import random
import sqlite3
import time
import zlib
from pathlib import Path

VERSION = "auto-exploration-archive-v1"
MAX_CELLS = 1_000
MAX_REPRESENTATIVES = 3
MAX_BYTES = 1 << 30


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def action_family(candidate):
    """Structural action identity; instance IDs and display labels are excluded."""
    def effect(item):
        return {key: item.get(key) for key in (
            "kind", "action", "country", "seat", "fee", "optional", "min", "max",
            "count", "amount", "regions") if key in item}
    return canonical({"kind": candidate.get("kind"),
        "cardType": candidate.get("cardType"), "statusAction": candidate.get("statusAction"),
        "effects": [effect(item) for item in candidate.get("effects", ())],
        "choices": [{"kind": choice.get("kind"), "action": choice.get("action"),
                     "country": choice.get("country"), "repeated": choice.get("repeated")}
                    for choice in candidate.get("choices", ())]})


def cell_key(observation):
    """Coarse tactical bucket. Exact representative remains separately available."""
    units = observation.get("units", ())
    unit_presence = sorted({(u.get("country"), u.get("type"), u.get("regionId")) for u in units})
    resources = observation.get("ownResources", {}).get("open", {})
    count_bucket = lambda n: 0 if n <= 0 else 1 if n == 1 else 2 if n <= 3 else 4
    score = observation.get("allianceScores", {})
    margin = score.get("axis", 0) - score.get("allies", 0)
    abilities = observation.get("visibleCards", {}).get("active", {})
    return digest({"seat": observation.get("decisionSeat"),
        "node": observation.get("node"), "phase": observation.get("phase"),
        "round": 0 if observation.get("round", 0) <= 3 else
                 1 if observation.get("round", 0) <= 7 else
                 2 if observation.get("round", 0) <= 12 else 3,
        "margin": margin // 10, "units": unit_presence,
        "resources": sorted((key, count_bucket(value)) for key, value in resources.items()),
        "active": sorted((seat, tuple(sorted(cards))) for seat, cards in abilities.items()),
        "choice": (observation.get("choiceKind"), observation.get("choiceField"))})


def representative_key(observation):
    """Stable semantic identity; no card instance IDs, deck order or game ID."""
    candidates = [(c.get("definitionId"), action_family(c),
            sorted([(x.get("regionId"), x.get("country"), x.get("repeated"))
                    for x in c.get("choices", ())], key=canonical))
            for c in observation.get("candidates", ())]
    return digest({"cell": cell_key(observation),
        "candidates": sorted(candidates, key=canonical),
        "supply": observation.get("effectiveSupply"),
        "roundUses": observation.get("visibleRoundUseCounts"),
        "turnUses": observation.get("visibleUseCounts")})


class ExplorationArchive:
    def __init__(self, path: Path, identity: dict, *, max_cells=MAX_CELLS,
                 max_bytes=MAX_BYTES, representatives=MAX_REPRESENTATIVES):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.max_cells, self.max_bytes, self.representatives = max_cells, max_bytes, representatives
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS roots(
            id TEXT PRIMARY KEY,cell TEXT NOT NULL,representative TEXT NOT NULL,
            snapshot BLOB NOT NULL,observation BLOB NOT NULL,prefix BLOB NOT NULL,
            byte_count INTEGER NOT NULL,created REAL NOT NULL,progress REAL NOT NULL,
            parent_path TEXT,UNIQUE(cell,representative));
          CREATE INDEX IF NOT EXISTS roots_cell ON roots(cell);
          CREATE TABLE IF NOT EXISTS coverage(
            cell TEXT NOT NULL,signature TEXT NOT NULL,family TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,completed INTEGER NOT NULL DEFAULT 0,
            cancelled INTEGER NOT NULL DEFAULT 0,ineffective INTEGER NOT NULL DEFAULT 0,
            useful INTEGER NOT NULL DEFAULT 0,truncated INTEGER NOT NULL DEFAULT 0,
            last_attempt REAL NOT NULL DEFAULT 0,cooldown_until INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(cell,signature));
          CREATE TABLE IF NOT EXISTS branches(
            id TEXT PRIMARY KEY,root_id TEXT NOT NULL,kind TEXT NOT NULL,
            record BLOB NOT NULL,created REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS routes(
            id TEXT PRIMARY KEY,root_id TEXT NOT NULL,status TEXT NOT NULL,
            evidence BLOB NOT NULL,created REAL NOT NULL,revoked_reason TEXT);
          CREATE TABLE IF NOT EXISTS demonstrations(
            id TEXT PRIMARY KEY,route_id TEXT NOT NULL,card_family TEXT NOT NULL,
            payload BLOB NOT NULL,created REAL NOT NULL,use_count INTEGER NOT NULL DEFAULT 0);
        """)
        existing = self.db.execute("SELECT value FROM metadata WHERE key='identity'").fetchone()
        expected = canonical({"version": VERSION, **identity})
        if existing is None:
            self.db.execute("INSERT INTO metadata VALUES('identity',?)", (expected,))
            self.db.commit()
        elif existing[0] != expected:
            self.close()
            raise ValueError("Exploration archive model/rules/configuration identity differs")

    def close(self):
        if self.db:
            self.db.close()
            self.db = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    @staticmethod
    def _pack(value):
        return zlib.compress(canonical(value).encode("utf-8"), 6)

    @staticmethod
    def _unpack(value):
        return json.loads(zlib.decompress(value))

    def payload_bytes(self):
        """Bound all persisted compressed payloads, not only root snapshots."""
        return sum(self.db.execute(query).fetchone()[0] or 0 for query in (
            "SELECT SUM(byte_count) FROM roots",
            "SELECT SUM(length(record)) FROM branches",
            "SELECT SUM(length(evidence)) FROM routes",
            "SELECT SUM(length(payload)) FROM demonstrations"))

    def add_root(self, snapshot, observation, prefix, parent_path=None):
        cell, representative = cell_key(observation), representative_key(observation)
        if self.db.execute("SELECT 1 FROM roots WHERE cell=? AND representative=?",
                           (cell, representative)).fetchone():
            return None, "duplicate"
        cells = self.db.execute("SELECT COUNT(DISTINCT cell) FROM roots").fetchone()[0]
        count = self.db.execute("SELECT COUNT(*) FROM roots WHERE cell=?", (cell,)).fetchone()[0]
        if cells >= self.max_cells and not count:
            return None, "cell_capacity"
        if count >= self.representatives:
            return None, "representative_capacity"
        chunks = tuple(map(self._pack, (snapshot, observation, prefix)))
        size = sum(map(len, chunks))
        used = self.payload_bytes()
        if used + size > self.max_bytes:
            return None, "byte_capacity"
        root_id = digest({"cell": cell, "representative": representative,
                          "state": snapshot.get("state"), "prefix": prefix})
        now = time.time()
        with self.db:
            self.db.execute("INSERT INTO roots VALUES(?,?,?,?,?,?,?,?,?,?)",
                (root_id, cell, representative, *chunks, size, now, now, parent_path))
        return root_id, "stored"

    def roots(self):
        return [row[0] for row in self.db.execute("SELECT id FROM roots ORDER BY created,id")]

    def roots_by_queue(self, queue):
        condition = "parent_path IS NOT NULL" if queue == "continuation" else "parent_path IS NULL"
        return [row[0] for row in self.db.execute(
            f"SELECT id FROM roots WHERE {condition} ORDER BY progress,id")]

    def read_root(self, root_id):
        row = self.db.execute("SELECT snapshot,observation,prefix,cell FROM roots WHERE id=?",
                              (root_id,)).fetchone()
        if row is None:
            raise KeyError(root_id)
        return {"id": root_id, "snapshot": self._unpack(row[0]),
                "observation": self._unpack(row[1]), "prefix": self._unpack(row[2]),
                "cell": row[3]}

    def coverage_count(self, cell, card_id, family):
        signature = canonical((card_id, family))
        row = self.db.execute("SELECT attempts,completed FROM coverage WHERE cell=? AND signature=?",
                              (cell, signature)).fetchone()
        return (row or (0, 0))

    def record_branch(self, root_id, card_id, family, branch, outcome):
        if outcome not in ("completed", "cancelled", "ineffective", "useful", "truncated"):
            raise ValueError(outcome)
        root = self.read_root(root_id)
        branch_id = digest({"root": root_id, "kind": branch.get("kind"),
                            "seed": branch.get("seed"),
                            "reviewSeed": branch.get("reviewSeed"),
                            "actionIds": [step["actionId"] for step in branch.get("path", ())]})
        packed = self._pack(branch)
        if not self.db.execute("SELECT 1 FROM branches WHERE id=?", (branch_id,)).fetchone() and \
                self.payload_bytes()+len(packed)>self.max_bytes:
            raise OverflowError("Exploration archive byte capacity reached")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO branches VALUES(?,?,?,?,?)",
                            (branch_id, root_id, branch.get("kind", "coverage"), packed, time.time()))
            if self.db.execute("SELECT changes()").fetchone()[0]:
                signature = canonical((card_id, family))
                self.db.execute("INSERT OR IGNORE INTO coverage(cell,signature,family) VALUES(?,?,?)",
                                (root["cell"], signature, family))
                completed = "completed=completed+1," if outcome == "useful" else ""
                self.db.execute(f"UPDATE coverage SET attempts=attempts+1,{completed}"
                                f"{outcome}={outcome}+1,"
                                "last_attempt=? WHERE cell=? AND signature=?",
                                (time.time(), root["cell"], signature))
        return branch_id

    def branch_pairs(self):
        return self.db.execute("SELECT COUNT(*) FROM branches WHERE kind='coverage'").fetchone()[0]

    def add_route(self, root_id, evidence, status="candidate"):
        if status not in ("candidate", "reviewed", "enabled", "revoked"):
            raise ValueError(status)
        route_id = digest({"root": root_id, "path": evidence.get("path")})
        packed = self._pack(evidence)
        if not self.db.execute("SELECT 1 FROM routes WHERE id=?", (route_id,)).fetchone() and \
                self.payload_bytes()+len(packed)>self.max_bytes:
            raise OverflowError("Exploration archive byte capacity reached")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO routes VALUES(?,?,?,?,?,NULL)",
                            (route_id, root_id, status, packed, time.time()))
        return route_id

    def route(self, route_id):
        row = self.db.execute("SELECT status,evidence FROM routes WHERE id=?", (route_id,)).fetchone()
        if not row:
            raise KeyError(route_id)
        return {"id": route_id, "status": row[0], "evidence": self._unpack(row[1])}

    def routes(self, status=None):
        query = "SELECT id FROM routes" + (" WHERE status=?" if status else "") + " ORDER BY created,id"
        return [row[0] for row in self.db.execute(query, (status,) if status else ())]

    def add_demonstrations(self, route_id, card_family, decisions):
        if self.route(route_id)["status"] != "enabled":
            raise ValueError("Only independently reviewed routes can enter the demonstration library")
        route_count = self.db.execute("SELECT COUNT(DISTINCT route_id) FROM demonstrations").fetchone()[0]
        if route_count >= 200:
            return 0, "route_capacity"
        decision_count = self.db.execute("SELECT COUNT(*) FROM demonstrations").fetchone()[0]
        if decision_count + len(decisions) > 20_000:
            return 0, "decision_capacity"
        family_count = self.db.execute("SELECT COUNT(DISTINCT route_id) FROM demonstrations "
                                       "WHERE card_family=?", (card_family,)).fetchone()[0]
        if route_count >= 7 and (family_count + 1) / (route_count + 1) > .15:
            return 0, "family_capacity"
        packed = [self._pack(decision) for decision in decisions]
        if self.payload_bytes()+sum(map(len,packed))>self.max_bytes:
            return 0, "byte_capacity"
        with self.db:
            for position, payload in enumerate(packed):
                self.db.execute("INSERT OR IGNORE INTO demonstrations VALUES(?,?,?,?,?,0)",
                    (digest({"route": route_id, "position": position}), route_id,
                     card_family, payload, time.time()))
        return len(decisions), "stored"

    def demonstrations(self):
        rows = self.db.execute("SELECT id,route_id,payload FROM demonstrations ORDER BY route_id,id")
        return [{"id": item[0], "routeId": item[1], **self._unpack(item[2])} for item in rows]

    def demonstration_batch(self, limit=64, seed=0):
        """Load at most one bounded, route-balanced imitation minibatch."""
        if limit < 1 or limit > 64:
            raise ValueError("Demonstration read cache must stay within 64 samples")
        routes = [row[0] for row in self.db.execute(
            "SELECT DISTINCT route_id FROM demonstrations ORDER BY route_id")]
        rng = random.Random(seed)
        chosen = []
        while routes and len(chosen) < limit:
            rng.shuffle(routes)
            for route in list(routes):
                ids = [row[0] for row in self.db.execute(
                    "SELECT id FROM demonstrations WHERE route_id=? ORDER BY id", (route,))]
                used = {item[0] for item in chosen}
                available = [item for item in ids if item not in used]
                if not available:
                    routes.remove(route)
                    continue
                chosen.append((rng.choice(available), route))
                if len(chosen) >= limit:
                    break
        output = []
        for item_id, route in chosen:
            payload = self.db.execute(
                "SELECT payload FROM demonstrations WHERE id=?", (item_id,)).fetchone()[0]
            output.append({"id": item_id, "routeId": route, **self._unpack(payload)})
        return output

    def set_route_status(self, route_id, status, reason=None):
        if status not in ("reviewed", "enabled", "revoked"):
            raise ValueError(status)
        with self.db:
            self.db.execute("UPDATE routes SET status=?,revoked_reason=? WHERE id=?",
                            (status, reason, route_id))

    def stats(self):
        return {"roots": self.db.execute("SELECT COUNT(*) FROM roots").fetchone()[0],
                "cells": self.db.execute("SELECT COUNT(DISTINCT cell) FROM roots").fetchone()[0],
                "snapshotBytes": self.db.execute("SELECT COALESCE(SUM(byte_count),0) FROM roots").fetchone()[0],
                "payloadBytes": self.payload_bytes(),
                "coverage": self.db.execute("SELECT COALESCE(SUM(attempts),0) FROM coverage").fetchone()[0],
                "branches": self.db.execute("SELECT COUNT(*) FROM branches").fetchone()[0],
                "routes": dict(self.db.execute("SELECT status,COUNT(*) FROM routes GROUP BY status")),
                "demonstrationDecisions": self.db.execute("SELECT COUNT(*) FROM demonstrations").fetchone()[0]}
