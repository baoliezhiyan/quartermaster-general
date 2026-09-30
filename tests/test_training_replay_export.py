"""Exercise actual A/B arena games through the training replay contract."""
import json
import random
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.ppo_train import ArenaClient, ROOT


class TrainingReplayExportTests(unittest.TestCase):
    def test_complete_a_and_b_games_replay_with_explicit_resource_zones(self):
        for mode, seed, choice_seed in (("A", 987661, 44), ("B", 987651, 44),
                                        ("A", 987650, 987669)):
            with self.subTest(mode=mode, seed=seed), tempfile.TemporaryDirectory() as directory:
                raw = Path(directory) / "raw.jsonl"
                replay = Path(directory) / "replay.jsonl"
                client = ArenaClient(log_path=raw, log_snapshots=True)
                try:
                    response = client.request(op="reset", seed=seed, mode=mode,
                                              cardSet="events", trace="full",
                                              recordMetadata={"round": 1})
                    rng = random.Random(choice_seed)
                    decisions = 0
                    while response["observation"] is not None and decisions < 3000:
                        observation = response["observation"]
                        candidate = rng.choice(observation["candidates"])
                        response = client.request(op="step", action={
                            **observation["decision"], "actionId": candidate["id"]})
                        decisions += 1
                    self.assertIsNone(response["observation"], "sample game was truncated")
                    self.assertEqual(response["result"]["termination"], "natural")
                finally:
                    client.close()
                subprocess.run(["node", "scripts/ppo-export-training-replay.mjs",
                                str(raw), str(replay)], cwd=ROOT, check=True,
                               capture_output=True, text=True, encoding="utf-8")
                lines = [json.loads(line) for line in replay.read_text(encoding="utf-8").splitlines()]
                self.assertEqual(lines[0]["mode"], "resource_pool")
                self.assertEqual(lines[0]["training"]["configuration"]["mode"], mode)
                self.assertEqual(lines[0]["training"]["configuration"]["recordKind"], "AI训练记录")
                self.assertTrue(lines[-1]["contentHash"])
                self.assertEqual(len([line for line in lines if line["type"] == "start"]), 1)
                if seed == 987650:
                    self.assertTrue(any(line["type"] == "training_action" and
                                        line["operations"] == [] for line in lines))
                start = lines[1]
                self.assertTrue(all(zone["ids"] == [] for zone in start["resources"]
                                    if zone["zone"] == "hand"))
                all_changes = [op["change"] for line in lines if line["type"] == "training_action"
                               for op in line["operations"] if op["kind"] == "resource"]
                self.assertTrue(any(op["op"] == "move" and
                                    op["to"]["zone"] == "discardPile" for op in all_changes))
                if mode == "A":
                    self.assertTrue(all(zone["ids"] == [] for zone in start["resources"]
                                        if zone["zone"] == "resourcePool"))
                    self.assertFalse(any(op.get("zone") == "resourcePool" for op in all_changes))
                else:
                    self.assertTrue(any(op["op"] == "set" and
                                        op["zone"] == "resourcePool" for op in all_changes))
                verified = subprocess.run(["node", "scripts/validate-match-log.mjs",
                                           str(replay), "--replay"], cwd=ROOT, check=True,
                                          capture_output=True, text=True, encoding="utf-8")
                self.assertTrue(json.loads(verified.stdout)["sceneReexecuted"])

    def test_incomplete_game_cannot_be_exported(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory) / "raw.jsonl"
            replay = Path(directory) / "replay.jsonl"
            raw.write_text('{"recordType":"AI训练记录"}\n', encoding="utf-8")
            result = subprocess.run(["node", "scripts/ppo-export-training-replay.mjs",
                                     str(raw), str(replay)], cwd=ROOT,
                                    capture_output=True, text=True, encoding="utf-8")
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(replay.exists())


if __name__ == "__main__":
    unittest.main()
