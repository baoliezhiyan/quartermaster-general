import unittest
import copy
import random

import torch

from scripts.ppo_map_network import PpoMapNetwork, migrate_flat
from scripts.ppo_train import ArenaClient, Encoder, PpoNetwork, batch_tensors, ppo_update


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

    def test_actor_target_order_is_not_pooled_away(self):
        obs = self.client.request(op="reset", seed=873, mode="A", cardSet="events")["observation"]
        effects = [{"kind": "action", "action": "build_army", "country": "germany",
                    "regions": ["eastern_europe"]},
                   {"kind": "action", "action": "build_navy", "country": "italy",
                    "regions": ["sea_mediterranean"]}]
        first = {"id": "synthetic-a", "kind": "source", "definitionId": "special_150",
                 "effects": effects}
        reversed_actions = {**first, "id": "synthetic-b", "effects": list(reversed(effects))}
        exchanged_actors = copy.deepcopy(first)
        exchanged_actors["effects"][0]["country"] = "italy"
        exchanged_actors["effects"][1]["country"] = "germany"
        vectors = [self.encoder.encode_candidate(obs, option) for option in
                   (first, reversed_actions, exchanged_actors)]
        self.assertNotEqual(vectors[0], vectors[1])
        self.assertNotEqual(vectors[0], vectors[2])
        state = self.encoder.encode_state(obs)
        model = PpoMapNetwork(self.encoder)
        with torch.no_grad():
            model.map_policy[-1].weight.fill_(0.01)
        batch = batch_tensors([{"state": torch.tensor(state),
                               "candidates": torch.tensor(vectors)}], torch.device("cpu"))
        with torch.no_grad():
            logits, _ = model(*batch)
        self.assertNotEqual(float(logits[0, 0]), float(logits[0, 1]))
        self.assertNotEqual(float(logits[0, 0]), float(logits[0, 2]))

    def test_multiple_direct_targets_retain_order_in_map_branch(self):
        obs = self.client.request(op="reset", seed=874, mode="A", cardSet="events")["observation"]
        one = {"id": "ordered-a", "kind": "targets",
               "targetIds": ["eastern_europe", "ukraine"]}
        two = {"id": "ordered-b", "kind": "targets",
               "targetIds": ["ukraine", "eastern_europe"]}
        state = torch.tensor(self.encoder.encode_state(obs))
        choices = torch.tensor([self.encoder.encode_candidate(obs, c) for c in (one, two)])
        model = PpoMapNetwork(self.encoder)
        with torch.no_grad():
            model.map_policy[-1].weight.fill_(.01)
            logits, _ = model(*batch_tensors([{"state": state, "candidates": choices}],
                                             torch.device("cpu")))
        self.assertNotEqual(float(logits[0, 0]), float(logits[0, 1]))

    def test_map_gradient_accumulation_keeps_effective_minibatch(self):
        obs = self.client.request(op="reset", seed=875, mode="A", cardSet="events")["observation"]
        state, choices = self.encoder.encode(obs)
        samples = [{"seat": "germany", "state": state, "candidates": choices[:count],
                    "action": 0, "logprob": -1.0, "value": 0.0,
                    "advantage": .1 * (i - 2), "target": .02 * i, "baseline": False}
                   for i, count in enumerate((2, 4, 3, 5, 2))]
        torch.manual_seed(875)
        full = PpoMapNetwork(self.encoder)
        pieces = copy.deepcopy(full)
        full_optimizer = torch.optim.Adam(full.parameters(), lr=3e-4)
        pieces_optimizer = torch.optim.Adam(pieces.parameters(), lr=3e-4)
        before = ppo_update(full, full_optimizer, samples, torch.device("cpu"),
                            random.Random(875), epochs=1, minibatch=4)
        after = ppo_update(pieces, pieces_optimizer, samples, torch.device("cpu"),
                           random.Random(875), epochs=1, minibatch=4,
                           gradient_microbatch=2)
        for key in before:
            self.assertAlmostEqual(before[key], after[key], delta=1e-5, msg=key)
        for key, tensor in full.state_dict().items():
            if key in ("base.policy.2.bias", "map_policy.2.bias"):
                continue  # Common logit shifts do not change the policy.
            self.assertTrue(torch.allclose(tensor, pieces.state_dict()[key], atol=1e-4),
                            (key, float((tensor - pieces.state_dict()[key]).abs().max())))


if __name__ == "__main__":
    unittest.main()
