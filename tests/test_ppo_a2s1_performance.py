"""Bounded performance migration checks; never starts a production batch."""
import copy
import hashlib
import random
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

from scripts import ppo_train as ppo
from scripts.ppo_trajectory import TrajectoryStore


def fixture(index, rows):
    return {"state": torch.arange(7, dtype=torch.float16) + index,
            "candidates": torch.arange(rows * 9, dtype=torch.float16).reshape(rows, 9),
            "seat": "germany", "action": index % rows, "logprob": -.4,
            "value": .1, "advantage": (index % 7 - 3) * .03,
            "target": index * .001, "baseline": False}


class A2S1PerformanceTests(unittest.TestCase):
    def test_encoder_matches_reference_and_policy(self):
        client = ppo.ArenaClient(card_set="signals")
        try:
            encoder = ppo.Encoder(client.schema)
            obs = client.request(op="reset", seed=20266930, mode="A",
                                 cardSet="signals")["observation"]
            old_state, old_candidates = encoder.encode_reference(obs)
            state, candidates = encoder.encode(obs)
            self.assertTrue(torch.equal(old_state, state))
            self.assertTrue(torch.equal(old_candidates, candidates))
            variant = copy.deepcopy(obs)
            variant["units"].append({"id": "encoding-probe", "country": "germany",
                                     "type": "army", "regionId": "eastern_europe"})
            variant["suppliedUnitIds"].append("encoding-probe")
            variant["visibleCards"]["active"]["germany"].append("special_150")
            variant["visibleUseCounts"]["special_150"] = 1
            variant["effectiveStraits"]["germany"][0] = not variant["effectiveStraits"]["germany"][0]
            variant["candidates"] = [{"id": "pass-probe", "kind": "pass"}]
            reference_variant = encoder.encode_reference(variant)
            optimized_variant = encoder.encode(variant)
            self.assertTrue(torch.equal(reference_variant[0], optimized_variant[0]))
            self.assertTrue(torch.equal(reference_variant[1], optimized_variant[1]))
            from scripts.ppo_network_factory import A2S1_ADAPTER, make_network
            model = make_network(A2S1_ADAPTER, encoder).eval()
            with torch.inference_mode():
                old_logits, _ = model(*ppo.batch_tensors([{
                    "state": old_state, "candidates": old_candidates}], torch.device("cpu")))
                logits, _ = model(*ppo.batch_tensors([{
                    "state": state, "candidates": candidates}], torch.device("cpu")))
            self.assertTrue(torch.equal(old_logits, logits))
        finally:
            client.close()

    def test_block_epochs_cover_every_sample_and_preserve_float16(self):
        with tempfile.TemporaryDirectory() as directory:
            with TrajectoryStore("A", 2, root=Path(directory), write_limit=160,
                                 read_limit=350, prefetch_limit=128) as store:
                rows = [1, 3, 2, 5, 1, 7, 2, 4, 3, 1, 6]
                for index, count in enumerate(rows):
                    item = fixture(index, count)
                    sid = store.append(item)
                    store.finish_episode([{"sampleId": sid, "advantage": item["advantage"],
                                           "target": item["target"], "actualReturn": item["target"]}])
                store.seal()
                for epoch in range(4):
                    batches = list(store.epoch_batches(list(range(len(rows))), random.Random(epoch), 4))
                    self.assertEqual([len(batch) for batch in batches], [4, 4, 3])
                    order = [position for batch in batches for position in batch]
                    self.assertEqual(sorted(order), list(range(len(rows))))
                    for batch in batches:
                        self.assertTrue(all(item["state"].dtype == torch.float16
                                            for item in store.load_batch(batch)))
                self.assertLessEqual(store.stats()["readCacheBytes"], 350)
                self.assertLessEqual(store.stats()["prefetchLimitBytes"], 128)
                network = ppo.PpoNetwork(7, 9)
                optimizer = torch.optim.Adam(network.parameters(), lr=3e-4)
                metrics = ppo.ppo_update(network, optimizer, store, torch.device("cpu"),
                                         random.Random(19), epochs=4, minibatch=4,
                                         gradient_microbatch=2,
                                         sampling="chunk-shuffle-epoch-v1")
                self.assertEqual(metrics["samples"], len(rows))
                self.assertEqual(metrics["sampling"], "chunk-shuffle-epoch-v1")

    def test_cuda_oom_retry_restarts_logical_minibatch_without_extra_step(self):
        items = [fixture(index, 2 + index % 5) for index in range(128)]
        torch.manual_seed(14)
        baseline = ppo.PpoNetwork(7, 9)
        retry = copy.deepcopy(baseline)
        base_optimizer = torch.optim.Adam(baseline.parameters(), lr=3e-4)
        retry_optimizer = torch.optim.Adam(retry.parameters(), lr=3e-4)
        expected = ppo.ppo_update(baseline, base_optimizer, items, torch.device("cpu"),
                                  random.Random(8), epochs=1, minibatch=128,
                                  gradient_microbatch=32)
        original = ppo.batch_tensors
        large_calls = []

        def fail_once(piece, device):
            if len(piece) > 32:
                large_calls.append(True)
            if len(piece) > 32 and len(large_calls) == 2:
                raise torch.cuda.OutOfMemoryError("CUDA out of memory")
            return original(piece, device)

        with patch.object(ppo, "batch_tensors", side_effect=fail_once), \
             patch.object(ppo, "_is_cuda_oom", return_value=True):
            actual = ppo.ppo_update(retry, retry_optimizer, items, torch.device("cpu"),
                                    random.Random(8), epochs=1, minibatch=128,
                                    gradient_microbatch=64)
        self.assertEqual(len(actual["oomFallbacks"]), 1)
        self.assertEqual(actual["oomFallbacks"][0]["to"], 32)
        for key in ("loss", "entropy", "clipFraction", "approxKl"):
            self.assertAlmostEqual(expected[key], actual[key], delta=1e-6)
        for key in baseline.state_dict():
            self.assertTrue(torch.allclose(baseline.state_dict()[key], retry.state_dict()[key],
                                            atol=1e-6), key)
        self.assertEqual(len(base_optimizer.state), len(retry_optimizer.state))

    def test_resume_migration_requires_exact_parent_and_complete_update_one(self):
        client = ppo.ArenaClient(card_set="signals")
        try:
            from scripts.ppo_network_factory import A2S1_ADAPTER, make_network
            encoder = ppo.Encoder(client.schema)
            model = make_network(A2S1_ADAPTER, encoder)
            optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
            initial_hash = ppo.model_weights_sha256(model)
            rng = random.Random(20266930)
            payload = ppo.checkpoint_payload(model, optimizer, encoder, client,
                "A", 1, 12, rng, 20266970, "signals", completed_episodes=40,
                training_seed=20266930, experiment_id="A2S1",
                entropy_coefficient=.01, initial_weights_sha256=initial_hash,
                architecture=A2S1_ADAPTER)
            payload["trainerSourceSha256"] = "87b7fa23046c8a38a0bb06623085ad414353f413fad16c976a56544bb924c8d2"
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "old.pt"
                torch.save(payload, path)
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                kwargs = dict(card_set="signals", training_seed=20266930,
                    experiment_id="A2S1", entropy_coefficient=.01,
                    initial_weights_sha256=initial_hash, architecture=A2S1_ADAPTER)
                with self.assertRaisesRegex(ValueError, "trainer source"):
                    ppo.restore_checkpoint(path, model, optimizer, encoder, client,
                                           "A", rng, **kwargs)
                with self.assertRaisesRegex(ValueError, "trainer source"):
                    ppo.restore_checkpoint(path, model, optimizer, encoder, client,
                        "A", rng, approved_resume_parent_sha256="0" * 64, **kwargs)
                restored = ppo.restore_checkpoint(path, model, optimizer, encoder, client,
                    "A", rng, approved_resume_parent_sha256=digest, **kwargs)
                self.assertEqual((restored["update"], restored["completedEpisodes"]), (1, 40))
                payload["update"] = 2
                payload["completedEpisodes"] = 80
                torch.save(payload, path)
                with self.assertRaisesRegex(ValueError, "trainer source"):
                    ppo.restore_checkpoint(path, model, optimizer, encoder, client,
                        "A", rng, approved_resume_parent_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                        **kwargs)
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
