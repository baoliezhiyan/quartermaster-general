import json
import gc
import random
import tempfile
import unittest
import weakref
from pathlib import Path

import torch

from scripts.ppo_parallel import collect_batch, make_tasks, policy_rng
from scripts.ppo_trajectory import TrajectoryStore
from scripts.ppo_train import (ArenaClient, Encoder, PpoNetwork, checkpoint_payload,
                               restore_checkpoint, NON_SEMANTIC_PREDECESSOR_HASHES)


class ParallelCollectionTests(unittest.TestCase):
    def test_two_small_batches_release_prior_trajectory_before_next_collection(self):
        client = ArenaClient()
        try:
            encoder = Encoder(client.schema)
            model = PpoNetwork(encoder.state_dim, encoder.candidate_dim)
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for update in (1, 2):
                    with TrajectoryStore("A", update, root=root) as store:
                        samples, episodes, timing = collect_batch(
                            [client], encoder, model, torch.device("cpu"),
                            make_tasks(987650 + update, 1, update, "A"),
                            "A", "events", 42, 3000, store=store)
                        self.assertEqual(len(samples), episodes[0]["decisions"])
                        self.assertGreater(timing["trajectory"]["trajectoryFileBytes"], 0)
                        directory_path = store.directory
                        prior = weakref.ref(store)
                    del samples, store
                    gc.collect()  # test-only leak assertion; never called by the trainer
                    self.assertIsNone(prior())
                    self.assertFalse(directory_path.exists())
        finally:
            client.close()

    def test_completed_episode_notifies_progress_once(self):
        client = ArenaClient()
        try:
            encoder = Encoder(client.schema)
            model = PpoNetwork(encoder.state_dim, encoder.candidate_dim)
            seen = []
            with tempfile.TemporaryDirectory() as directory:
                with TrajectoryStore("A", 1, root=Path(directory)) as store:
                    samples, episodes, _timing = collect_batch(
                        [client], encoder, model, torch.device("cpu"),
                        make_tasks(987650, 1, 1, "A"), "A", "events", 42, 3000,
                        on_progress=seen.append, store=store)
                    self.assertIs(samples, store)
                    self.assertEqual(seen, [1])
                    self.assertEqual(len(episodes), 1)
                    self.assertEqual(len(samples), episodes[0]["decisions"])
        finally:
            client.close()

    def test_non_semantic_predecessor_checkpoint_keeps_strict_rule_checks(self):
        client = ArenaClient()
        try:
            encoder = Encoder(client.schema)
            model = PpoNetwork(encoder.state_dim, encoder.candidate_dim)
            optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
            rng = random.Random(12)
            payload = checkpoint_payload(model, optimizer, encoder, client, "A", 10, 1200,
                                         rng, 88, completed_episodes=400, training_seed=48)
            predecessor = "2b9778411434db42f2679a7c1e6a018d8b35d98a7789829c952f06309bcd7704"
            self.assertIn(predecessor, NON_SEMANTIC_PREDECESSOR_HASHES)
            self.assertIn("31ad0efe38df4bceded8b45721c73153dcfc923b3895184d5c7b7ee2d7d8b7f8",
                          NON_SEMANTIC_PREDECESSOR_HASHES)
            payload["trainerSourceSha256"] = predecessor
            with tempfile.TemporaryDirectory() as directory:
                checkpoint = Path(directory) / "latest.pt"
                torch.save(payload, checkpoint)
                restored = restore_checkpoint(checkpoint, model, optimizer, encoder, client,
                                              "A", rng, training_seed=48)
                self.assertEqual(restored["update"], 10)
                payload["buildFingerprint"] = "wrong-rules"
                torch.save(payload, checkpoint)
                with self.assertRaisesRegex(ValueError, "rules build differs"):
                    restore_checkpoint(checkpoint, model, optimizer, encoder, client,
                                       "A", rng, training_seed=48)
                payload["buildFingerprint"] = client.fingerprint
                payload["trainerSourceSha256"] = "unrecognized-source"
                torch.save(payload, checkpoint)
                with self.assertRaisesRegex(ValueError, "trainer source differs"):
                    restore_checkpoint(checkpoint, model, optimizer, encoder, client,
                                       "A", rng, training_seed=48)
        finally:
            client.close()

    def test_tasks_are_40_distinct_seed_bound_jobs_and_policy_rng_is_schedule_independent(self):
        tasks = make_tasks(930930, 40, 7, "A")
        self.assertEqual([task["seed"] for task in tasks], list(range(930930, 930970)))
        self.assertEqual(len({task["jobId"] for task in tasks}), 40)
        self.assertEqual({task["policyVersion"] for task in tasks}, {6})
        first = {task["seed"]: policy_rng(task["seed"], 6, 99).random() for task in tasks}
        shuffled = list(tasks)
        random.Random(5).shuffle(shuffled)
        second = {task["seed"]: policy_rng(task["seed"], 6, 99).random() for task in shuffled}
        self.assertEqual(first, second)

    def test_overlimit_batch_fails_with_diagnostic_and_does_not_change_model(self):
        client = ArenaClient()
        try:
            encoder = Encoder(client.schema)
            model = PpoNetwork(encoder.state_dim, encoder.candidate_dim)
            before = {key: value.clone() for key, value in model.state_dict().items()}
            with tempfile.TemporaryDirectory() as directory:
                diagnostic = Path(directory) / "failed.json"
                with TrajectoryStore("A", 1, root=Path(directory)) as store:
                    with self.assertRaisesRegex(RuntimeError, "exceeded 1 decisions"):
                        collect_batch([client], encoder, model, torch.device("cpu"),
                                      make_tasks(930930, 2, 1, "A"), "A", "events", 42, 1,
                                      diagnostic_path=diagnostic, store=store)
                failure = json.loads(diagnostic.read_text(encoding="utf-8"))
                self.assertEqual(len(failure["tasks"]), 2)
                self.assertEqual(failure["policyVersion"], 0)
                self.assertIn("restart entire batch", failure["resumePolicy"])
            self.assertTrue(all(torch.equal(value, before[key])
                                for key, value in model.state_dict().items()))
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
