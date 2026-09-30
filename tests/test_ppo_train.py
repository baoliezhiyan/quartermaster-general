import math
import random
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import torch

from scripts.ppo_train import (Encoder, PpoNetwork, assign_advantages, batch_tensors,
                               checkpoint_payload, potential, ppo_update, restore_checkpoint,
                               shaped_reward)


class PpoMathTests(unittest.TestCase):
    def test_terminal_potential_telescopes(self):
        scores = [{"axis": 9, "allies": 13}, {"axis": 12, "allies": 13},
                  {"axis": 14, "allies": 10}, {"axis": 18, "allies": 15}]
        for side in ("axis", "allies"):
            rewards = [shaped_reward(scores[i], scores[i + 1], side,
                                     i == 2, "axis") for i in range(3)]
            expected = (1 if side == "axis" else -1) - potential(9, 13, side)
            self.assertAlmostEqual(sum(rewards), expected)
            self.assertAlmostEqual(shaped_reward(scores[0], scores[0], side), 0)

    def test_elapsed_turns_and_intervening_seats(self):
        samples = [{"seat": seat, "value": value} for seat, value in
                   [("germany", .1), ("united_kingdom", -.2), ("germany", .3),
                    ("italy", -.1)]]
        rewards = [{"axis": a, "allies": -a} for a in (.2, .3, -.1, .4)]
        assign_advantages(samples, rewards, [0, 1, 5, 6])
        # Germany's first interval includes the UK's intervening decision and advances one turn.
        later = -.1 + .4 - .3
        self.assertAlmostEqual(samples[2]["advantage"], later)
        self.assertAlmostEqual(samples[0]["advantage"], .2 + .3 + .3 - .1 + .95 ** (1 / 6) * later)
        self.assertAlmostEqual(samples[0]["actualReturn"], .8)
        self.assertAlmostEqual(samples[0]["target"], .1 + samples[0]["advantage"])

    def test_lambda_uses_game_turns_not_decision_count(self):
        for delta_t in (0, 1, 6):
            samples = [{"seat": "germany", "value": 0.0},
                       {"seat": "germany", "value": 0.0}]
            assign_advantages(samples, [{"axis": 0, "allies": 0},
                                        {"axis": 1, "allies": -1}], [delta_t, 0])
            self.assertAlmostEqual(samples[0]["advantage"], .95 ** (delta_t / 6))
            self.assertAlmostEqual(samples[0]["actualReturn"], 1)

    def test_mask_and_update(self):
        torch.manual_seed(3)
        network = PpoNetwork(5, 4)
        item = {"seat": "germany", "state": torch.randn(5),
                "candidates": torch.randn(2, 4), "action": 0,
                "advantage": 1.0, "target": 0.5, "value": 0.0,
                "baseline": False}
        states, candidates, mask = batch_tensors([item, {**item, "candidates": torch.randn(3, 4)}], "cpu")
        logits, _ = network(states, candidates, mask)
        self.assertEqual(float(torch.softmax(logits.detach(), -1)[0, 2]), 0.0)
        with torch.no_grad():
            old, _ = network(*batch_tensors([item], "cpu"))
            item["logprob"] = float(torch.log_softmax(old, -1)[0, 0])
            original_probability = float(torch.softmax(old, -1)[0, 0])
        optimizer = torch.optim.Adam(network.parameters(), lr=3e-4)
        metrics = ppo_update(network, optimizer, [item, {**item, "advantage": -1.0,
                                                        "action": 1, "target": -0.5,
                                                        "logprob": float(torch.log_softmax(old, -1)[0, 1])}],
                             "cpu", random.Random(1), epochs=2, minibatch=2)
        self.assertTrue(math.isfinite(metrics["loss"]))
        self.assertEqual(metrics["samples"], 2)
        with torch.no_grad():
            changed, _ = network(*batch_tensors([item], "cpu"))
            self.assertGreater(float(torch.softmax(changed, -1)[0, 0]), original_probability)

    def test_checkpoint_restores_identical_outputs_and_rejects_build_change(self):
        torch.manual_seed(4)
        model = PpoNetwork(5, 4)
        optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
        encoder = SimpleNamespace(state_dim=5, candidate_dim=4)
        client = SimpleNamespace(fingerprint="a" * 64, schema={
            "observationSchemaVersion": "one", "actionSchemaVersion": "two",
            "eventIds": ["special_1"]})
        rng = random.Random(9)
        sample = {"state": torch.randn(5), "candidates": torch.randn(2, 4)}
        with torch.no_grad():
            before = model(*batch_tensors([sample], "cpu"))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.pt"
            torch.save(checkpoint_payload(model, optimizer, encoder, client, "A", 1, 100,
                                          rng, 10, completed_episodes=40, training_seed=9), path)
            restored = PpoNetwork(5, 4)
            restored_optimizer = torch.optim.Adam(restored.parameters(), lr=3e-4)
            saved = restore_checkpoint(path, restored, restored_optimizer, encoder,
                                       client, "A", random.Random())
            self.assertEqual(saved["completedDecisions"], 100)
            self.assertEqual(saved["completedEpisodes"], 40)
            with torch.no_grad():
                after = restored(*batch_tensors([sample], "cpu"))
            for original, loaded in zip(before, after):
                self.assertTrue(torch.equal(original, loaded))
            client.fingerprint = "b" * 64
            with self.assertRaises(ValueError):
                restore_checkpoint(path, restored, restored_optimizer, encoder,
                                   client, "A", random.Random())
            client.fingerprint = "a" * 64
            with self.assertRaisesRegex(ValueError, "training seed"):
                restore_checkpoint(path, restored, restored_optimizer, encoder,
                                   client, "A", random.Random(), training_seed=10)
            for key, mutation in [
                    ("rewardConfig", {"gamma": 0.9, "lambdaRound": 0.5, "potential": 100}),
                    ("optimizerConfig", {"lr": 0.01}),
                    ("trainerVersion", None),
                    ("encoderDictionarySha256", "0" * 64),
                    ("cardSet", "basics")]:
                damaged = checkpoint_payload(model, optimizer, encoder, client, "A", 1, 100,
                                             rng, 10, completed_episodes=40, training_seed=9)
                if mutation is None:
                    del damaged[key]
                else:
                    damaged[key] = mutation
                torch.save(damaged, path)
                with self.assertRaises(ValueError, msg=key):
                    restore_checkpoint(path, restored, restored_optimizer, encoder,
                                       client, "A", random.Random())
            damaged = checkpoint_payload(model, optimizer, encoder, client, "A", 1, 100,
                                         rng, 10, completed_episodes=39, training_seed=9)
            torch.save(damaged, path)
            with self.assertRaisesRegex(ValueError, "complete-episode count"):
                restore_checkpoint(path, restored, restored_optimizer, encoder,
                                   client, "A", random.Random())


if __name__ == "__main__":
    unittest.main()
