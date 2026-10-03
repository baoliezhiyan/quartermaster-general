"""Short A1S2 identity and auxiliary tests; no 40-game PPO update."""
import random
import tempfile
import unittest
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts import ppo_a1s2_train as active
from scripts import ppo_auxiliary
from scripts.ppo_network_factory import ADAPTED_MAP, MAP, make_network


class A1S2Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = ppo.ArenaClient()
        cls.encoder = ppo.Encoder(cls.client.schema)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def test_historical_identity_and_fresh_initial(self):
        initial, aux = active.read_initial()
        self.assertEqual(active.progress(initial), 0)
        self.assertEqual(initial["parent"]["historicalExperimentId"], "S2MAP")
        self.assertEqual(initial["optimizerInitialization"], "new-Adam-no-S2MAP-momentum")
        model = make_network(ADAPTED_MAP, self.encoder)
        model.load_state_dict(initial["modelState"])
        self.assertEqual(ppo.model_weights_sha256(model), initial["weightsSha256"])
        self.assertEqual(aux["datasetSha256"], initial["auxiliaryDataSha256"])
        self.assertIsNone(active.train(1, dry_run=True))

    def test_historical_s2map_checkpoint_loads_only_under_historical_identity(self):
        historical = active.ROOT / ".state" / "A1S2" / "latest.pt"
        old_initial = torch.load(active.ROOT / ".state" / "stage2" / "A1S2-initial.pt",
                                 map_location="cpu", weights_only=False)
        model = make_network(MAP, self.encoder)
        optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
        saved = ppo.restore_checkpoint(historical, model, optimizer, self.encoder,
            self.client, "A", random.Random(), "events", training_seed=active.SEED,
            experiment_id="S2MAP", entropy_coefficient=.01,
            initial_weights_sha256=old_initial["weightsSha256"], architecture=MAP)
        self.assertEqual(saved["update"], 20)
        self.assertEqual(saved["experimentId"], "S2MAP")
        with self.assertRaises(ValueError):
            ppo.restore_checkpoint(historical, model, optimizer, self.encoder,
                self.client, "A", random.Random(), "events", training_seed=active.SEED,
                experiment_id="A1S2", entropy_coefficient=.01,
                initial_weights_sha256=old_initial["weightsSha256"], architecture=MAP)

    def test_config_and_checkpoint_do_not_cross_experiments(self):
        initial, aux = active.read_initial()
        model = make_network(ADAPTED_MAP, self.encoder)
        model.load_state_dict(initial["modelState"])
        optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
        saved = ppo.checkpoint_payload(model, optimizer, self.encoder, self.client,
            "A", 0, 0, random.Random(3), active.SEED,
            training_seed=active.SEED, experiment_id="A1S2",
            entropy_coefficient=.01, initial_weights_sha256=initial["weightsSha256"],
            architecture=ADAPTED_MAP, auxiliary_config=aux)
        self.assertEqual(saved["auxiliaryConfig"], aux)
        self.assertNotEqual(saved["experimentConfigSha256"],
            ppo.experiment_config_sha256("A1S2", "A", .01,
                initial["weightsSha256"], active.SEED, self.client.fingerprint,
                architecture=ADAPTED_MAP, auxiliary_config={**aux, "enabled": False}))
        self.assertNotEqual(saved["experimentConfigSha256"],
            ppo.experiment_config_sha256("S2MAP", "A", .01,
                initial["weightsSha256"], active.SEED, self.client.fingerprint,
                architecture=ADAPTED_MAP, auxiliary_config=aux))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.pt"
            torch.save(saved, path)
            restored = make_network(ADAPTED_MAP, self.encoder)
            restored_optimizer = torch.optim.Adam(restored.parameters(), lr=3e-4)
            ppo.restore_checkpoint(path, restored, restored_optimizer, self.encoder,
                self.client, "A", random.Random(), training_seed=active.SEED,
                experiment_id="A1S2", entropy_coefficient=.01,
                initial_weights_sha256=initial["weightsSha256"],
                architecture=ADAPTED_MAP, auxiliary_config=aux)
            self.assertEqual(ppo.model_weights_sha256(restored), initial["weightsSha256"])
            with self.assertRaises(ValueError):
                ppo.restore_checkpoint(path, restored, restored_optimizer, self.encoder,
                    self.client, "A", random.Random(), training_seed=active.SEED,
                    experiment_id="A1S2", entropy_coefficient=.01,
                    initial_weights_sha256=initial["weightsSha256"],
                    architecture=ADAPTED_MAP,
                    auxiliary_config={**aux, "enabled": False})

    def test_auxiliary_is_separate_and_decays(self):
        initial, config = active.read_initial()
        bundle = ppo_auxiliary.load(active.AUXILIARY, initial["weightsSha256"],
                                    self.client.fingerprint, self.encoder)
        self.assertEqual(ppo_auxiliary.weight_at_update(config, 1), .05)
        self.assertEqual(ppo_auxiliary.weight_at_update(config, 21), 0)
        model = make_network(ADAPTED_MAP, self.encoder)
        model.load_state_dict(initial["modelState"])
        optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
        before = ppo.model_weights_sha256(model)
        metrics = ppo_auxiliary.update(model, optimizer, bundle, "cpu", .05, 1)
        self.assertEqual(metrics["source"], "scripted-labels-only")
        self.assertEqual(metrics["sampleCount"], 2)
        self.assertGreaterEqual(metrics["maximumControlValueDrift"], 0)
        self.assertNotEqual(ppo.model_weights_sha256(model), before)
        self.assertEqual(ppo_auxiliary.update(model, optimizer, bundle, "cpu", 0, 21)["appliedWeight"], 0)

    def test_candidate_padding_is_ineligible(self):
        initial, _ = active.read_initial()
        model = make_network(ADAPTED_MAP, self.encoder)
        model.load_state_dict(initial["modelState"])
        first = torch.load(active.AUXILIARY, map_location="cpu", weights_only=False)["opening"]
        candidates = torch.cat((first["candidates"], torch.zeros_like(first["candidates"][:2])))
        mask = torch.tensor([[True] * first["candidates"].shape[0] + [False, False]])
        with torch.inference_mode():
            logits, _ = model(first["state"][None], candidates[None], mask)
        self.assertTrue(torch.all(logits[0, -2:] <= -1e8))


if __name__ == "__main__":
    unittest.main()
