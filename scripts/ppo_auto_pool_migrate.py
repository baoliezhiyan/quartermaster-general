"""Rebuild historical course snapshots by replaying every legal preparation trace.

The old pool remains untouched. A new fingerprint is earned by executing the
same commands in the current engine, never by rewriting a stored header.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path

from scripts import ppo_train as ppo
from scripts import ppo_combo_course_v2 as course
from scripts.ppo_combo_course import replay

VERSION = "auto-course-pool-legal-replay-v1"


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def migrate(source: Path, target: Path, *, expected_source_sha: str):
    if target.exists():
        raise FileExistsError(target)
    if file_hash(source) != expected_source_sha:
        raise ValueError("Historical pool hash differs; migration refused")
    with gzip.open(source, "rt", encoding="utf-8") as stream:
        previous = json.load(stream)
    if not previous.get("complete") or not previous.get("entries"):
        raise ValueError("Historical pool is incomplete")
    old_identity = previous["identity"]
    client = ppo.ArenaClient(card_set="signals")
    try:
        identity = course.pool_identity(client, old_identity["parentCheckpointSha256"],
                                        old_identity["generatorWeightsSha256"])
        entries = []
        for number, original in enumerate(previous["entries"], 1):
            entry = dict(original)
            observation = replay(client, original)
            if observation is None:
                raise ValueError(f"Course {entry['courseId']} ended before takeover")
            entry["snapshot"] = client.request(op="snapshot")["snapshot"]
            entries.append(entry)
            if number % 20 == 0:
                print(f"Legally replayed {number}/{len(previous['entries'])} course starts", flush=True)
        for entry in entries:
            client.request(op="restore", snapshot=entry["snapshot"])
        metadata = {"version": VERSION, "sourcePoolSha256": expected_source_sha,
                    "sourceIdentity": old_identity, "entryCount": len(entries),
                    "method": "reset-and-replay-every-legal-preparation-action"}
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".tmp")
        try:
            with gzip.open(temporary, "wt", encoding="utf-8", compresslevel=6) as stream:
                json.dump({"identity": identity, "entries": entries,
                           "failures": previous.get("failures", []), "complete": True,
                           "migration": metadata}, stream, ensure_ascii=False,
                          separators=(",", ":"))
            os.replace(temporary, target)
            course.read_pool(target, identity)
        finally:
            temporary.unlink(missing_ok=True)
        return {"poolSha256": file_hash(target), "entries": len(entries),
                "identitySha256": identity["identitySha256"],
                "buildFingerprint": client.fingerprint}
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--source-sha256", required=True)
    args = parser.parse_args()
    print(json.dumps(migrate(args.source, args.target,
                             expected_source_sha=args.source_sha256),
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
