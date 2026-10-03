import unittest

import torch

from scripts.ppo_map_network import PpoMapNetwork, migrate_flat
from scripts.ppo_train import ArenaClient, Encoder, PpoNetwork, batch_tensors


class MapNetworkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = ArenaClient()
        cls.encoder = Encoder(cls.client.schema)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def test_region_network_migrates_flat_policy_and_masks_padding(self):
        obs = self.client.request(op="reset", seed=871, mode="A", cardSet="events")["observation"]
        state, choices = self.encoder.encode(obs)
        flat = PpoNetwork(self.encoder.state_dim, self.encoder.candidate_dim)
        mapped = migrate_flat(flat, PpoMapNetwork(self.encoder))
        one = batch_tensors([{"state": state, "candidates": choices}], torch.device("cpu"))
        with torch.no_grad():
            old_logits, old_value = flat(*one)
            new_logits, new_value = mapped(*one)
        self.assertTrue(torch.equal(old_logits, new_logits))
        self.assertTrue(torch.equal(old_value, new_value))
        fewer = choices[:2]
        batch = batch_tensors([{"state": state, "candidates": choices},
                               {"state": state, "candidates": fewer}], torch.device("cpu"))
        with torch.no_grad():
            logits, values = mapped(*batch)
        self.assertEqual(tuple(logits.shape), (2, len(choices)))
        self.assertTrue(torch.all(logits[1, 2:] < -1e8))
        self.assertEqual(len(values), 2)

    def test_map_context_has_target_and_ordered_action_slots(self):
        obs = self.client.request(op="reset", seed=872, mode="A", cardSet="events")["observation"]
        event = next(c for c in obs["candidates"] if c.get("definitionId") == "special_150")
        facts = self.encoder._action_semantics(obs, event)
        self.assertGreater(sum(abs(x) for x in facts), 0)
        model = PpoMapNetwork(self.encoder)
        self.assertEqual(model.region_count, len(self.client.schema["regions"]))
        self.assertGreater(sum(p.numel() for p in model.parameters()),
                           sum(p.numel() for p in model.base.parameters()))


if __name__ == "__main__":
    unittest.main()
