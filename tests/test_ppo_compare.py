import copy
import json
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import torch

from scripts import ppo_compare, ppo_rounds, ppo_train
from scripts.ppo_parallel import (collect_batch, decision_rewards as parallel_decision_rewards,
                                  make_tasks, policy_rng)
from scripts.ppo_trajectory import TrajectoryStore


class ComparisonTests(unittest.TestCase):
    def test_entropy_coefficient_changes_actual_loss_only_by_entropy_term(self):
        torch.manual_seed(41)
        base_model = ppo_train.PpoNetwork(5, 4)
        item = {"seat": "germany", "state": torch.randn(5), "candidates": torch.randn(3, 4),
                "action": 0, "advantage": 0.7, "target": 0.3, "value": 0.0,
                "baseline": False}
        with torch.no_grad():
            logits, _ = base_model(*ppo_train.batch_tensors([item], "cpu"))
            logprobs = torch.log_softmax(logits[0], -1)
        first = {**item, "logprob": float(logprobs[0])}
        second = {**item, "action": 1, "advantage": -0.7, "target": -0.2,
                  "logprob": float(logprobs[1])}
        outputs = []
        for coefficient in (0.01, 0.02):
            model = copy.deepcopy(base_model)
            optimizer = torch.optim.Adam(model.parameters(), lr=0.0)
            metrics = ppo_train.ppo_update(model, optimizer, [first, second], "cpu",
                                           random.Random(5), epochs=1, minibatch=2,
                                           entropy_coefficient=coefficient)
            outputs.append(metrics)
        self.assertEqual([m["entropyCoefficient"] for m in outputs], [0.01, 0.02])
        self.assertAlmostEqual(outputs[1]["loss"] - outputs[0]["loss"],
                               -0.01 * outputs[0]["entropy"], delta=1e-6)
        for name in ("entropy", "clipFraction", "approxKl", "valueErrorBefore"):
            self.assertAlmostEqual(outputs[0][name], outputs[1][name], delta=1e-7)

    def test_single_and_parallel_reward_entry_agree_without_opponent_bonus(self):
        previous = {"decisionSeat": "soviet_union", "allianceScores": {"axis": 1, "allies": 2}}
        after = {"axis": 1, "allies": 6}
        info = {"wasteCheck": {"seat": "soviet_union", "repeated": True,
                               "penalty": True, "reason": "repeated_basic_build"}}
        self.assertIs(parallel_decision_rewards, ppo_train.decision_rewards)
        base, total = ppo_train.decision_rewards(previous, after, None, info)
        self.assertAlmostEqual(total["allies"] - base["allies"], -0.01)
        self.assertEqual(total["axis"], base["axis"])

    def test_same_seed_action_stream_has_same_single_and_parallel_rewards(self):
        seed, training_seed = 987650, 42
        client = ppo_train.ArenaClient()
        try:
            encoder = ppo_train.Encoder(client.schema)
            model = ppo_train.PpoNetwork(encoder.state_dim, encoder.candidate_dim)
            with tempfile.TemporaryDirectory() as directory:
                with TrajectoryStore("A", 1, root=Path(directory)) as store:
                    _, episodes, _ = collect_batch([client], encoder, model,
                        torch.device("cpu"), make_tasks(seed, 1, 1, "A"), "A", "events",
                        training_seed, 3000, store=store)
                solo = ppo_train.play_episode(client, encoder, model, torch.device("cpu"),
                    "A", seed, 3000, rng=policy_rng(seed, 0, training_seed))
            self.assertEqual(solo["outcome"]["termination"], "natural")
            self.assertEqual(solo["decisions"], episodes[0]["decisions"])
            for name in ("shaped", "trainingReward"):
                for team in ("axis", "allies"):
                    self.assertAlmostEqual(solo[name][team], episodes[0][name][team], delta=1e-6)
            self.assertEqual(solo["wastePenaltiesBySeat"], episodes[0]["wastePenaltiesBySeat"])
        finally:
            client.close()

    def test_one_short_disk_batch_updates_with_a2_entropy_and_cleans_up(self):
        client = ppo_train.ArenaClient()
        try:
            encoder = ppo_train.Encoder(client.schema)
            model = ppo_train.PpoNetwork(encoder.state_dim, encoder.candidate_dim)
            optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
            with tempfile.TemporaryDirectory() as directory:
                with TrajectoryStore("A", 1, root=Path(directory)) as store:
                    samples, episodes, timing = collect_batch([client], encoder, model,
                        torch.device("cpu"), make_tasks(987650, 1, 1, "A"), "A", "events",
                        20260930, 3000, store=store)
                    metrics = ppo_train.ppo_update(model, optimizer, samples,
                        torch.device("cpu"), random.Random(5), epochs=1, minibatch=16,
                        entropy_coefficient=0.02)
                    self.assertEqual(metrics["entropyCoefficient"], 0.02)
                    self.assertGreater(timing["trajectory"]["trajectoryFileBytes"], 0)
                    self.assertIn("wasteOpportunityDecisions", episodes[0])
                    spool_dir = store.directory
                self.assertFalse(spool_dir.exists())
        finally:
            client.close()

    def test_shared_initialization_and_cross_experiment_checkpoint_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(ppo_compare.ppo, "ArenaClient") as arena:
                arena.return_value.fingerprint = "f" * 64
                arena.return_value.schema = {"regions": [], "seats": [], "countries": [],
                                             "eventIds": [], "courseVersion": "test"}
                with patch.object(ppo_compare.ppo, "Encoder") as encoder:
                    encoder.return_value.state_dim = 5
                    encoder.return_value.candidate_dim = 4
                    path, digest = ppo_compare.initial_weights(root, 42, create=True)
            self.assertEqual(ppo_compare.initial_weights(root, 42, create=False), (path, digest))
            initial = torch.load(path, map_location="cpu", weights_only=False)
            a1 = ppo_train.PpoNetwork(5, 4)
            a2 = ppo_train.PpoNetwork(5, 4)
            a1.load_state_dict(initial["modelState"])
            a2.load_state_dict(initial["modelState"])
            self.assertEqual(ppo_train.model_weights_sha256(a1), digest)
            self.assertEqual(ppo_train.model_weights_sha256(a2), digest)
            client = SimpleNamespace(fingerprint="f" * 64, schema={
                "observationSchemaVersion": "v5", "actionSchemaVersion": "v4", "eventIds": []})
            encoder = SimpleNamespace(state_dim=5, candidate_dim=4, signals=False)
            optim = torch.optim.Adam(a1.parameters())
            payload = ppo_train.checkpoint_payload(a1, optim, encoder, client, "A", 1, 10,
                random.Random(42), 20260970, completed_episodes=40, training_seed=20260930,
                experiment_id="A1", entropy_coefficient=0.01, initial_weights_sha256=digest)
            checkpoint = root / "latest.pt"
            torch.save(payload, checkpoint)
            with self.assertRaisesRegex(ValueError, "schema, mode, or rules"):
                ppo_train.restore_checkpoint(checkpoint, a2, torch.optim.Adam(a2.parameters()),
                    encoder, client, "A", random.Random(), training_seed=20260930,
                    experiment_id="A2", entropy_coefficient=0.02,
                    initial_weights_sha256=digest)
            self.assertEqual(payload["mode"], "A")
            self.assertEqual(payload["optimizerConfig"]["entropy"], 0.01)
            self.assertEqual(payload["rewardConfig"]["actionWastePenalty"], -0.01)
            other = ppo_train.experiment_config_sha256("A2", "A", 0.02, digest,
                20260930, client.fingerprint)
            self.assertNotEqual(payload["experimentConfigSha256"], other)
            self.assertEqual({k: v for k, v in payload["optimizerConfig"].items() if k != "entropy"},
                             {k: v for k, v in ppo_train.OPTIMIZER_CONFIG.items() if k != "entropy"})

    def test_dry_run_plans_two_a_experiments_and_no_b_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(sys, "argv", ["ppo_compare", "--rounds", "2", "--dry-run",
                                           "--result-root", str(root)]):
                with patch.object(ppo_compare, "complete_round") as complete:
                    ppo_compare.main()
            self.assertEqual([(c.args[1], c.args[2]) for c in complete.call_args_list],
                             [("A1", 1), ("A1", 2), ("A2", 1), ("A2", 2)])
            self.assertFalse((root / ".state").exists())

    def test_pending_plan_after_a1_failure_resumes_a2_without_repeating_a1(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = {"A1": 0, "A2": 0}
            def fake_progress(_root, experiment, _seed, _hash):
                return state[experiment], state[experiment] * 10
            def interrupted(_root, experiment, number, *_args):
                if experiment == "A2":
                    raise RuntimeError("interrupted")
                state[experiment] = number
            with patch.object(ppo_compare, "initial_weights", return_value=(root / "initial.pt", "h" * 64)), \
                 patch.object(ppo_compare, "progress", side_effect=fake_progress), \
                 patch.object(ppo_compare.torch.cuda, "is_available", return_value=True), \
                 patch.object(ppo_compare, "complete_round", side_effect=interrupted), \
                 patch.object(sys, "argv", ["ppo_compare", "--rounds", "1", "--result-root", str(root)]):
                with self.assertRaisesRegex(RuntimeError, "interrupted"):
                    ppo_compare.main()
            plan_path = root / ".state" / ppo_compare.PLAN_NAME
            self.assertEqual(json.loads(plan_path.read_text(encoding="utf-8"))["status"], "pending")
            continued = []
            def finish(_root, experiment, number, *_args):
                continued.append(experiment)
                state[experiment] = number
            with patch.object(ppo_compare, "initial_weights", return_value=(root / "initial.pt", "h" * 64)), \
                 patch.object(ppo_compare, "progress", side_effect=fake_progress), \
                 patch.object(ppo_compare.torch.cuda, "is_available", return_value=True), \
                 patch.object(ppo_compare, "complete_round", side_effect=finish), \
                 patch.object(sys, "argv", ["ppo_compare", "--continue-plan", "--result-root", str(root)]):
                ppo_compare.main()
            self.assertEqual(continued, ["A2"])
            self.assertEqual(json.loads(plan_path.read_text(encoding="utf-8"))["status"], "completed")

    def test_round_progress_checks_report_and_checkpoint_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / ".state" / "A1"
            state.mkdir(parents=True)
            initial_hash, build = "a" * 64, "b" * 64
            config_hash = ppo_train.experiment_config_sha256("A1", "A", 0.01,
                initial_hash, 20260930, build)
            saved = {"experimentId": "A1", "mode": "A", "cardSet": "events",
                     "trainingSeed": 20260930, "initialWeightsSha256": initial_hash,
                     "rewardConfig": ppo_train.REWARD_CONFIG,
                     "encoderVersion": ppo_train.ENCODER_VERSION,
                     "episodesPerUpdate": 40,
                     "optimizerConfig": {**ppo_train.OPTIMIZER_CONFIG, "entropy": 0.01},
                     "experimentConfigSha256": config_hash, "buildFingerprint": build,
                     "update": 10, "policyVersion": 10, "completedEpisodes": 400,
                     "nextSeed": 20261330}
            torch.save(saved, state / "latest.pt")
            report = {"experimentId": "A1", "mode": "A", "entropyCoefficient": 0.01,
                      "initialWeightsSha256": initial_hash,
                      "experimentConfigSha256": config_hash,
                      "updates": [{"number": i} for i in range(1, 11)]}
            (state / "training-report.json").write_text(json.dumps(report), encoding="utf-8")
            output = root / "A1" / "第001轮"
            output.mkdir(parents=True)
            (output / ppo_rounds.WEIGHTS_NAME).write_bytes(b"model")
            (output / ppo_rounds.RECORD_NAME).write_bytes(b"record")
            self.assertEqual(ppo_compare.progress(root, "A1", 20260930, initial_hash), (1, 10))
            saved["optimizerConfig"]["entropy"] = 0.02
            torch.save(saved, state / "latest.pt")
            with self.assertRaisesRegex(ValueError, "实验配置不符"):
                ppo_compare.progress(root, "A1", 20260930, initial_hash)

    def test_a1_review_replay_exposes_experiment_mode_and_actual_entropy(self):
        client = ppo_train.ArenaClient()
        try:
            encoder = ppo_train.Encoder(client.schema)
            torch.manual_seed(20260930)
            model = ppo_train.PpoNetwork(encoder.state_dim, encoder.candidate_dim)
            optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
            initial_hash = ppo_train.model_weights_sha256(model)
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                checkpoint = root / "latest.pt"
                initial = root / "initial.pt"
                torch.save({"format": "quartermaster-ppo-comparison-initial-v1",
                    "seed": 20260930, "buildFingerprint": client.fingerprint,
                    "network": {"stateDim": encoder.state_dim,
                                "candidateDim": encoder.candidate_dim},
                    "weightsSha256": initial_hash, "modelState": model.state_dict()}, initial)
                torch.save(ppo_train.checkpoint_payload(model, optimizer, encoder, client,
                    "A", 10, 0, random.Random(20260930), 20261330,
                    completed_episodes=400, training_seed=20260930,
                    experiment_id="A1", entropy_coefficient=0.01,
                    initial_weights_sha256=initial_hash), checkpoint)
                weights = root / "weights.pt"
                digest = ppo_rounds.export_weights(checkpoint, weights, "A", 1,
                                                   20260930, experiment_id="A1")
                record = root / "review.jsonl"
                ppo_rounds.record_game(checkpoint, record, "A", 1, 20260930, digest,
                    experiment_id="A1", entropy_coefficient=0.01,
                    initial_weights_sha256=initial_hash)
                with record.open(encoding="utf-8") as stream:
                    first = json.loads(stream.readline())
                subprocess.run(["node", "scripts/validate-match-log.mjs", str(record), "--replay"],
                               cwd=ppo_train.ROOT, check=True, capture_output=True, text=True)
                config = first["training"]["configuration"]
                self.assertEqual(config["experimentId"], "A1")
                self.assertEqual(config["resourceMode"], "A")
                self.assertEqual(config["entropyCoefficient"], 0.01)
                self.assertEqual(config["initialWeightsSha256"], initial_hash)
                with patch.object(ppo_compare.torch.cuda, "is_available", return_value=False):
                    review = ppo_compare.review_round(checkpoint, initial, "A1", 20260930,
                                                      1, initial_hash)
                self.assertEqual(len(review["games"]), 4)
                self.assertEqual({game["seed"] for game in review["games"]},
                                 set(ppo_compare.EVALUATION_SEEDS))
                self.assertIn("japanEasternChinaRepeated", review["fixedScenePreferences"])
        finally:
            client.close()

    def test_zero_update_cli_reports_same_initial_hash_and_distinct_experiment_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            initial, digest = ppo_compare.initial_weights(root, 20260930, create=True)
            reports = []
            for experiment, entropy in ppo_compare.EXPERIMENTS.items():
                report = root / experiment / "report.json"
                subprocess.run([sys.executable, "scripts/ppo_train.py", "--mode", "A",
                    "--experiment-id", experiment, "--entropy-coefficient", str(entropy),
                    "--initial-weights", str(initial), "--expected-initial-hash", digest,
                    "--workers", "1", "--updates", "0", "--seed", "20260930",
                    "--checkpoint", str(root / experiment / "latest.pt"),
                    "--report", str(report), "--cpu"], cwd=ppo_train.ROOT,
                    check=True, capture_output=True, text=True)
                content = json.loads(report.read_text(encoding="utf-8"))
                self.assertEqual(content["mode"], "A")
                self.assertEqual(content["initialWeightsSha256"], digest)
                self.assertEqual(content["entropyCoefficient"], entropy)
                self.assertEqual(content["updates"], [])
                reports.append(content)
            self.assertNotEqual(reports[0]["experimentConfigSha256"],
                                reports[1]["experimentConfigSha256"])
            for key in ("rewardConfig", "encoderVersion", "courseVersion", "buildFingerprint"):
                self.assertEqual(reports[0][key], reports[1][key])


if __name__ == "__main__":
    unittest.main()
