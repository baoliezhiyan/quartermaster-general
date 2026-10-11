"""Read-only, fingerprint-checked carryover of independently reviewed routes."""
from __future__ import annotations

import hashlib
import json
import os
import random
import sqlite3
import zlib
from pathlib import Path

from scripts.ppo_auto_archive import VERSION as ARCHIVE_VERSION

FROZEN = (Path(__file__).resolve().parents[1] /
          "PPO训练/.state/A2自动探索试验01/frozen-library.sqlite")


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for part in iter(lambda: stream.read(1 << 20), b""):
            digest.update(part)
    return digest.hexdigest()


def _read_only(path):
    if not Path(path).is_file():
        raise FileNotFoundError(path)
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)


def verify(db, *, build_fingerprint, encoder_version, reward_config):
    row = db.execute("SELECT value FROM metadata WHERE key='identity'").fetchone()
    if not row:
        raise ValueError("Exploration library lacks identity")
    identity = json.loads(row[0])
    if (identity.get("version") != ARCHIVE_VERSION or
        identity.get("buildFingerprint") != build_fingerprint or
        identity.get("encoderVersion") != encoder_version or
        identity.get("rewardConfig") != reward_config):
        raise ValueError("Reviewed library rules, reward or encoding differ")
    return identity


def freeze(source: Path, target: Path, *, build_fingerprint, encoder_version,
           reward_config):
    if target.exists():
        raise FileExistsError(target)
    source_db = _read_only(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    try:
        identity = verify(source_db, build_fingerprint=build_fingerprint,
            encoder_version=encoder_version, reward_config=reward_config)
        count = source_db.execute("SELECT COUNT(*) FROM demonstrations d JOIN routes r "
            "ON r.id=d.route_id WHERE r.status='enabled'").fetchone()[0]
        if not count:
            raise ValueError("No independently qualified demonstration exists")
        if temporary.exists():
            raise FileExistsError(temporary)
        destination = sqlite3.connect(temporary)
        try:
            source_db.backup(destination)
        finally:
            destination.close()
        os.replace(temporary, target)
        return {"sha256": sha(target), "demonstrationDecisions": count,
                "sourceIdentity": identity}
    finally:
        source_db.close()
        temporary.unlink(missing_ok=True)


def load_batch(path: Path, *, expected_sha, build_fingerprint, encoder_version,
               reward_config, limit=64, seed=0):
    if not 1 <= limit <= 64 or sha(path) != expected_sha:
        raise ValueError("Frozen demonstration file or bounded-read limit differs")
    db = _read_only(path)
    try:
        verify(db, build_fingerprint=build_fingerprint,
               encoder_version=encoder_version, reward_config=reward_config)
        routes = [row[0] for row in db.execute(
            "SELECT DISTINCT d.route_id FROM demonstrations d JOIN routes r "
            "ON r.id=d.route_id WHERE r.status='enabled' ORDER BY d.route_id")]
        rng = random.Random(seed)
        rows = []
        while routes and len(rows) < limit:
            rng.shuffle(routes)
            for route in list(routes):
                ids = [row[0] for row in db.execute(
                    "SELECT id FROM demonstrations WHERE route_id=? ORDER BY id", (route,))]
                remaining = [id for id in ids if id not in {row[0] for row in rows}]
                if not remaining:
                    routes.remove(route)
                    continue
                rows.append((rng.choice(remaining), route))
                if len(rows) >= limit:
                    break
        output = []
        for id, route in rows:
            payload = db.execute("SELECT payload FROM demonstrations WHERE id=?", (id,)).fetchone()[0]
            output.append({"id": id, "routeId": route, **json.loads(zlib.decompress(payload))})
        return output
    finally:
        db.close()


def main():
    import argparse
    from scripts import ppo_train as ppo
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("--target", type=Path, default=FROZEN)
    args = parser.parse_args()
    client = ppo.ArenaClient(card_set="signals")
    try:
        print(json.dumps(freeze(args.source, args.target,
            build_fingerprint=client.fingerprint,
            encoder_version=ppo.encoder_version("signals"),
            reward_config=ppo.reward_config("signals")),
            ensure_ascii=False, indent=2))
    finally:
        client.close()


if __name__ == "__main__":
    main()
