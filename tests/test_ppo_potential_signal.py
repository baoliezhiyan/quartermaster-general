import copy
import hashlib
import unittest

import torch

from scripts import ppo_train as ppo
from scripts.ppo_auto_semantic_migrate import LegacyEncoder
from scripts.ppo_network_factory import (A2S1_ADAPTER, make_network,
    migrate_signal_potential, migrate_scoped_signal)


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
        changed = copy.deepcopy(rapid)
        changed['potential']['effectScopes'][0]['targetMode'] = 'unknown'
        self.assertNotEqual(encoded,
                            self.encoder.encode_candidate(observation, changed))
        changed = copy.deepcopy(rapid)
        changed['potential']['effectScopes'][0]['sourceMode'] = 'fixed'
        changed['potential']['effectScopes'][0]['sourceRegions'] = ['germany']
        self.assertNotEqual(encoded,
                            self.encoder.encode_candidate(observation, changed))

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

    def test_audited_parent_rejected_when_opening_gate_used_old_semantics(self):
        path = ppo.ROOT / 'PPO训练/.state/A2AUTO2SEM/initial.pt'
        if not path.exists():
            self.skipTest('Historical weight artifact is not part of Git')
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),
            '4815e4118e430426a5cd0b5bee3d9a4adbcf497ee86bdb7c124b3e74527ca41c')
        parent = torch.load(path, map_location='cpu', weights_only=False)
        self.assertEqual(parent['encoderVersion'], 'ppo-vector-a2s1-v5-audited-potential')
        self.assertEqual(parent['weightsSha256'],
            '754b2b45e1187df096e6a6b0744c8a0858ade01ba033ecc6c688821a8e730088')
        self.assertEqual(parent['resourceMode'], 'A')
        core = parent['semanticMigration']['unchangedCoreDim']
        old_dim = parent['network']['candidateDim']
        for name in ('map.base.candidate_net.0.weight', 'prototype_candidate'):
            self.assertEqual(torch.count_nonzero(parent['modelState'][name][..., core:]).item(), 0)
        self.assertGreater(torch.count_nonzero(parent['modelState']['opening_logit']).item(), 0)
        with self.assertRaisesRegex(ValueError, 'Opening gate used obsolete'):
            migrate_scoped_signal(parent, self.encoder)

    def test_neutral_audited_candidate_can_migrate_exactly(self):
        observation = self.client.request(op='reset', seed=3, mode='A',
                                           cardSet='signals')['observation']
        old_dim = 18065
        core = 17784
        old_encoder = copy.copy(self.encoder)
        old_encoder.candidate_dim = old_dim
        original = make_network(A2S1_ADAPTER, old_encoder)
        with torch.no_grad():
            original.map.base.candidate_net[0].weight[:, core:] = 0
            original.prototype_candidate[core:] = 0
            original.opening_logit.zero_()
        source = {'encoderVersion': 'ppo-vector-a2s1-v5-audited-potential',
            'mode': 'A', 'cardSet': 'signals', 'networkArchitecture': A2S1_ADAPTER,
            'network': {'stateDim': self.encoder.state_dim, 'candidateDim': old_dim},
            'semanticMigration': {'unchangedCoreDim': core},
            'modelState': original.state_dict()}
        migrated = migrate_scoped_signal(source, self.encoder)
        for seed in (3, 17):
            observation = self.client.request(op='reset', seed=seed, mode='A',
                                               cardSet='signals')['observation']
            state, candidates = self.encoder.encode(observation)
            with torch.inference_mode():
                old_logits, old_value = original(*ppo.batch_tensors([{
                    'state': state, 'candidates': candidates[:, :old_dim]}],
                    torch.device('cpu')))
                new_logits, new_value = migrated(*ppo.batch_tensors([{
                    'state': state, 'candidates': candidates}], torch.device('cpu')))
            torch.testing.assert_close(new_logits, old_logits, atol=1e-6, rtol=0)
            torch.testing.assert_close(new_value, old_value, atol=1e-6, rtol=0)


if __name__ == "__main__":
    unittest.main()
