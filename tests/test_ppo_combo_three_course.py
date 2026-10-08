"""Regression checks for the isolated three-course BC study."""
import copy
import gzip
import json
import unittest

import torch

from scripts import ppo_train as ppo
from scripts import ppo_combo_bc as bc
from scripts import ppo_combo_three_course as study
from scripts import ppo_combo_course_v2 as course


class SemanticTests(unittest.TestCase):
    def test_fixed_split_budget_and_no_result_based_retention_labels(self):
        plan = json.loads(study.PLAN.read_text(encoding="utf-8"))
        targets = plan["generation"]["targetPerTemplate"]
        self.assertEqual([study.split_for_index(i, targets) for i in range(13)],
                         ["train"]*8 + ["validation"]*3 + ["final_test"]*2)
        self.assertEqual(study.classify_retention.__code__.co_varnames[:2],
                         ("observation", "state"))
        self.assertEqual(plan["learning"]["maxKl"], .02)
        self.assertEqual(plan["learning"]["maxValueShift"], .15)

    def test_tactical_signature_ignores_card_order_not_key_resources(self):
        with gzip.open(study.BASE / "course-pool-v8.json.gz", "rt",
                       encoding="utf-8") as stream:
            entries = json.load(stream)["entries"]
        state = next(e["snapshot"]["state"] for e in entries if e["template"] ==
                     "G1" and e["layer"] == "preparation")
        changed = copy.deepcopy(state)
        changed["decks"]["germany"]["hand"].reverse()
        self.assertEqual(study.strategic_key(state), study.strategic_key(changed))
        changed["decks"]["germany"]["hand"] = [c for c in changed["decks"][
            "germany"]["hand"] if c["definitionId"] != "special_136"]
        self.assertNotEqual(study.strategic_key(state), study.strategic_key(changed))

    def test_route_control_and_ambiguous_future_value_are_not_strong_keep(self):
        with gzip.open(study.BASE / "course-pool-v8.json.gz", "rt",
                       encoding="utf-8") as stream:
            entries = json.load(stream)["entries"]
        example = next(e for e in entries if e["template"] == "U4" and
                       e["variant"] == "control" and e["layer"] == "preparation")
        # Same legal first-turn American shipyard opportunity as the positive
        # route, irrespective of which action its guide later selected.
        self.assertEqual(example["controlRole"], "route_comparison")
        self.assertEqual(example["snapshot"]["state"]["round"], 1)
        self.assertEqual(study.classify_retention({"node": "SOURCE",
            "decisionSeat": "united_states", "candidates": [
                {"definitionId": "special_84"}]}, example["snapshot"]["state"])[0],
            "teaching")

    def test_near_duplicate_training_scene_cannot_be_held_out(self):
        with gzip.open(study.BASE / "course-pool-v8.json.gz", "rt",
                       encoding="utf-8") as stream:
            entry = next(e for e in json.load(stream)["entries"] if e[
                "template"] == "U4" and e["layer"] == "preparation")
        other = copy.deepcopy(entry)
        other["split"], other["seed"] = "final_test", entry["seed"] + 500
        other["snapshot"]["state"]["decks"]["germany"]["hand"].reverse()
        chosen, excluded = study.exclude_near_split_overlap([{**entry, "split": "train"},
                                                                other])
        self.assertEqual(len(chosen), 1)
        self.assertEqual(excluded[0]["split"], "final_test")


class ArenaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)
        cls.client = ppo.ArenaClient(card_set="signals")
        cls.encoder = ppo.Encoder(cls.client.schema)
        cls.baseline, cls.before, _ = study.open_models(cls.encoder)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def test_actual_legal_preparation_and_payoff_are_separate_labels(self):
        with gzip.open(study.BASE / "course-pool-v8.json.gz", "rt",
                       encoding="utf-8") as stream:
            entries = json.load(stream)["entries"]
        selected = [next(e for e in entries if e["template"] == key and
                    e["variant"] == "positive" and e["layer"] == layer and
                    e["split"] == "train") for key in study.TARGETS
                    for layer in ("preparation", "payoff")]
        prep, payoff, evidence = study._samples_for_split(self.client,
            self.encoder, self.baseline, selected, "train")
        self.assertEqual(set(evidence["preparationByTemplate"]), set(study.TARGETS))
        self.assertTrue(all(s["metadata"]["labelType"] == "verified_preparation"
                            for s in prep))
        self.assertTrue(all(s["metadata"]["labelType"] == "verified_payoff_choice"
                            for s in payoff))
        self.assertTrue(all(0 <= item["chosen"] < len(item["candidates"])
                            for item in prep + payoff))
        self.assertEqual(bc.validate_supervision(prep + payoff, [])["routeOverlap"], 0)
        self.assertTrue(all(not ({"oldLogProb", "reward", "return", "advantage"} &
                             set(item)) for item in prep + payoff))

    def test_bounded_rollback_keeps_source_unchanged(self):
        with gzip.open(study.BASE / "course-pool-v8.json.gz", "rt",
                       encoding="utf-8") as stream:
            entries = json.load(stream)["entries"]
        chosen = [next(e for e in entries if e["template"] == key and
                  e["variant"] == "positive" and e["layer"] == "payoff" and
                  e["split"] == "train") for key in study.TARGETS]
        prep, payoff, _ = study._samples_for_split(self.client, self.encoder,
            self.baseline, chosen, "train")
        plan = json.loads(study.PLAN.read_text(encoding="utf-8"))
        controls, _ = study._preservation_scenes(self.client, self.encoder,
            self.baseline, plan)
        parent_sha = study.digest(study.BASE / "initial.pt")
        config = {**plan["learning"], "maxSteps": 2, "checkEverySteps": 1,
                  "maxKl": 0, "maxValueShift": 0}
        selected, result = study.learn_bounded(self.baseline, prep, payoff, prep,
            payoff, controls, config)
        self.assertIsNone(result["selectedStep"])
        self.assertEqual(study.digest(study.BASE / "initial.pt"), parent_sha)
        self.assertEqual(ppo.model_weights_sha256(selected),
                         ppo.model_weights_sha256(self.baseline))

    def test_original_model_and_unrelated_country_retention(self):
        plan = json.loads(study.PLAN.read_text(encoding="utf-8"))
        controls, notes = study._preservation_scenes(self.client, self.encoder,
            self.baseline, plan)
        self.assertTrue(controls)
        self.assertTrue(all(note["seat"] in ("united_kingdom", "italy",
                                             "soviet_union") for note in notes))
        self.assertLess(study._retention(self.baseline, controls)["maxKl"], 1e-6)


if __name__ == "__main__":
    unittest.main()
