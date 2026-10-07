"""Read-only coverage report for completed or partial C2 course pools."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

from scripts import ppo_combo_course_v2 as course
from scripts import ppo_combo_bc as bc
from scripts import ppo_train as ppo


def summarize(payload):
    rows = []
    for template in course.TEMPLATES:
        matches = [e for e in payload["entries"] if e["template"] == template.key]
        buckets = Counter((e["variant"], e["layer"], e["split"]) for e in matches)
        rows.append({"template": template.key,
            "teachingTarget": bc.TEACHING_TARGETS[template.key],
            "positiveTrainTrajectories": len({e["seed"] for e in matches if
                e["variant"] == "positive" and e["layer"] == "payoff" and
                e["split"] == "train"}),
            "positiveHeldoutTrajectories": len({e["seed"] for e in matches if
                e["variant"] == "positive" and e["layer"] == "payoff" and
                e["split"] == "evaluation"}),
            "buckets": {f"{variant}:{layer}:{split}": count for
                (variant, layer, split), count in sorted(buckets.items())},
            "preparationTargets": Counter(e.get("preparationTarget") for e in matches
                if e["layer"] == "preparation"),
            "controlRoles": Counter(e.get("controlRole") for e in matches),
            "failedAttempts": Counter(f.get("reason") for f in payload["failures"]
                if f.get("template") == template.key)})
    encoded = defaultdict(set)
    for entry in payload["entries"]:
        if entry["layer"] == "preparation" and entry.get("encodedSceneSha256"):
            encoded[entry["encodedSceneSha256"]].add(entry["split"])
    return {"complete": payload.get("complete"), "courseVersion": payload["identity"]["version"],
        "entries": len(payload["entries"]), "failedAttempts": len(payload["failures"]),
        "crossSplitIdenticalEncodedScenes": sum(len(x) > 1 for x in encoded.values()),
        "templates": rows}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pool", type=Path, default=ppo.ROOT / "PPO训练" /
        ".state" / "A2S1C2" / "course-pool-v8.json.gz")
    args = parser.parse_args()
    with gzip.open(args.pool, "rt", encoding="utf-8") as stream:
        payload = json.load(stream)
    report = summarize(payload)
    report["poolSha256"] = hashlib.sha256(args.pool.read_bytes()).hexdigest()
    print(json.dumps(report, ensure_ascii=False, indent=2,
                     default=lambda x: dict(x) if isinstance(x, Counter) else str(x)))


if __name__ == "__main__":
    main()
