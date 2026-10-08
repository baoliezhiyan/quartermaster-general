"""C3 candidate identity, safe planning and read-only linked settlement tests."""
from __future__ import annotations

import contextlib
import gzip
import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import torch

from scripts import ppo_combo_c3_rounds as c3
from scripts import ppo_combo_c3_metrics as metrics
from scripts import ppo_combo_metrics as base
from scripts import ppo_parallel as parallel
from scripts import ppo_train as ppo
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network


def _op(serial, source, action, region, *, event=None, parent=None, added=(),
        removed=(), round_number=2, epoch=1):
    return {"serial": serial, "epoch": epoch, "eventId": event or f"ev{serial}",
        "parentEventId": parent, "ancestorIds": [parent] if parent else [],
        "source": source, "action": action, "region": region,
        "added": list(added), "removed": list(removed),
        "afterRegionUnits": list(added), "round": round_number,
        "decisionId": serial}


class C3MetricsTest(unittest.TestCase):
    def test_linked_blitz_and_unrelated_build(self):
        enemy = {"country": "soviet_union", "type": "army", "regionId": "ukraine"}
        german = {"country": "germany", "type": "army", "regionId": "ukraine"}
        attack = _op(1, "land_battle", "land_battle", "ukraine", removed=(enemy,))
        ordinary = _op(2, "build_army", "build_army", "ukraine", added=(german,))
        self.assertEqual(metrics.linked_settlements([attack, ordinary])["special_136"], [])
        blitz = _op(3, "special_136", "build_army", "ukraine",
                    parent="ev1", added=(german,))
        linked = metrics.linked_settlements([attack, ordinary, blitz])["special_136"]
        self.assertEqual(len(linked), 1)
        self.assertTrue(linked[0]["courseTarget"])

    def test_shipyard_generic_and_north_sea_course_target_are_separate(self):
        west = {"country": "united_states", "type": "navy",
                "regionId": "sea_east_pacific"}
        north = {"country": "united_states", "type": "navy",
                 "regionId": "sea_north_pacific"}
        attack = _op(1, "build_navy", "build_navy", "sea_east_pacific", added=(west,))
        build = _op(2, "special_84", "build_navy", "sea_north_pacific",
                    parent="ev1", added=(north,))
        result = metrics.linked_settlements([attack, build])["special_84"]
        self.assertEqual(len(result), 1)
        self.assertFalse(result[0]["courseTarget"])

    def test_china_requires_same_source_linked_attack_and_recruit(self):
        china = {"country": "china", "type": "army", "regionId": "eastern_china"}
        japan = {"country": "japan", "type": "army", "regionId": "eastern_china"}
        attack = _op(1, "land_battle", "land_battle", "eastern_china", removed=(china,))
        ordinary = _op(2, "build_army", "build_army", "eastern_china", added=(japan,))
        self.assertFalse(metrics.linked_settlements([attack, ordinary])["special_199"])
        response = _op(3, "special_199", "build_army", "eastern_china",
                       parent="ev1", added=(japan,))
        self.assertEqual(len(metrics.linked_settlements([attack, response])["special_199"]), 1)

    def test_window_dedup_skip_and_preinstalled_not_autonomous(self):
        tracker = base.new_tracker(None, {"round": 1}, detail=True)
        telemetry = {"version": "combo-settlement-v1", "round": 2,
            "decisionSeat": "germany", "activeSeat": "germany",
            "choiceKind": "TRIGGER", "offeredTriggers": ["special_136"],
            "selected": {"choiceIds": [], "kind": "choice"}, "commits": []}
        base.record_step(tracker, telemetry, 42)
        base.record_step(tracker, telemetry, 42)
        result = metrics.summarize_detail(tracker, {"jobId": "one"}, 0)
        self.assertEqual(result["cards"]["special_136"]["legalTriggerWindows"], 1)
        self.assertEqual(result["cards"]["special_136"]["declinedWindows"], 1)
        self.assertIsNone(result["cards"]["special_84"]["activationRate"])
        self.assertFalse(result["cards"]["special_136"]["autonomousInstallations"])

    def test_countered_effect_is_separate_from_voluntary_skip(self):
        tracker = base.new_tracker(None, {"round": 1}, detail=True)
        tracker["cancellations"].append({"source": "special_136", "epoch": 1,
            "eventId": "cancelled", "parentEventId": "attack",
            "ancestorIds": ["root"]})
        tracker["opponentTriggers"].append({"cardId": "other-response",
            "parents": [(1, "attack")]})
        result = metrics.summarize_detail(tracker, {"jobId": "one"}, 0)["cards"]["special_136"]
        self.assertEqual(result["opponentCounterConfirmed"], 1)
        self.assertEqual(result["declinedWindows"], 0)

    def test_normal_and_course_groups_remain_separate(self):
        items = []
        for course_id in (None, "G1:positive:preparation:0", "G1:positive:payoff:0"):
            tracker = base.new_tracker(None, {"round": 1}, detail=True)
            item = metrics.summarize_detail(tracker, {"courseId": course_id}, 0)
            items.append({"comboDetail": item})
        result = metrics.aggregate_detail(items)["groups"]
        self.assertEqual({key: value["episodes"] for key, value in result.items()},
                         {"normal": 1, "preparation": 1, "payoff": 1})
        one = metrics.aggregate_detail(items)
        merged = metrics.merge_update_summaries([one, one])
        self.assertEqual(merged["groups"]["normal"]["episodes"], 2)
        self.assertIsNone(merged["groups"]["normal"]["cards"]["special_136"]["activationRate"])


