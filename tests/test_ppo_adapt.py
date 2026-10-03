import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

from scripts import ppo_adapt
from scripts.ppo_train import ArenaClient, Encoder, PpoNetwork, batch_tensors


class AdaptationTests(unittest.TestCase):
    def test_migration_keeps_old_prefix_and_initial_policy(self):
        root = ppo_adapt.rounds.DEFAULT_RESULTS
        original, saved, original_hash = ppo_adapt.baseline(root)
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "A1" / "第012轮"
            target.mkdir(parents=True)
            shutil.copy2(original, target / original.name)
            client = ArenaClient()
            try:
                encoder = Encoder(client.schema)
                initial, digest, baseline_hash = ppo_adapt.initial_weights(Path(temp), True)
                self.assertEqual(baseline_hash, original_hash)
                migrated = torch.load(initial, map_location="cpu", weights_only=False)
                self.assertEqual(migrated["sourceRound"], 12)
                self.assertEqual(migrated["weightsSha256"], digest)
                old = PpoNetwork(saved["network"]["stateDim"],
                                 saved["network"]["candidateDim"])
                old.load_state_dict(saved["modelState"])
                new = PpoNetwork(encoder.state_dim, encoder.candidate_dim)
                new.load_state_dict(migrated["modelState"])
                width = saved["network"]["candidateDim"]
                self.assertTrue(torch.equal(new.candidate_net[0].weight[:, :width],
                                            old.candidate_net[0].weight))
                self.assertEqual(int(torch.count_nonzero(new.candidate_net[0].weight[:, width:])), 0)
                observation = client.request(op="reset", seed=871, mode="A",
                                             cardSet="events")["observation"]
                state, candidates = encoder.encode(observation)
                with torch.no_grad():
                    old_logits, old_value = old(*batch_tensors([{"state": state,
                        "candidates": candidates[:, :width]}], torch.device("cpu")))
                    new_logits, new_value = new(*batch_tensors([{"state": state,
                        "candidates": candidates}], torch.device("cpu")))
                self.assertTrue(torch.allclose(old_logits, new_logits, atol=2e-6, rtol=0))
                self.assertTrue(torch.equal(old_value, new_value))
                self.assertEqual(int(old_logits.argmax()), int(new_logits.argmax()))
            finally:
                client.close()

    def test_dry_run_does_not_create_plan_and_pending_old_plan_blocks_new_run(self):
        root = ppo_adapt.rounds.DEFAULT_RESULTS
        original, _, _ = ppo_adapt.baseline(root)
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "A1" / "第012轮"
            target.mkdir(parents=True)
            shutil.copy2(original, target / original.name)
            with patch("sys.argv", ["ppo_adapt", "--rounds", "1", "--dry-run",
                                    "--result-root", temp]):
                ppo_adapt.main()
            self.assertFalse((Path(temp) / ".state" / ppo_adapt.PLAN_NAME).exists())
            old = Path(temp) / ".state" / "comparison-plan.json"
            old.parent.mkdir(parents=True)
            old.write_text(json.dumps({"status": "pending"}), encoding="utf-8")
            with patch("sys.argv", ["ppo_adapt", "--rounds", "1", "--dry-run",
                                    "--result-root", temp]):
                with self.assertRaisesRegex(ValueError, "未完成"):
                    ppo_adapt.main()
            self.assertEqual(json.loads(old.read_text(encoding="utf-8"))["status"], "pending")


if __name__ == "__main__":
    unittest.main()
