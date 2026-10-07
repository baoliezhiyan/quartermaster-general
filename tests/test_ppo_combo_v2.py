"""Bounded, real-arena checks for the second combo course."""
import copy
import gzip
import json
import tempfile
import unittest
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts import ppo_combo_bc as bc
from scripts import ppo_combo_course as first
from scripts import ppo_combo_course_v2 as second
from scripts import ppo_parallel as parallel
from scripts.ppo_combo_accept import probe
from scripts.ppo_combo_metrics import new_tracker, record_step, summarize
from scripts.ppo_combo_v2_diagnose import compare
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network
from scripts.ppo_combo_v2_prepare import reviewed_build_migration


PARENT = ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" / "latest.pt"


class ComboV2Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not PARENT.exists():
            raise unittest.SkipTest("Local A2S1C1 update-30 parent is absent")
        torch.set_num_threads(2)
        cls.client = ppo.ArenaClient(card_set="signals")
        cls.encoder = ppo.Encoder(cls.client.schema)
        cls.model, cls.weights = first.load_parent(PARENT, cls.encoder, torch.device("cpu"))

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "client"):
            cls.client.close()

    def test_parent_is_update_30_and_schema_unchanged(self):
        saved = torch.load(PARENT, map_location="cpu", weights_only=False)
        self.assertEqual((saved["experimentId"], saved["update"],
                          saved["completedEpisodes"]), ("A2S1C1", 30, 1200))
        self.assertEqual(saved["networkArchitecture"], A2S1_ADAPTER)
        migration = reviewed_build_migration(PARENT, saved, self.client)
        self.assertEqual(migration["currentBuildFingerprint"], self.client.fingerprint)
        self.assertEqual(saved["rewardConfig"], ppo.reward_config("signals"))
        self.assertEqual(self.weights, ppo.model_weights_sha256(self.model))

    def test_status_target_and_resource_counterfactuals_reach_actual_tensor(self):
        pool = (ppo.ROOT / "PPO训练" / ".state" / "A2S1C2" /
            "course-pool-v2-failed-audit.json.gz")
        if not pool.exists():
            self.skipTest("Historical failed C2 pool is stored outside Git")
        # 1.8.2 changed the build identity. Historical C1 snapshots must not
        # be restored into the current arena, even though the reviewed model
        # weights and vector dimensions remain migratable.
        with gzip.open(pool, "rt", encoding="utf-8") as stream:
            old = json.load(stream)["entries"][0]
        with self.assertRaisesRegex(RuntimeError, "Incompatible PPO snapshot"):
            self.client.request(op="restore", snapshot=old["snapshot"])

    def test_nine_template_schedule_and_training_only_starts(self):
        entries = {}
        for template in second.TEMPLATES:
            for variant in ("positive", "control"):
                for layer in ("payoff", "preparation"):
                    for seed, split in ((1, "train"), (2, "evaluation")):
                        key = f"{template.key}:{variant}:{layer}:{seed}"
                        entries[key] = {"split": split}
        seen = set()
        layers = {key: set() for key in second.BY_KEY}
        for update in range(1, 7):
            tasks = parallel.make_tasks(1000 + 40 * update, 40, update, "A", entries,
                                        "A2S1C2")
            self.assertEqual(sum("courseId" not in t for t in tasks), 28)
            self.assertEqual(sum("courseId" in t for t in tasks), 12)
            self.assertEqual(sum(":preparation:" in t.get("courseId", "") for t in tasks), 4)
            self.assertTrue(all(t["courseId"].endswith(":1") for t in tasks[28:]))
            for task in tasks[28:]:
                template, _, layer, _ = task["courseId"].split(":")
                seen.add(template)
                layers[template].add(layer)
        self.assertEqual(seen, set(second.BY_KEY))
        self.assertTrue(all(value == {"payoff", "preparation"} for value in layers.values()))

    def test_partial_pool_cannot_enter_training_and_atomic_completion(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "course.json.gz"
            identity = {"identitySha256": "fixed"}
            second.write_pool(path, identity, [{"courseId": "G1:positive:payoff:1"}],
                              [], complete=False)
            with self.assertRaisesRegex(ValueError, "partial"):
                second.read_pool(path, identity)
            second.write_pool(path, identity, [{"courseId": "G1:positive:payoff:1"}],
                              [], complete=True)
            self.assertEqual(len(second.read_pool(path, identity)["entries"]), 1)

    def test_us_shipyard_real_two_turn_route_and_replay(self):
        result = second.generate_one(self.client, self.encoder, self.model,
            torch.device("cpu"), second.BY_KEY["U4"], 2026100500, "positive")
        self.assertNotIn("failure", result)
        self.assertEqual(result["preparation"]["round"], 1)
        observation = self.client.request(op="restore", snapshot=result[
            "preparation"]["snapshot"])["observation"]
        self.assertEqual(second.teaching_target(second.BY_KEY["U4"], observation,
            result["preparation"]["snapshot"]["state"])[0], "special_84")
        reasons = [item["scriptReason"] for item in result["trace"]]
        self.assertIn("u4_install_or_direct", reasons)
        entry = {**result, "layer": "payoff", "courseId": "U4:positive:payoff:2026100500"}
        first.replay(self.client, entry)
        check = probe(self.client, entry)
        self.assertEqual(check["goalsCompleted"], check["goalsTotal"])
        self.assertEqual(result["snapshot"]["state"]["round"], 2)
        actual = probe(self.client, entry, combo_telemetry=True)
        tracker = new_tracker(entry["courseId"], entry["snapshot"])
        for offset, step in enumerate(actual["steps"]):
            record_step(tracker, step["telemetry"], offset)
        summary = summarize(tracker, {"winner": "allies",
            "allianceScores": {"axis": 0, "allies": 0}})
        self.assertTrue(summary["specifiedComboAchieved"])

    def test_u4_heldout_route_uses_legal_visible_prelude(self):
        generator_path = ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" / "initial.pt"
        generator, _ = first.load_parent(generator_path, self.encoder, torch.device("cpu"))
        training = second.generate_one(self.client, self.encoder, generator,
            torch.device("cpu"), second.BY_KEY["U4"], 2026108400, "positive")
        heldout = second.generate_one(self.client, self.encoder, generator,
            torch.device("cpu"), second.BY_KEY["U4"], 2026108440, "positive",
            heldout=True)
        self.assertNotIn("failure", training)
        self.assertNotIn("failure", heldout)
        self.assertIn("heldout_u4_legal_axis_deployment",
            [step["scriptReason"] for step in heldout["trace"]])
        starts = []
        for result in (training, heldout):
            observation = self.client.request(op="restore", snapshot=result[
                "preparation"]["snapshot"])["observation"]
            starts.append(second.encoded_scene_key(self.encoder, observation))
        self.assertNotEqual(starts[0], starts[1])
        first.replay(self.client, {**heldout, "layer": "payoff"})
        resolved = probe(self.client, {**heldout, "layer": "payoff"}, combo_telemetry=True)
        self.assertEqual(resolved["goalsCompleted"], resolved["goalsTotal"])

    def test_german_forced_generator_opening_is_legal_and_outside_ppo(self):
        result = second.generate_one(self.client, self.encoder, self.model,
            torch.device("cpu"), second.BY_KEY["G1"], 2026100504, "positive")
        self.assertNotIn("failure", result)
        reasons = [step["scriptReason"] for step in result["trace"]]
        self.assertIn("white_plan", reasons)
        self.assertIn("arden_extra_card", reasons)
        self.assertGreaterEqual(result["preparation"]["round"], 2)
        first.replay(self.client, {**result, "layer": "payoff"})

    def test_g3_near_preparation_and_patton_event_reachable(self):
        generator_path = ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" / "initial.pt"
        generator, _ = first.load_parent(generator_path, self.encoder, torch.device("cpu"))
        for key, seed in (("G3", 2026102406), ("U1", 2026103400)):
            with self.subTest(key=key):
                result = second.generate_one(self.client, self.encoder, generator,
                    torch.device("cpu"), second.BY_KEY[key], seed, "positive")
                self.assertNotIn("failure", result)
                entry = {**result, "layer": "payoff",
                    "courseId": f"{key}:positive:payoff:{seed}"}
                first.replay(self.client, entry)
                check = probe(self.client, entry, combo_telemetry=True)
                self.assertEqual(check["goalsCompleted"], check["goalsTotal"])
                self.assertTrue(second._specified_chain(entry, check))
                if key == "G3":
                    self.assertIn("white_plan", [item["scriptReason"] for item in result["trace"]])
                    self.assertGreaterEqual(result["preparation"]["round"], 2)
                    self.assertLessEqual(result["snapshot"]["state"]["round"] -
                        result["preparation"]["round"], 2)

    def test_pacific_response_route_uses_paid_legal_near_preparation(self):
        generator_path = ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" / "initial.pt"
        generator, _ = first.load_parent(generator_path, self.encoder, torch.device("cpu"))
        result = second.generate_one(self.client, self.encoder, generator,
            torch.device("cpu"), second.BY_KEY["U2"], 2026104430, "positive",
            rng_salt=0xC0B0)
        self.assertNotIn("failure", result)
        self.assertIn(result["preparation"]["target"], result["preparation"]["missing"])
        entry = {**result, "layer": "payoff",
            "courseId": "U2:positive:payoff:2026104430"}
        first.replay(self.client, entry)
        check = probe(self.client, entry, combo_telemetry=True)
        self.assertEqual(check["goalsCompleted"], check["goalsTotal"])
        self.assertTrue(second._specified_chain(entry, check))

    def test_bc_uses_only_script_labels_and_does_not_edit_parent(self):
        self.assertFalse(bc.is_training_label({"template": "G3", "variant": "positive"},
            {"scripted": True}, "special_84"))
        self.assertFalse(bc.is_training_label({"template": "U2", "variant": "positive"},
            {"scripted": True}, "special_78"))
        self.assertFalse(bc.is_training_label({"template": "G2", "variant": "positive"},
            {"scripted": True}, "special_136"))
        self.assertTrue(bc.is_training_label({"template": "U2", "variant": "positive"},
            {"scripted": True}, "special_88"))
        self.assertTrue(bc.is_training_label({"template": "U4", "variant": "positive"},
            {"scripted": True}, "special_84"))
        self.assertFalse(bc.is_training_label({"template": "U4", "variant": "control"},
            {"scripted": True}, "special_84"))
        result = second.generate_one(self.client, self.encoder, self.model,
            torch.device("cpu"), second.BY_KEY["U4"], 2026100500, "positive")
        control = second.generate_one(self.client, self.encoder, self.model,
            torch.device("cpu"), second.BY_KEY["U4"], 2026100500, "control")
        self.assertNotIn("failure", result)
        self.assertNotIn("failure", control)
        entries = []
        for variant, item in (("positive", result), ("control", control)):
            entries.append({**item, "template": "U4", "variant": variant,
                            "split": "train", "layer": "payoff",
                            "courseId": f"U4:{variant}:payoff:2026100500"})
        before = ppo.model_weights_sha256(self.model)
        labels, controls, evidence = bc.extract(self.client, self.encoder, self.model, entries)
        self.assertGreaterEqual(len(labels), 1)
        self.assertTrue(all(item["metadata"]["cardId"] == "special_84" for item in labels))
        self.assertGreaterEqual(evidence["identicalRouteComparisonsExcluded"], 1)
        self.assertEqual(bc.validate_supervision(labels, controls)["routeOverlap"], 0)
        with torch.no_grad():
            for item, logits, value in bc._forward_many(self.model, labels + controls,
                                                         batch_size=3):
                single_logits, single_value = bc._forward(self.model, item)
                self.assertTrue(torch.allclose(logits, single_logits, atol=1e-5))
                self.assertTrue(torch.allclose(value, single_value, atol=1e-5))
        candidate = make_network(A2S1_ADAPTER, self.encoder)
        candidate.load_state_dict(copy.deepcopy(self.model.state_dict()))
        outcome = bc.adapt(candidate, labels, controls, config={"maxSteps": 2})
        self.assertEqual(len(outcome["history"]), 2)
        self.assertEqual(ppo.model_weights_sha256(self.model), before)

    def test_heldout_gate_requires_each_registered_lesson(self):
        rows = []
        for template, card in bc.TEACHING_TARGETS.items():
            rows.append({"template": template, "cardId": card,
                "variant": "positive", "beforeProbability": .01,
                "afterProbability": .011})
        self.assertFalse(bc.summarize_holdout(rows)["accepted"])
        labels = [{"metadata": {"courseId": f"{template}:positive:payoff:1",
            "cardId": card}} for template, card in bc.TEACHING_TARGETS.items()]
        self.assertTrue(bc.summarize_holdout(rows, labels)["accepted"])
        self.assertFalse(bc.summarize_holdout(rows[:-1], labels)["accepted"])

    def test_identical_encoded_scenes_cannot_have_opposite_labels(self):
        zero = torch.zeros(3)
        candidate = torch.zeros((2, 4))
        a = {"state": zero, "candidates": candidate, "chosen": 0}
        b = {"state": zero.clone(), "candidates": candidate.clone(), "chosen": 1}
        with self.assertRaisesRegex(ValueError, "Conflicting supervised"):
            bc.validate_supervision([a, b], [])
        self.assertEqual(bc.validate_supervision([a], [b])["routeOverlap"], 1)

    def test_preparation_stops_before_target_installation(self):
        generator_path = ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" / "initial.pt"
        generator, _ = first.load_parent(generator_path, self.encoder, torch.device("cpu"))
        for key, seed in (("G1", 2026100400), ("G3", 2026102404),
                          ("U2", 2026104430), ("U3", 2026105401)):
            with self.subTest(key=key):
                result = second.generate_one(self.client, self.encoder, generator,
                    torch.device("cpu"), second.BY_KEY[key], seed, "positive",
                    rng_salt=0xC0B0 if key == "U2" else 0xC2C2)
                self.assertNotIn("failure", result)
                prep = result["preparation"]
                self.assertTrue(prep["target"])
                self.assertIn(prep["target"], prep["missing"])
                entry = {**result, "snapshot": prep["snapshot"], "layer": "preparation",
                    "preparationTarget": prep["target"],
                    "preparationCandidateId": prep["candidateId"],
                    "preparationMissing": prep["missing"]}
                second.validate_preparation(self.client, entry)

    def test_patton_event_yields_verified_direct_label(self):
        generator_path = ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" / "initial.pt"
        generator, _ = first.load_parent(generator_path, self.encoder, torch.device("cpu"))
        result = second.generate_one(self.client, self.encoder, generator,
            torch.device("cpu"), second.BY_KEY["U1"], 2026103400, "positive")
        self.assertNotIn("failure", result)
        entry = {**result, "template": "U1", "variant": "positive",
            "split": "train", "layer": "payoff",
            "courseId": "U1:positive:payoff:2026103400"}
        labels, _, evidence = bc.extract(self.client, self.encoder, self.model, [entry])
        self.assertTrue(any(item["metadata"]["cardId"] == "special_111" for item in labels))
        self.assertEqual(evidence["verifiedPayoffs"][0]["completedGoals"],
                         evidence["verifiedPayoffs"][0]["totalGoals"])


if __name__ == "__main__":
    unittest.main()
