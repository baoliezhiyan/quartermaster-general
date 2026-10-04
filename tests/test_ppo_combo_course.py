import gzip
import json
import tempfile
import unittest
import random
from collections import Counter
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_combo_accept import probe
from scripts.ppo_combo_course import TEMPLATES, VERSION, pool_identity, read_pool, replay, ready
from scripts.ppo_combo_metrics import new_tracker, record_step, summarize
from scripts.ppo_parallel import make_tasks
from scripts.ppo_parallel import collect_batch
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network
from scripts.ppo_trajectory import TrajectoryStore


POOL = ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" / "course-pool-v1.json.gz"
PARENT = ppo.ROOT / "PPO训练" / ".state" / "A2S1" / "latest.pt"


class ComboCourseTests(unittest.TestCase):
    def test_deterministic_28_plus_12_schedule_and_rotating_templates(self):
        entries = {f"{template.key}:{variant}:{layer}": {} for template in TEMPLATES
                   for variant in ("positive", "control") for layer in ("payoff", "preparation")}
        all_courses = set()
        all_variants = {template.key: set() for template in TEMPLATES}
        all_layers = {template.key: set() for template in TEMPLATES}
        for update in range(1, 9):
            tasks = make_tasks(1000 + update * 40, 40, update, "A", entries)
            self.assertEqual(len(tasks), 40)
            self.assertEqual(sum("courseId" in task for task in tasks), 12)
            self.assertEqual(sum("courseId" not in task for task in tasks), 28)
            self.assertEqual(sum(task.get("courseId", "").endswith("preparation")
                                 for task in tasks), 4)
            self.assertEqual(len({task["seed"] for task in tasks}), 40)
            for task in tasks[28:]:
                template, variant, layer = task["courseId"].split(":")
                all_courses.add(template)
                all_variants[template].add(variant)
                all_layers[template].add(layer)
        self.assertEqual(all_courses, {template.key for template in TEMPLATES})
        for template in TEMPLATES:
            self.assertEqual(all_variants[template.key], {"positive", "control"})
            self.assertEqual(all_layers[template.key], {"payoff", "preparation"})

    def test_course_pool_rejects_fingerprint_or_generator_change(self):
        if not POOL.exists():
            self.skipTest("Local ignored course pool is absent")
        with gzip.open(POOL, "rt", encoding="utf-8") as stream:
            actual = json.load(stream)
        self.assertEqual(actual["identity"]["version"], VERSION)
        self.assertEqual(len(actual["entries"]), 32)
        bad = {**actual["identity"], "generatorWeightsSha256": "different"}
        with self.assertRaisesRegex(ValueError, "identity differs"):
            read_pool(POOL, bad)

    def test_all_saved_starts_replay_and_payoff_chains_are_legally_selectable(self):
        if not POOL.exists():
            self.skipTest("Local ignored course pool is absent")
        with gzip.open(POOL, "rt", encoding="utf-8") as stream:
            entries = json.load(stream)["entries"]
        client = ppo.ArenaClient(card_set="signals")
        try:
            for entry in entries:
                with self.subTest(template=entry["template"], variant=entry["variant"],
                                  layer=entry["layer"]):
                    observation = replay(client, entry)
                    self.assertIsNotNone(observation)
                    self.assertEqual(observation["decision"]["decisionId"],
                                     entry["snapshot"]["decisionCount"])
                    if entry["layer"] == "payoff":
                        template = next(item for item in TEMPLATES if item.key == entry["template"])
                        self.assertTrue(ready(template, observation,
                                              entry["snapshot"]["state"], entry["variant"]))
                        if entry["variant"] == "control":
                            self.assertGreater(len(observation["candidates"]), 1)
                            if entry["template"] == "J2":
                                skip = next(item for item in observation["candidates"]
                                            if item.get("choiceIds") == [])
                                follow = client.request(op="step", action={**observation["decision"],
                                    "actionId": skip["id"]})["observation"]
                                self.assertIsNotNone(follow)
                                self.assertGreater(len(follow["candidates"]), 1)
            for entry in entries:
                if entry["variant"] == "positive" and entry["layer"] == "payoff":
                    result = probe(client, entry)
                    self.assertEqual(result["goalsCompleted"], result["goalsTotal"],
                                     msg=f"{entry['template']} blocked: {result['steps'][-1]}")
        finally:
            client.close()

    def test_us_west_placement_source_and_tactical_result_use_actual_unit_changes(self):
        snapshot = {"header": {"seed": 7}, "state": {"round": 2, "units": [], "decks": {}},
                    "decisionCount": 8}
        tracker = new_tracker("U1:positive:payoff", snapshot)
        before = {"node": "SOURCE", "units": [{"id": "it", "country": "italy",
                   "type": "army", "regionId": "italy"}]}
        after = {"units": [{"id": "us", "country": "united_states", "type": "army",
                 "regionId": "western_europe"}]}
        record_step(tracker, before, {"kind": "source", "definitionId": "special_111"},
                    after, None)
        result = summarize(tracker, {"winner": "allies",
                                   "allianceScores": {"axis": 1, "allies": 4}})
        self.assertEqual(result["westEuropeLandingSources"], {"patton": 1})
        self.assertTrue(result["tacticalResultAchieved"])
        self.assertEqual(result["scoreDifferenceAxisMinusAllies"], -3)
        landing = new_tracker("U3:positive:payoff", snapshot)
        record_step(landing, {"node": "ENGINE_CHOICE", "choiceKind": "TRIGGER",
                              "units": []},
                    {"kind": "choice", "choiceIds": ["landing"], "choices": [
                        {"kind": "trigger", "definitionId": "special_88"}]},
                    {"units": [{"id": "new", "country": "united_states", "type": "army",
                                "regionId": "western_europe"}]}, None)
        self.assertEqual(landing["westEuropeLandingSources"], {"landing_operation": 1})

    def test_checkpoint_identity_rejects_a_different_course_pool(self):
        client = ppo.ArenaClient(card_set="signals")
        try:
            encoder = ppo.Encoder(client.schema)
            model = make_network(A2S1_ADAPTER, encoder)
            optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
            config = {"version": VERSION, "poolFileSha256": "first"}
            kwargs = {"card_set": "signals", "training_seed": 20261004,
                      "experiment_id": "A2S1C1", "entropy_coefficient": .01,
                      "initial_weights_sha256": ppo.model_weights_sha256(model),
                      "architecture": A2S1_ADAPTER, "course_config": config}
            payload = ppo.checkpoint_payload(model, optimizer, encoder, client, "A", 1, 4,
                                             random.Random(3), 20261044,
                                             completed_episodes=40, **kwargs)
            with tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / "latest.pt"
                torch.save(payload, path)
                restored = ppo.restore_checkpoint(path, model, optimizer, encoder, client,
                    "A", random.Random(5), **kwargs)
                self.assertEqual(restored["update"], 1)
                with self.assertRaisesRegex(ValueError, "schema, mode, or rules"):
                    ppo.restore_checkpoint(path, model, optimizer, encoder, client,
                        "A", random.Random(5), **{**kwargs, "course_config":
                         {"version": VERSION, "poolFileSha256": "second"}})
        finally:
            client.close()

    def test_only_post_takeover_decisions_enter_trajectory(self):
        if not POOL.exists() or not (ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" /
                                     "initial.pt").exists():
            self.skipTest("Local ignored course pool or initializer is absent")
        with gzip.open(POOL, "rt", encoding="utf-8") as stream:
            entry = next(item for item in json.load(stream)["entries"] if
                         item["template"] == "G2" and item["variant"] == "positive" and
                         item["layer"] == "preparation")
        client = ppo.ArenaClient(card_set="signals")
        try:
            encoder = ppo.Encoder(client.schema)
            observation = client.request(op="restore", snapshot=entry["snapshot"])["observation"]
            expected, _ = encoder.encode(observation)
            initial = torch.load(ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" /
                                 "initial.pt", map_location="cpu", weights_only=False)
            model = make_network(A2S1_ADAPTER, encoder)
            model.load_state_dict(initial["modelState"], strict=True)
            task = {"jobId": "course-test", "seed": 123456, "policyVersion": 0,
                    "courseId": "G2:positive:preparation"}
            with tempfile.TemporaryDirectory() as temp:
                with TrajectoryStore("A", 1, root=Path(temp),
                                     read_limit=16 * 1024 * 1024) as store:
                    _, summaries, _ = collect_batch([client], encoder, model,
                        torch.device("cpu"), [task], "A", "signals", 20261004, 3000,
                        store=store, combo_entries={task["courseId"]: entry})
                    self.assertEqual(len(store), summaries[0]["decisions"])
                    self.assertEqual(summaries[0]["startDecisionCount"],
                                     entry["snapshot"]["decisionCount"])
                    self.assertGreater(summaries[0]["startDecisionCount"], 0)
                    self.assertTrue(torch.equal(store.load_batch([0])[0]["state"],
                                                expected.to(torch.float16)))
                    self.assertEqual(summaries[0]["termination"], "natural")
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
