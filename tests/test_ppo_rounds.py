import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import torch

from scripts import ppo_rounds
from scripts.ppo_train import ArenaClient, ROOT


class RoundRunnerTests(unittest.TestCase):
    def test_default_results_live_beside_root_launcher(self):
        self.assertEqual(ppo_rounds.DEFAULT_RESULTS, ROOT / "PPO训练")

    def test_training_record_contains_real_decision_and_state_snapshots(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "record.jsonl"
            client = ArenaClient(log_path=path, log_snapshots=True)
            try:
                reset = client.request(op="reset", seed=987650, mode="A", cardSet="events",
                                       trace="full", recordMetadata={"round": 1})
                observation = reset["observation"]
                client.request(op="step", action={**observation["decision"],
                                                  "actionId": observation["candidates"][0]["id"]})
            finally:
                client.close()
            rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([row.get("recordType", row.get("type")) for row in rows],
                             ["AI训练记录", "state", "ppo-decision", "state"])
            self.assertEqual(rows[0]["trainingMetadata"], {"round": 1})
            self.assertEqual(rows[1]["snapshot"]["header"]["seed"], 987650)
            self.assertEqual(rows[-1]["snapshot"]["decisionCount"], 1)

    def test_selected_game_is_reproducible_and_not_the_old_fixed_seed_pool(self):
        seeds = set()
        for mode in ("A", "B"):
            for number in range(1, 12):
                seed = ppo_rounds.selected_game(20260930, mode, number)
                self.assertEqual(seed, ppo_rounds.selected_game(20260930, mode, number))
                self.assertGreaterEqual(seed, 1_000_000_000)
                seeds.add(seed)
        self.assertEqual(len(seeds), 22)

    def test_round_runner_does_not_request_fixed_opponent_evaluation(self):
        with patch.object(ppo_rounds.subprocess, "run") as run:
            ppo_rounds.run_training("A", 10, False, 10, 20260930,
                                    Path("latest.pt"), Path("report.json"))
        command = run.call_args.args[0]
        self.assertNotIn("--eval-seeds", command)
        self.assertNotIn("--no-eval", command)

    def test_record_validation_rejects_missing_state_and_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "record.jsonl"
            header = {"recordType": "AI训练记录",
                      "logFormat": "quartermaster-ppo-training-jsonl-v2", "seed": 5}
            rows = [header, {"recordType": "state"}, {"type": "ppo-decision"},
                    {"recordType": "state"},
                    {"recordType": "result", "termination": "natural"}]
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            self.assertEqual(len(ppo_rounds.validate_record(path, 1, 5)), 64)
            with self.assertRaisesRegex(ValueError, "不完整"):
                ppo_rounds.validate_record(path, 2, 5)
            rows[-1]["termination"] = "truncated"
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "不完整"):
                ppo_rounds.validate_record(path, 1, 5)

    def test_checkpoint_accounting_and_exactly_two_visible_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / ".state" / "A"
            state.mkdir(parents=True)
            checkpoint = state / "latest.pt"
            payload = {"mode": "A", "cardSet": "events", "trainingSeed": 12,
                       "episodesPerUpdate": 40, "completedEpisodes": 400,
                       "update": 10, "policyVersion": 10, "completedDecisions": 1000,
                       "buildFingerprint": "f" * 64, "trainerSourceSha256": "a" * 64,
                       "observationSchemaVersion": "v3", "actionSchemaVersion": "v3",
                       "encoderVersion": "v3", "network": {"stateDim": 1, "candidateDim": 1},
                       "modelState": {"weight": torch.ones(1)}}
            torch.save(payload, checkpoint)
            args = SimpleNamespace(result_root=root, seed=12, dry_run=False, workers=10)

            def fake_record(_checkpoint, target, *_args):
                target.write_text('招募AI训练记录\n', encoding="utf-8")
                return {"seed": 987650, "decisions": 1}

            with patch.object(ppo_rounds, "run_training") as training, patch.object(
                    ppo_rounds, "record_game", side_effect=fake_record) as recording:
                ppo_rounds.complete_round("A", 1, args)
                ppo_rounds.complete_round("A", 1, args)
            training.assert_not_called()
            recording.assert_called_once()
            output = root / "A" / "第001轮"
            self.assertEqual({item.name for item in output.iterdir()},
                             {ppo_rounds.WEIGHTS_NAME, ppo_rounds.RECORD_NAME})
            weights = torch.load(output / ppo_rounds.WEIGHTS_NAME, weights_only=False)
            self.assertEqual(weights["policyVersion"], 10)
            self.assertNotIn("optimizerState", weights)
            payload["completedEpisodes"] = 399
            torch.save(payload, checkpoint)
            with self.assertRaisesRegex(ValueError, "完整局数"):
                ppo_rounds.checkpoint_update(checkpoint, "A", 12)


if __name__ == "__main__":
    unittest.main()
