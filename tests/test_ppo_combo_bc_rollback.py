"""Bounded BC candidate selection and migration publication guards."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

from scripts import ppo_combo_bc as bc
from scripts import ppo_combo_v2_prepare as prepare
from scripts import ppo_combo_v2_rounds as rounds


class Toy(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.weight = torch.nn.Parameter(torch.tensor(0.0))


class FixedStep:
    def __init__(self, parameters, lr):
        self.parameter = list(parameters)[0]
        self.steps = 0

    def zero_grad(self, set_to_none=True):
        self.parameter.grad = None

    def step(self):
        self.steps += 1
        with torch.no_grad():
            self.parameter.fill_(float("nan") if getattr(self, "nan_step", None) ==
                                 self.steps else self.steps)


def forward(model, item):
    return torch.stack((model.weight, -model.weight)), model.weight


def metrics(model, *, losses, limit_step=99):
    number = int(float(model.weight.detach()))
    return {"meanTrainingNll": losses[number],
            "meanPositiveProbability": float(number + 1),
            "maxControlKl": 0.3 if number >= limit_step else number * .04,
            "maxControlValueShift": number * .01,
            "positive": [{"probability": 0.1, "rank": 1}],
            "controlCardProbabilities": []}


class RollbackTests(unittest.TestCase):
    def _adapt(self, losses, *, limit_step=99, nan_step=None, steps=4):
        model = Toy()
        labels = [{"state": torch.zeros(1), "candidates": torch.zeros(2, 1),
                   "chosen": 0, "metadata": {"courseId": "G1:test", "cardId": "special_136"}}]
        controls = []
        FixedStep.nan_step = nan_step
        with patch.object(bc, "_forward", forward), patch.object(bc, "assess",
                side_effect=lambda m, l, c: metrics(m, losses=losses,
                                                     limit_step=limit_step)), patch.object(
                bc.torch.optim, "Adam", FixedStep):
            result = bc.adapt(model, labels, controls, config={"maxSteps": steps,
                "maxControlKl": .2})
        FixedStep.nan_step = None
        return model, result

    def test_early_compliant_candidate_restored_after_limit(self):
        model, result = self._adapt([10, 8, 7, 6], limit_step=3)
        self.assertEqual((result["stopReason"], result["stopStep"]),
                         ("control_drift_limit", 3))
        self.assertEqual(result["selectedStep"], 2)
        self.assertEqual(float(model.weight.detach()), 2)
        self.assertTrue(result["rolledBack"])
        self.assertFalse(result["history"][-1]["eligible"])

    def test_last_compliant_step_need_not_be_best(self):
        model, result = self._adapt([10, 3, 2, 4, 1], limit_step=4)
        self.assertEqual(result["selectedStep"], 2)
        self.assertEqual(float(model.weight.detach()), 2)

    def test_no_compliant_update_restores_parent(self):
        model, result = self._adapt([10, 1], limit_step=1, steps=1)
        self.assertIsNone(result["selectedStep"])
        self.assertFalse(result["accepted"])
        self.assertEqual(float(model.weight.detach()), 0)
        self.assertFalse(prepare.independent_acceptance(result,
            {"accepted": True}, [], 0, True, {"allSixSeatsCovered": True})["accepted"])

    def test_nan_step_restores_independent_snapshot(self):
        model, result = self._adapt([10, 2, 1], nan_step=2, steps=3)
        self.assertEqual(result["stopReason"], "nonfinite_parameter")
        self.assertEqual(result["selectedStep"], 1)
        self.assertEqual(float(model.weight.detach()), 1)

    def test_nonfinite_metric_restores_previous_step(self):
        model, result = self._adapt([10, 2, float("inf")], steps=3)
        self.assertEqual(result["stopReason"], "nonfinite_metric")
        self.assertEqual(result["selectedStep"], 1)
        self.assertEqual(float(model.weight.detach()), 1)

    def test_weight_snapshot_is_not_a_live_state_dict_reference(self):
        model = Toy()
        snapshot = bc._weights(model)
        with torch.no_grad():
            model.weight.fill_(4)
        self.assertEqual(float(snapshot["weight"]), 0)

    def test_holdout_does_not_choose_training_step(self):
        model, result = self._adapt([10, 3, 2, 4], steps=3)
        self.assertEqual(result["selectedStep"], 2)
        self.assertEqual(result["selectionRule"],
                         "minimum_training_nll_then_kl_then_earlier_step")

    def test_atomic_save_reload_and_missing_initializer_guard(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "candidate.pt"
            parent = Path(root) / "parent.pt"
            torch.save({"modelState": Toy().state_dict()}, parent)
            digest = prepare.sha(parent)
            prepare._save_new(path, {"modelState": Toy().state_dict()})
            reloaded = torch.load(path, weights_only=False)
            self.assertTrue(torch.equal(reloaded["modelState"]["weight"],
                                        Toy().state_dict()["weight"]))
            self.assertEqual(prepare.sha(parent), digest)
            with self.assertRaises(FileExistsError):
                prepare._save_new(path, {})
            audit_only = Path(root) / "demonstration-audit.json"
            prepare._write_json_new(audit_only, {"independentAcceptance":
                                                   {"accepted": True}})
            self.assertTrue(audit_only.exists())
            with self.assertRaises(FileExistsError):
                prepare._write_json_new(audit_only, {})
            with patch.object(rounds, "INITIAL", Path(root) / "initial.pt"):
                with self.assertRaises(SystemExit):
                    rounds.identity()

    def test_failed_independent_gate_cannot_publish(self):
        adaptation = {"accepted": True, "selectedStep": 2}
        rejected = prepare.independent_acceptance(adaptation,
            {"accepted": False}, [], 0, True, {"allSixSeatsCovered": True})
        self.assertFalse(rejected["accepted"])
        self.assertIn("nine_teaching_targets_not_covered", rejected["reasons"])
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ValueError, "cannot publish"):
                prepare._save_accepted_initial(Path(root), {}, rejected)
            self.assertFalse((Path(root) / "initial.pt").exists())


if __name__ == "__main__":
    unittest.main()
