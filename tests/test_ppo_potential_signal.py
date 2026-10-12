import copy
import unittest

import torch

from scripts import ppo_train as ppo
from scripts.ppo_auto_semantic_migrate import LegacyEncoder
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network, migrate_signal_potential


class PotentialSignalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = ppo.ArenaClient(card_set="signals")
        cls.encoder = ppo.Encoder(cls.client.schema)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def test_real_status_install_has_separate_future_semantics_in_tensor(self):
        observation = self.client.request(op="reset", seed=1, mode="A",
                                          cardSet="signals")["observation"]
        rapid = next(item for item in observation["candidates"] if
                     item.get("definitionId") == "special_137")
        self.assertEqual(rapid["potential"]["useLimit"], "turn")
        suffix_width = len(self.encoder._potential_vector(None))
        encoded = self.encoder.encode_candidate(observation, rapid)
        hidden = copy.deepcopy(rapid)
        hidden.pop("potential")
        old = self.encoder.encode_candidate(observation, hidden)
        self.assertEqual(encoded[:-suffix_width], old[:-suffix_width])
        self.assertNotEqual(encoded[-suffix_width:], old[-suffix_width:])
        self.assertTrue(any(encoded[-suffix_width:]))

    def test_zero_extension_preserves_old_logits_and_value(self):
        observation = self.client.request(op="reset", seed=2, mode="A",
                                          cardSet="signals")["observation"]
        legacy_encoder = LegacyEncoder(self.client.schema)
        old = make_network(A2S1_ADAPTER, legacy_encoder)
        saved = {"mode": "A", "cardSet": "signals",
                 "networkArchitecture": A2S1_ADAPTER,
                 "network": {"stateDim": legacy_encoder.state_dim,
                             "candidateDim": legacy_encoder.candidate_dim},
                 "modelState": old.state_dict()}
        migrated = migrate_signal_potential(saved, self.encoder)
        old_state, old_candidates = legacy_encoder.encode(observation)
        state, candidates = self.encoder.encode(observation)
        self.assertTrue(torch.equal(old_candidates,
                                    candidates[:, :legacy_encoder.candidate_dim]))
        with torch.inference_mode():
            old_logits, old_value = old(*ppo.batch_tensors([{"state": old_state,
                "candidates": old_candidates}], torch.device("cpu")))
            new_logits, new_value = migrated(*ppo.batch_tensors([{"state": state,
                "candidates": candidates}], torch.device("cpu")))
        torch.testing.assert_close(new_logits, old_logits, atol=1e-5, rtol=1e-5)
        torch.testing.assert_close(new_value, old_value, atol=1e-5, rtol=1e-5)


if __name__ == "__main__":
    unittest.main()