class C3IdentityTest(unittest.TestCase):
    def test_wrong_candidate_or_pool_hash_is_rejected(self):
        actual = c3.sha
        for wrong_path in (c3.CANDIDATE, c3.POOL):
            with self.subTest(path=wrong_path), patch.object(c3, "sha",
                side_effect=lambda path, wrong=wrong_path:
                    "0" * 64 if Path(path) == wrong else actual(path)):
                with self.assertRaisesRegex(ValueError, "source candidate|course pool"):
                    c3.identity()

    def test_real_arena_takeover_and_telemetry_are_read_only(self):
        _, entries, _ = c3.identity()
        entry = next(item for item in entries if item["template"] == "G1" and
                     item["variant"] == "positive" and item["layer"] == "payoff" and
                     item["split"] == "evaluation")
        client = ppo.ArenaClient(card_set="signals")
        try:
            before = entry["snapshot"]["state"]
            observation = client.request(op="restore", snapshot=entry["snapshot"],
                                         comboTelemetry=True)["observation"]
            tracker = base.new_tracker(entry["courseId"], entry["snapshot"], detail=True)
            selected = observation["candidates"][0]
            result = client.request(op="step", action={**observation["decision"],
                                     "actionId": selected["id"]}, comboTelemetry=True)
            base.record_step(tracker, result["comboTelemetry"],
                             observation["decision"]["decisionId"])
            detail = metrics.summarize_detail(tracker,
                {"courseId": entry["courseId"]}, 0)
            self.assertEqual(detail["startType"], "payoff")
            self.assertEqual(result["comboTelemetry"]["version"], "combo-settlement-v1")
            self.assertEqual(entry["snapshot"]["state"], before)
            self.assertEqual(detail["cards"]["special_136"]["autonomousInstallations"], 0)
        finally:
            client.close()

    def test_reviewed_candidate_and_independent_optimizer(self):
        self.assertEqual(c3.sha(c3.CANDIDATE), c3.CANDIDATE_FILE_SHA)
        self.assertEqual(c3.sha(c3.POOL), c3.POOL_SHA)
        initial, entries, config = c3.identity()
        self.assertEqual(initial["weightsSha256"], c3.CANDIDATE_WEIGHTS_SHA)
        self.assertEqual(initial["optimizerMigration"], "new-Adam-no-old-momentum")
        self.assertNotIn("optimizerState", initial)
        self.assertEqual(len({entry["template"] for entry in entries}), 9)
        client = ppo.ArenaClient(card_set="signals")
        try:
            encoder = ppo.Encoder(client.schema)
            model = make_network(A2S1_ADAPTER, encoder)
            model.load_state_dict(initial["modelState"], strict=True)
            optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
            self.assertEqual(len(optimizer.state), 0)
            self.assertEqual(ppo.model_weights_sha256(model), c3.CANDIDATE_WEIGHTS_SHA)
        finally:
            client.close()

    def test_quota_and_training_split(self):
        _, entries, _ = c3.identity()
        index = {entry["courseId"]: entry for entry in entries}
        tasks = parallel.make_tasks(c3.SEED, 40, 1, "A", index, "A2S1C3")
        self.assertEqual(sum("courseId" in task for task in tasks), 12)
        self.assertEqual(sum("courseId" not in task for task in tasks), 28)
        self.assertTrue(all(index[task["courseId"]]["split"] == "train"
                            for task in tasks if "courseId" in task))
        self.assertEqual(len({task["seed"] for task in tasks}), 40)

    def test_interactive_show_and_exit_never_train(self):
        with patch("builtins.input", side_effect=["1"]), patch.object(c3, "run") as run:
            with patch("sys.argv", ["c3", "interactive"]), contextlib.redirect_stdout(io.StringIO()):
                c3.main()
            self.assertEqual(run.call_args.args[0].command, "show")
        with patch("builtins.input", side_effect=["4"]), patch.object(c3, "run") as run:
            with patch("sys.argv", ["c3", "interactive"]), contextlib.redirect_stdout(io.StringIO()):
                c3.main()
            run.assert_not_called()

    def test_preview_new_plan_has_no_progress_or_baseline_side_effect(self):
        initial = {"weightsSha256": c3.CANDIDATE_WEIGHTS_SHA}
        config = {"version": "fixed"}
        with tempfile.TemporaryDirectory() as directory:
            plan = Path(directory) / "plan.json"
            with (patch.object(c3, "identity", return_value=(initial, [], config)),
                  patch.object(c3, "progress", return_value=0),
                  patch.object(c3, "output_rounds", return_value=0),
                  patch.object(c3, "show"),
                  patch.object(c3, "ensure_baseline") as baseline,
                  patch.object(c3, "complete_round") as complete,
                  patch.object(c3, "PLAN", plan)):
                c3.run(SimpleNamespace(command="new", rounds=1, dry_run=True))
                self.assertFalse(plan.exists())
                baseline.assert_not_called()
                self.assertEqual(complete.call_args.args[0], 1)
                self.assertTrue(complete.call_args.kwargs["dry_run"])

    def test_resume_existing_target_does_not_add_budget(self):
        initial = {"weightsSha256": c3.CANDIDATE_WEIGHTS_SHA}
        config = {"version": "fixed"}
        with tempfile.TemporaryDirectory() as directory:
            plan = Path(directory) / "plan.json"
            plan.write_text(json.dumps({"format": "a2s1c3-round-plan-v1",
                "fromRound": 1, "targetRound": 2,
                "initialWeightsSha256": c3.CANDIDATE_WEIGHTS_SHA,
                "courseConfigSha256": hashlib.sha256(json.dumps(config,
                    sort_keys=True).encode()).hexdigest(), "trainingSeed": c3.SEED}))
            with (patch.object(c3, "identity", return_value=(initial, [], config)),
                  patch.object(c3, "progress", return_value=1),
                  patch.object(c3, "show"),
                  patch.object(c3, "ensure_baseline") as baseline,
                  patch.object(c3, "complete_round") as complete,
                  patch.object(c3, "PLAN", plan)):
                c3.run(SimpleNamespace(command="continue", rounds=None, dry_run=True))
                self.assertEqual([call.args[0] for call in complete.call_args_list], [1, 2])
                self.assertEqual(json.loads(plan.read_text())["targetRound"], 2)
                baseline.assert_not_called()


if __name__ == "__main__":
    unittest.main()
