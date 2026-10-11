import unittest

import torch

from scripts.ppo_auto_imitate import auxiliary_update


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
        self.demonstrations = [{"observation": self.observation,
                                "actionId": "target", "routeId": "reviewed"}]

    def test_empty_library_does_not_touch_model(self):
        before = self.model.policy.detach().clone()
        result = auxiliary_update(self.model, self.encoder, [],
                                  [self.observation], torch.device("cpu"))
        self.assertEqual(result["status"], "empty_library")
        self.assertTrue(torch.equal(before, self.model.policy))

    def test_sentinel_rejects_and_rolls_back_both_steps(self):
        before = {name: parameter.detach().clone()
                  for name, parameter in self.model.named_parameters()}
        result = auxiliary_update(self.model, self.encoder,
            self.demonstrations, [self.observation], torch.device("cpu"),
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
            self.demonstrations, [self.observation], torch.device("cpu"),
            config={"sentinelKlLimit": 1.0, "maxMinibatches": 1,
                    "learningRate": 0.01}, seed=3)
        self.assertEqual(result["status"], "complete")
        self.assertTrue(result["metrics"][0]["accepted"])
        self.assertGreater(float(self.model.policy.detach()), original)
        self.assertEqual(float(self.model.value.detach()), 0.5)


if __name__ == "__main__":
    unittest.main()
