import gzip
import json
import tempfile
import unittest
import random
from copy import deepcopy
from collections import Counter
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_combo_accept import probe
from scripts.ppo_combo_course import TEMPLATES, VERSION, pool_identity, read_pool, replay, ready
from scripts.ppo_combo_metrics import (new_tracker, record_step, summarize,
                                       preparation_metadata, aggregate)
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

    def test_real_settlement_provenance_and_normal_start_first_landing(self):
        if not POOL.exists():
            self.skipTest("Local ignored course pool is absent")
        with gzip.open(POOL, "rt", encoding="utf-8") as stream:
            entries = json.load(stream)["entries"]
        client = ppo.ArenaClient(card_set="signals")
        try:
            for name in ("G1", "G2", "G3", "U1", "U2", "U3", "J1", "J2"):
                entry = next(item for item in entries if item["template"] == name and
                             item["variant"] == "positive" and item["layer"] == "payoff")
                actual = probe(client, entry, combo_telemetry=True)
                tracker = new_tracker(f"{name}:positive:payoff", entry["snapshot"])
                for index, step in enumerate(actual["steps"]):
                    record_step(tracker, step["telemetry"], index)
                result = summarize(tracker, {"winner": "allies",
                    "allianceScores": {"axis": 1, "allies": 4}})
                self.assertTrue(result["tacticalResultAchieved"], name)
                # J1 ends at the linked Chinese East build; the card's later
                # attack still resolves by ordinary engine rules.
                self.assertTrue(result["specifiedComboAchieved"], name)
                if name == "U1":
                    self.assertEqual(result["firstUSWestEuropeLanding"]["source"], "patton")
                    self.assertEqual(result["pattonAttacksStarted"], 1)
                    self.assertEqual(result["pattonAttacksEffective"], 1)
                    self.assertEqual(result["scoreDifferenceAxisMinusAllies"], -3)
                    # A later ordinary attack is a separate settlement source,
                    # even if it removes a unit on the same board.
                    ordinary_attack = next(op for op in tracker["operations"] if
                        op["source"] == "special_111" and op["action"] == "land_battle").copy()
                    ordinary_attack["source"] = "land_battle"
                    tracker["operations"].append(ordinary_attack)
                    after_ordinary = summarize(tracker, {"winner": "allies",
                        "allianceScores": {"axis": 1, "allies": 4}})
                    self.assertEqual(after_ordinary["pattonAttacksStarted"], 1)
                    self.assertEqual(after_ordinary["pattonAttacksEffective"], 1)
                    normal = new_tracker(None, {"round": 1})
                    for index, step in enumerate(actual["steps"]):
                        record_step(normal, step["telemetry"], index)
                    self.assertEqual(summarize(normal, {"winner": "allies",
                        "allianceScores": {"axis": 1, "allies": 4}})["source"], "patton")
                    normal_summary = {"startType": "normal", "landing":
                        {"firstUSWestEuropeLanding": normal["firstUSWestEuropeLanding"],
                         "source": "patton"}, "decisions": len(actual["steps"]),
                        "winner": "allies"}
                    self.assertEqual(aggregate([normal_summary])["normal"]
                        ["firstLandingSources"], {"patton": 1})
                if name == "U3":
                    self.assertEqual(result["firstUSWestEuropeLanding"]["source"],
                                     "landing_operation")
        finally:
            client.close()

    def test_ordinary_attack_then_next_round_build_is_board_result_not_blitz_chain(self):
        with gzip.open(POOL, "rt", encoding="utf-8") as stream:
            entry = next(item for item in json.load(stream)["entries"] if
                item["template"] == "G1" and item["variant"] == "positive" and
                item["layer"] == "payoff")
        client = ppo.ArenaClient(card_set="signals")
        try:
            observation = client.request(op="restore", snapshot=entry["snapshot"],
                                         comboTelemetry=True)["observation"]
            tracker = new_tracker("G1:positive:payoff", entry["snapshot"])
            built = False
            for index in range(120):
                if index == 0:
                    chosen = next(candidate for candidate in observation["candidates"] if
                        candidate.get("definitionId") == "land_battle" and any(
                            feature.get("regionId") == "ukraine" for feature in
                            candidate.get("choices") or ()))
                elif index == 1:
                    self.assertEqual(observation["choiceKind"], "TRIGGER")
                    chosen = next(candidate for candidate in observation["candidates"] if
                                  candidate.get("choiceIds") == [])
                else:
                    chosen = next((candidate for candidate in observation["candidates"] if
                        observation["activeSeat"] == "germany" and
                        observation["node"] == "SOURCE" and
                        candidate.get("definitionId") == "build_army" and any(
                            feature.get("regionId") == "ukraine" for feature in
                            candidate.get("choices") or ())), None)
                    if chosen:
                        built = True
                    else:
                        chosen = next((candidate for candidate in observation["candidates"]
                                       if candidate["kind"] == "pass"),
                                      observation["candidates"][0])
                response = client.request(op="step", action={**observation["decision"],
                    "actionId": chosen["id"]}, comboTelemetry=True)
                record_step(tracker, response["comboTelemetry"], index)
                observation = response["observation"]
                if built:
                    break
            self.assertTrue(built)
            result = summarize(tracker, {"winner": "axis",
                "allianceScores": {"axis": 0, "allies": 0}})
            self.assertTrue(result["tacticalResultAchieved"])
            self.assertFalse(result["specifiedComboAchieved"])
            self.assertEqual(result["comboMatchedSteps"], 1)
        finally:
            client.close()

    def test_all_real_g1_starts_are_checked_without_splicing_partial_chains(self):
        with gzip.open(POOL, "rt", encoding="utf-8") as stream:
            entry = next(item for item in json.load(stream)["entries"] if
                item["template"] == "G1" and item["variant"] == "positive" and
                item["layer"] == "payoff")
        client = ppo.ArenaClient(card_set="signals")
        try:
            actual = probe(client, entry, combo_telemetry=True)
            tracker = new_tracker("G1:positive:payoff", entry["snapshot"])
            for index, step in enumerate(actual["steps"]):
                record_step(tracker, step["telemetry"], index)
            outcome = {"winner": "axis", "allianceScores": {"axis": 0, "allies": 0}}
            self.assertTrue(summarize(tracker, outcome)["specifiedComboAchieved"])
            first = next(op for op in tracker["operations"] if
                op["source"] == "land_battle" and op["action"] == "land_battle")
            earlier = {**deepcopy(first), "epoch": -1, "serial": 0,
                       "eventId": "event:earlier", "frameId": "frame:earlier"}
            with_earlier = deepcopy(tracker)
            with_earlier["operations"].insert(0, earlier)
            result = summarize(with_earlier, outcome)
            self.assertTrue(result["specifiedComboAchieved"])
            self.assertEqual(result["comboMatchedSteps"], 2)
            with_earlier["triggerDeclines"]["special_136"] += 1
            self.assertEqual(summarize(with_earlier, outcome)["comboStatus"], "complete")
            # Both attacks are genuine observed settlements, but neither is
            # an ancestor of this deliberately unrelated build.
            unrelated = deepcopy(with_earlier)
            build = next(op for op in unrelated["operations"] if op["source"] == "special_136")
            build["parentEventId"] = "event:another-action"
            build["ancestorIds"] = []
            result = summarize(unrelated, outcome)
            self.assertFalse(result["specifiedComboAchieved"])
            self.assertEqual(result["comboMatchedSteps"], 1)
        finally:
            client.close()

    def test_j1_goal_ends_at_linked_build_not_optional_followup_attack(self):
        with gzip.open(POOL, "rt", encoding="utf-8") as stream:
            entry = next(item for item in json.load(stream)["entries"] if
                item["template"] == "J1" and item["variant"] == "positive" and
                item["layer"] == "payoff")
        client = ppo.ArenaClient(card_set="signals")
        try:
            actual = probe(client, entry, combo_telemetry=True)
            self.assertEqual((actual["goalsCompleted"], actual["goalsTotal"]), (3, 3))
            tracker = new_tracker("J1:positive:payoff", entry["snapshot"])
            for index, step in enumerate(actual["steps"]):
                record_step(tracker, step["telemetry"], index)
            outcome = {"winner": "axis", "allianceScores": {"axis": 0, "allies": 0}}
            result = summarize(tracker, outcome)
            self.assertTrue(result["specifiedComboAchieved"])
            self.assertEqual(result["comboRequiredSteps"], 2)
            self.assertFalse(any(op["source"] == "special_199" and
                op["action"] == "land_battle" and op["removed"]
                for op in tracker["operations"]))
            absent = deepcopy(tracker)
            absent["operations"] = [op for op in absent["operations"] if
                                    op["source"] != "special_199"]
            self.assertFalse(summarize(absent, outcome)["specifiedComboAchieved"])
            ordinary = deepcopy(tracker)
            for op in ordinary["operations"]:
                if op["source"] == "special_199" and op["action"] == "build_army":
                    op["source"] = "build_army"
            self.assertTrue(summarize(ordinary, outcome)["tacticalResultAchieved"])
            self.assertFalse(summarize(ordinary, outcome)["specifiedComboAchieved"])
            unrelated_response = deepcopy(tracker)
            for op in unrelated_response["operations"]:
                if op["source"] == "special_199" and op["action"] == "build_army":
                    op["parentEventId"] = "event:unrelated"
                    op["ancestorIds"] = []
            self.assertFalse(summarize(unrelated_response, outcome)["specifiedComboAchieved"])
        finally:
            client.close()

    def test_real_chinese_card_types_and_preparation_install_completion(self):
        with gzip.open(POOL, "rt", encoding="utf-8") as stream:
            entries = [item for item in json.load(stream)["entries"] if
                item["template"] in ("G1", "J2") and item["variant"] == "positive" and
                item["layer"] == "payoff"]
        client = ppo.ArenaClient(card_set="signals")
        try:
            with tempfile.TemporaryDirectory() as directory:
                results = preparation_metadata(POOL, entries, client,
                                               Path(directory) / "metrics.json")
            status = results["G1:positive:payoff"]["installations"]
            responses = results["J2:positive:payoff"]["installations"]
            self.assertEqual([(item["definitionId"], item["type"], item["zone"])
                for item in status], [("special_136", "status", "active")])
            self.assertEqual([(item["definitionId"], item["type"], item["zone"])
                for item in responses], [("special_190", "response", "faceDown"),
                                         ("special_189", "response", "faceDown")])
            self.assertTrue(all(item["stage"] == "pre_takeover" for item in status + responses))
        finally:
            client.close()

    def test_first_landing_is_not_overwritten_and_pre_takeover_is_separate(self):
        with gzip.open(POOL, "rt", encoding="utf-8") as stream:
            entry = next(item for item in json.load(stream)["entries"] if
                item["template"] == "U1" and item["variant"] == "positive" and
                item["layer"] == "payoff")
        client = ppo.ArenaClient(card_set="signals")
        try:
            steps = probe(client, entry, combo_telemetry=True)["steps"]
            tracker = new_tracker("U1:positive:payoff", entry["snapshot"],
                {"firstUSWestEuropeLanding": {"source": "basic_build",
                 "sourceCardId": "build_army", "unitId": "earlier", "round": 2,
                 "decisionId": 9, "stage": "pre_takeover"}})
            for index, step in enumerate(steps):
                record_step(tracker, step["telemetry"], index)
            self.assertEqual(tracker["firstUSWestEuropeLanding"]["source"], "basic_build")
            self.assertEqual(tracker["firstUSWestEuropeLanding"]["stage"], "pre_takeover")
            self.assertEqual(tracker["postTakeoverFirstUSWestEuropeLanding"]["source"], "patton")
            normal = new_tracker(None, {"round": 1})
            for index, step in enumerate(steps):
                record_step(normal, step["telemetry"], index)
            first = normal["firstUSWestEuropeLanding"].copy()
            for index, step in enumerate(steps):
                record_step(normal, step["telemetry"], index + len(steps))
            self.assertEqual(normal["firstUSWestEuropeLanding"], first)
        finally:
            client.close()

    def test_real_pre_takeover_landing_source_is_replayed_from_preparation(self):
        with gzip.open(POOL, "rt", encoding="utf-8") as stream:
            entry = next(item for item in json.load(stream)["entries"] if
                item["template"] == "G2" and item["variant"] == "positive" and
                item["layer"] == "payoff")
        client = ppo.ArenaClient(card_set="signals")
        try:
            with tempfile.TemporaryDirectory() as directory:
                metadata = preparation_metadata(POOL, [entry], client,
                                                Path(directory) / "prep.json")
            first = metadata["G2:positive:payoff"]["firstUSWestEuropeLanding"]
            self.assertEqual(first["source"], "basic_build")
            tracker = new_tracker("G2:positive:payoff", entry["snapshot"],
                                  metadata["G2:positive:payoff"])
            self.assertEqual(tracker["firstUSWestEuropeLanding"]["stage"], "pre_takeover")
        finally:
            client.close()

    def test_compact_telemetry_does_not_change_rules_choices_or_rewards(self):
        def without_session_ids(value):
            if isinstance(value, dict):
                return {key: without_session_ids(item) for key, item in value.items()
                        if key not in ("episodeId", "gameId")}
            if isinstance(value, list):
                return [without_session_ids(item) for item in value]
            return value
        plain = ppo.ArenaClient(card_set="signals")
        measured = ppo.ArenaClient(card_set="signals")
        try:
            self.assertEqual(plain.fingerprint, measured.fingerprint)
            ordinary = plain.request(op="reset", seed=786, mode="A", cardSet="signals")
            instrumented = measured.request(op="reset", seed=786, mode="A",
                                            cardSet="signals", comboTelemetry=True)
            self.assertEqual(without_session_ids(ordinary["observation"]),
                             without_session_ids(instrumented["observation"]))
            candidate = ordinary["observation"]["candidates"][0]
            left = plain.request(op="step", action={**ordinary["observation"]["decision"],
                "actionId": candidate["id"]})
            right = measured.request(op="step", action={**instrumented["observation"]["decision"],
                "actionId": candidate["id"]}, comboTelemetry=True)
            self.assertEqual(without_session_ids(left["observation"]),
                             without_session_ids(right["observation"]))
            self.assertEqual(without_session_ids(left["info"]),
                             without_session_ids(right["info"]))
            self.assertEqual(without_session_ids(left["result"]),
                             without_session_ids(right["result"]))
            self.assertEqual(right["comboTelemetry"]["version"], "combo-settlement-v1")
        finally:
            plain.close()
            measured.close()

    def test_real_post_takeover_status_install_and_status_action_separation(self):
        client = ppo.ArenaClient(card_set="signals")
        try:
            observation = client.request(op="reset", seed=786, mode="A",
                                         cardSet="signals", comboTelemetry=True)["observation"]
            candidate = next(item for item in observation["candidates"] if
                             item.get("definitionId") == "special_136")
            response = client.request(op="step", action={**observation["decision"],
                "actionId": candidate["id"]}, comboTelemetry=True)
            tracker = new_tracker(None, observation)
            record_step(tracker, response["comboTelemetry"], 0)
            self.assertEqual(tracker["modelInstallSelections"], {"status": 1})
            self.assertEqual([(item["definitionId"], item["zone"]) for item in
                              tracker["modelInstallations"]], [("special_136", "active")])
            # A pre-existing status' replacement action has statusAction=true;
            # it is a use, never another hand-to-active installation.
            alternative = {**response["comboTelemetry"], "selected": {
                **response["comboTelemetry"]["selected"], "statusAction": True,
                "fromZone": {"seat": "germany", "zone": "active"}}, "commits": []}
            record_step(tracker, alternative, 1)
            self.assertEqual(len(tracker["modelInstallations"]), 1)
            self.assertEqual(tracker["statusActions"]["special_136"], 1)
        finally:
            client.close()

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
