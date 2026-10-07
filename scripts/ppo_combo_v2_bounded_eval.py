"""Read-only before/after evaluation of the one incomplete C2 BC attempt."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch

from scripts import ppo_combo_bc as bc
from scripts import ppo_combo_course as first
from scripts import ppo_combo_course_v2 as course
from scripts import ppo_combo_v2_prepare as prepare
from scripts import ppo_train as ppo
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network


HELDOUT = (("G1", 2026100440), ("G3", 2026102449),
           ("U1", 2026103447), ("U4", 2026108420))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--attempt", type=Path, required=True)
    args = parser.parse_args()
    torch.set_num_threads(2)
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        generator, _ = first.load_parent(prepare.GENERATOR, encoder, torch.device("cpu"))
        models = []
        for name in ("before", "after"):
            saved = torch.load(args.attempt / f"{name}.pt", map_location="cpu",
                               weights_only=False)
            model = make_network(A2S1_ADAPTER, encoder)
            model.load_state_dict(saved["modelState"], strict=True)
            models.append(model)
        entries, missing = [], []
        for key, seed in HELDOUT:
            result = course.generate_one(client, encoder, generator, torch.device("cpu"),
                course.BY_KEY[key], seed, "positive")
            if "failure" in result:
                missing.append({"template": key, "seed": seed, "reason": result["failure"]})
                continue
            prep = result["preparation"]
            entry = {**result, "snapshot": prep["snapshot"],
                "trace": result["trace"][:prep["traceLength"]],
                "template": key, "variant": "positive", "layer": "preparation",
                "split": "evaluation", "courseId": f"{key}:positive:preparation:{seed}",
                "preparationTarget": prep["target"],
                "preparationCandidateId": prep["candidateId"],
                "preparationMissing": prep["missing"]}
            course.validate_preparation(client, entry)
            entries.append(entry)
        holdout = bc.assess_holdout(client, encoder, models[0], models[1], entries)
        autonomous = bc.assess_autonomous(client, encoder, models[1], entries,
                                         max_decisions=80)
        report = {"acceptedForPpo": False, "reason": "incomplete-nine-template-coverage",
            "holdout": holdout, "autonomous": autonomous, "missing": missing}
        target = args.attempt / "heldout-diagnostic.json"
        if target.exists():
            raise FileExistsError(target)
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"attempt": str(args.attempt), "holdoutScenes": len(
            holdout["scenes"]), "autonomousRuns": len(autonomous), "missing": missing,
            "acceptedForPpo": False}, ensure_ascii=False))
    finally:
        client.close()


if __name__ == "__main__":
    main()
