"""One disposable, explicitly incomplete C2 imitation diagnostic.

This cannot create initial.pt or authorize formal PPO training. It preserves
the C1 parent and records exactly which lessons were represented.
"""
from __future__ import annotations

import copy
import hashlib
import json
import time
from pathlib import Path

import torch

from scripts import ppo_combo_bc as bc
from scripts import ppo_combo_course as first
from scripts import ppo_combo_course_v2 as course
from scripts import ppo_combo_v2_prepare as prepare
from scripts import ppo_train as ppo


SEEDS = (("G1", "positive", 2026100400),
         ("G3", "positive", 2026102406),
         ("U1", "positive", 2026103400),
         ("U4", "positive", 2026108400),
         ("U1", "control", 2026103501),
         ("U4", "control", 2026108500))


def run():
    torch.set_num_threads(2)
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        source, model = prepare.verify_parent(prepare.PARENT, client, encoder)
        generator, _ = first.load_parent(prepare.GENERATOR, encoder, torch.device("cpu"))
        before_hash = ppo.model_weights_sha256(model)
        before_state = copy.deepcopy(model.state_dict())
        entries = []
        for key, variant, seed in SEEDS:
            result = course.generate_one(client, encoder, generator, torch.device("cpu"),
                course.BY_KEY[key], seed, variant)
            if "failure" in result:
                raise RuntimeError(f"Bounded diagnostic route unavailable: {key}:{seed}:"
                                   f"{result['failure']}")
            entries.append({**result, "split": "train", "layer": "payoff",
                "courseId": f"{key}:{variant}:payoff:{seed}",
                "controlRole": course.classify_control(course.BY_KEY[key], variant)})
        labels, controls, evidence = bc.extract(client, encoder, model, entries)
        adaptation = bc.adapt(model, labels, controls, config={"maxSteps": 4})
        after_hash = ppo.model_weights_sha256(model)
        folder = (prepare.ROOT / "failed-demonstrations" /
            f"bounded-semantic-v7-{time.time_ns()}")
        folder.mkdir(parents=True, exist_ok=False)
        torch.save({"stage": "before-incomplete-diagnostic", "modelState": before_state,
                    "weightsSha256": before_hash}, folder / "before.pt")
        torch.save({"stage": "after-incomplete-diagnostic", "modelState": model.state_dict(),
                    "weightsSha256": after_hash}, folder / "after.pt")
        report = {"acceptedForPpo": False, "reason": "four-of-nine-template-diagnostic-only",
            "parentCheckpointSha256": prepare.sha(prepare.PARENT),
            "parentBuildFingerprint": source["buildFingerprint"],
            "currentBuildFingerprint": client.fingerprint,
            "poolVersion": course.VERSION, "trainingSeeds": SEEDS,
            "directTeachingTargetsPresent": sorted({(x["metadata"]["courseId"].split(":", 1)[0],
                x["metadata"]["cardId"]) for x in labels}),
            "demonstrationEvidence": evidence, "adaptation": adaptation,
            "beforeWeightsSha256": before_hash, "afterWeightsSha256": after_hash,
            "parentUnchanged": prepare.sha(prepare.PARENT) ==
                prepare.REVIEWED_PARENT_SHA256}
        (folder / "audit.json").write_text(json.dumps(report, ensure_ascii=False,
            indent=2, default=str), encoding="utf-8")
        print(json.dumps({"folder": str(folder), "acceptedForPpo": False,
            "steps": len(adaptation["history"]), "seconds": adaptation["seconds"],
            "beforeWeightsSha256": before_hash, "afterWeightsSha256": after_hash,
            "scriptLabels": evidence["scriptLabels"],
            "uniqueEncodedScenes": evidence["uniqueEncodedScenes"],
            "parentUnchanged": report["parentUnchanged"]}, ensure_ascii=False))
    finally:
        client.close()


if __name__ == "__main__":
    run()
