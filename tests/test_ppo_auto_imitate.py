import unittest

import torch

from scripts.ppo_auto_imitate import auxiliary_update
from scripts.ppo_auto_archive import digest


class Encoder:
    def encode(self, observation):
        return (torch.tensor([1.0]),
                torch.tensor([[1.0], [-1.0]]))


class Model(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.policy = torch.nn.Parameter(torch.tensor(0.0))
        self.value = torch.nn.Parameter(torch.tensor(0.5))

    def forward(self, states, candidates, mask):
        logits = candidates[:, :, 0] * self.policy
        return logits.masked_fill(~mask, -1e9), self.value.expand(len(states))


class ImitationTests(unittest.TestCase):
    def setUp(self):
        self.model = Model()
        self.encoder = Encoder()
        self.observation = {"candidates": [{"id": "target"}, {"id": "other"}]}
        self.heldout = {"candidates": [{"id": "heldout-a"}, {"id": "heldout-b"}]}
        self.demonstrations = [{"observation": self.observation,
                                "candidateHash": digest(self.observation["candidates"]),
                                "actionId": "target", "routeId": "reviewed"}]

    def test_empty_library_does_not_touch_model(self):
        before = self.model.policy.detach().clone()
        result = auxiliary_update(self.model, self.encoder, [],
                                  [self.heldout], torch.device("cpu"))
        self.assertEqual(result["status"], "empty_library")
        self.assertTrue(torch.equal(before, self.model.policy))

    def test_sentinel_rejects_and_rolls_back_both_steps(self):
        before = {name: parameter.detach().clone()
                  for name, parameter in self.model.named_parameters()}
        result = auxiliary_update(self.model, self.encoder,
            self.demonstrations, [self.heldout], torch.device("cpu"),
            config={"sentinelKlLimit": 0.0, "maxMinibatches": 2,
                    "learningRate": 0.5}, seed=3)
        self.assertEqual(result["status"], "paused_after_rollbacks")
        self.assertEqual(result["minibatches"], 2)
        self.assertTrue(all(not row["accepted"] for row in result["metrics"]))
        for name, parameter in self.model.named_parameters():
            self.assertTrue(torch.equal(before[name], parameter))

    def test_valid_auxiliary_label_changes_policy_without_value_target(self):
        original = float(self.model.policy.detach())
        result = auxiliary_update(self.model, self.encoder,
            self.demonstrations, [self.heldout], torch.device("cpu"),
            config={"sentinelKlLimit": 1.0, "maxMinibatches": 1,
                    "learningRate": 0.01}, seed=3)
        self.assertEqual(result["status"], "complete")
        self.assertTrue(result["metrics"][0]["accepted"])
        self.assertGreater(float(self.model.policy.detach()), original)
        self.assertEqual(float(self.model.value.detach()), 0.5)

    def test_pause_survives_separate_auxiliary_calls(self):
        config = {"sentinelKlLimit": 0.0, "maxMinibatches": 1,
                  "learningRate": 0.5, "maxConsecutiveRollbacks": 2}
        first = auxiliary_update(self.model, self.encoder, self.demonstrations,
            [self.heldout], torch.device("cpu"), config=config)
        self.assertEqual(first["pauseState"]["consecutiveRollbacks"], 1)
        second = auxiliary_update(self.model, self.encoder, self.demonstrations,
            [self.heldout], torch.device("cpu"), config=config,
            optimizer_state=first["optimizerState"], pause_state=first["pauseState"])
        self.assertTrue(second["pauseState"]["paused"])
        third = auxiliary_update(self.model, self.encoder, self.demonstrations,
            [self.heldout], torch.device("cpu"), config=config,
            optimizer_state=second["optimizerState"], pause_state=second["pauseState"])
        self.assertEqual(third["status"], "paused_persistently")
        self.assertEqual(third["minibatches"], 0)

    def test_training_observation_cannot_be_its_own_holdout(self):
        with self.assertRaisesRegex(ValueError, "overlaps"):
            auxiliary_update(self.model, self.encoder, self.demonstrations,
                [self.observation], torch.device("cpu"))

    def test_independent_behavior_regression_rolls_back_model_and_optimizer(self):
        original = self.model.policy.detach().clone()
        def check(model):
            return {"cases": 2, "invalidEvents": 0,
                    "successfulSignalEvents": 2 if float(model.policy.detach()) == 0 else 0,
                    "usefulActions": 4}
        result = auxiliary_update(self.model, self.encoder, self.demonstrations,
            [self.heldout], torch.device("cpu"), behavior_check=check,
            config={"maxMinibatches": 1, "sentinelKlLimit": 1.0,
                    "learningRate": 0.01})
        self.assertEqual(result["metrics"][0]["reason"], "signal_completion_regressed")
        self.assertFalse(result["metrics"][0]["accepted"])
        self.assertTrue(torch.equal(self.model.policy, original))
        self.assertIsNotNone(result["optimizerState"])

    def test_unverified_behavior_leaves_model_and_grad_flags_unchanged(self):
        before = {name: parameter.detach().clone()
                  for name, parameter in self.model.named_parameters()}
        result = auxiliary_update(self.model, self.encoder, self.demonstrations,
            [self.heldout], torch.device("cpu"), behavior_check=lambda _: None)
        self.assertEqual(result["status"], "behavior_unverified")
        self.assertEqual(result["minibatches"], 0)
        for name, parameter in self.model.named_parameters():
            self.assertTrue(parameter.requires_grad)
            self.assertTrue(torch.equal(parameter, before[name]))


if __name__ == "__main__":
    unittest.main()
