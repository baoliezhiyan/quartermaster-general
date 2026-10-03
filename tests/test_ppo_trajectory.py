import copy
import json
import random
import tempfile
import time
import unittest
from pathlib import Path

import torch

from scripts.ppo_train import PpoNetwork, assign_advantages, ppo_update
from scripts.ppo_trajectory import TrajectoryStore, cleanup_stale, _remove_owned_directory


def sample(number, rows):
    return {"seat": ["germany", "united_kingdom", "japan"][number % 3],
            "state": torch.arange(7, dtype=torch.float16) + number,
            "candidates": torch.arange(rows * 9, dtype=torch.float16).reshape(rows, 9) + number,
            "action": number % rows, "logprob": -0.5 - number / 20,
            "value": number / 10, "baseline": False}


class TrajectoryStoreTests(unittest.TestCase):
    def test_lossless_varied_candidates_chunk_boundaries_repeated_reads_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            originals = [sample(i, rows) for i, rows in enumerate([1, 3, 2, 5, 1, 7, 2])]
            with TrajectoryStore("A", 3, root=root, write_limit=180, read_limit=350) as store:
                lightweight = []
                for original in originals:
                    sample_id = store.append(original)
                    lightweight.append({"sampleId": sample_id, "seat": original["seat"],
                                        "value": original["value"], "action": original["action"]})
                rewards = [{"axis": 0.1, "allies": -0.1}] * len(lightweight)
                assign_advantages(lightweight, rewards, [1] * len(lightweight))
                store.finish_episode(lightweight[3:])
                store.finish_episode(lightweight[:3])
                store.seal()
                self.assertGreater(len(store.chunks), 1)
                self.assertEqual(store.stats()["candidateTotal"], 21)
                for _ in range(3):
                    store.prefetch([0, 1, 2])
                    loaded = store.load_batch([6, 1, 3, 0, 4])
                    for row, order_index in zip(loaded, [6, 1, 3, 0, 4]):
                        original = originals[store.training_order[order_index]]
                        self.assertTrue(torch.equal(row["state"], original["state"]))
                        self.assertTrue(torch.equal(row["candidates"], original["candidates"]))
                        self.assertEqual(row["action"], original["action"])
                        self.assertEqual(row["logprob"], original["logprob"])
                        self.assertEqual(row["advantage"], lightweight[store.training_order[order_index]]["advantage"])
                self.assertLessEqual(store.stats()["readCacheBytes"], store.read_limit)
                self.assertLessEqual(store.stats()["peakWriteBufferBytes"], store.write_limit)
                spool_dir = store.directory
            self.assertFalse(spool_dir.exists())

    def test_ppo_gradient_and_metrics_match_in_memory_samples_with_remainder(self):
        torch.manual_seed(9)
        rows = [1, 3, 2, 4, 1]
        originals = [sample(i, count) for i, count in enumerate(rows)]
        rewards = [{"axis": 0.03 * i, "allies": -0.03 * i} for i in range(len(rows))]
        elapsed = [0, 1, 0, 2, 1]
        baseline = [{key: value for key, value in item.items()} for item in originals]
        assign_advantages(baseline, rewards, elapsed)
        model_old = PpoNetwork(7, 9)
        model_disk = copy.deepcopy(model_old)
        optim_old = torch.optim.Adam(model_old.parameters(), lr=3e-4)
        optim_disk = torch.optim.Adam(model_disk.parameters(), lr=3e-4)
        with tempfile.TemporaryDirectory() as directory:
            with TrajectoryStore("B", 2, root=Path(directory), write_limit=160) as store:
                small = []
                for original in originals:
                    sample_id = store.append(original)
                    small.append({"sampleId": sample_id, "seat": original["seat"],
                                  "action": original["action"], "value": original["value"]})
                assign_advantages(small, rewards, elapsed)
                store.finish_episode(small)
                store.seal()
                old_metrics = ppo_update(model_old, optim_old, baseline, torch.device("cpu"),
                                         random.Random(7), epochs=2, minibatch=2)
                disk_metrics = ppo_update(model_disk, optim_disk, store, torch.device("cpu"),
                                          random.Random(7), epochs=2, minibatch=2)
                for key in old_metrics:
                    self.assertAlmostEqual(old_metrics[key], disk_metrics[key], delta=1e-5, msg=key)
                for key, value in model_old.state_dict().items():
                    self.assertTrue(torch.allclose(value, model_disk.state_dict()[key], atol=1e-6), key)

    def test_gradient_microbatches_keep_one_shuffled_optimizer_step(self):
        torch.manual_seed(31)
        originals = [sample(i, rows) for i, rows in enumerate([1, 4, 2, 5, 3])]
        for i, item in enumerate(originals):
            item.update(advantage=(i - 2) * .11, target=.2 - i * .07)
        full = PpoNetwork(7, 9)
        pieces = copy.deepcopy(full)
        full_optimizer = torch.optim.Adam(full.parameters(), lr=3e-4)
        pieces_optimizer = torch.optim.Adam(pieces.parameters(), lr=3e-4)
        original = ppo_update(full, full_optimizer, originals, torch.device("cpu"),
                              random.Random(21), epochs=2, minibatch=4)
        accumulated = ppo_update(pieces, pieces_optimizer, originals, torch.device("cpu"),
                                 random.Random(21), epochs=2, minibatch=4,
                                 gradient_microbatch=2)
        for key in original:
            self.assertAlmostEqual(original[key], accumulated[key], delta=1e-5, msg=key)
        for key, value in full.state_dict().items():
            # Adam amplifies roundoff in the theoretically zero softmax-shift bias.
            self.assertTrue(torch.allclose(value, pieces.state_dict()[key], atol=1e-4),
                            (key, float((value - pieces.state_dict()[key]).abs().max())))

    def test_safe_stale_cleanup_does_not_touch_live_or_outside_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"
            outside = Path(directory) / "outside"
            outside.mkdir()
            (outside / "owner.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(ValueError):
                _remove_owned_directory(root, outside)
            with TrajectoryStore("A", 5, root=root) as live:
                abandoned = root / "ppo-A-u0001-abandoned"
                abandoned.mkdir()
                (abandoned / "owner.json").write_text(json.dumps({
                    "format": "ppo-trajectory-v1", "pid": 2**30,
                    "createdAt": time.time() - 1000}), encoding="utf-8")
                (abandoned / "samples.bin").write_bytes(b"temporary")
                self.assertEqual(cleanup_stale(root, min_age_seconds=1), [abandoned.name])
                self.assertTrue(live.directory.exists())
                self.assertTrue(outside.exists())

    def test_exception_closes_writer_and_removes_temporary_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "controlled failure"):
                with TrajectoryStore("B", 6, root=root) as store:
                    spool_dir = store.directory
                    store.append(sample(0, 2))
                    raise RuntimeError("controlled failure")
            self.assertFalse(spool_dir.exists())


if __name__ == "__main__":
    unittest.main()
