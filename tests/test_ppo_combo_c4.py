"""C4 quota, migration and actual zone-confirmed preparation regressions."""
from __future__ import annotations

from collections import Counter
import unittest

from scripts import ppo_combo_c4_rounds as c4
from scripts import ppo_combo_metrics as metrics
from scripts import ppo_combo_c3_metrics as detail_metrics
from scripts import ppo_parallel as parallel
from scripts.ppo_combo_course_v2 import course_id
from scripts.ppo_combo_sampler_v2 import outcome_summary, plan
from scripts import ppo_train as ppo


class C4SamplerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.initial, cls.entries, cls.config = c4.identity()
        cls.index = {course_id(entry): entry for entry in cls.entries}

    def test_completed_parent_and_new_optimizer(self):
        self.assertEqual(c4.sha(c4.PARENT), c4.PARENT_SHA)
        self.assertEqual(self.initial["sourceUpdate"], 20)
        self.assertEqual(self.initial["sourceCompletedEpisodes"], 800)
        self.assertEqual(self.initial["optimizerMigration"], "new-Adam-no-old-momentum")
        self.assertNotIn("optimizerState", self.initial)

    def test_each_quota_and_full_coverage_by_update_five(self):
        seen = Counter()
        for update in range(1, 6):
            tasks = parallel.make_tasks(c4.SEED + 40 * (update - 1), 40, update,
                                        "A", self.index, "A2S1C4")
            courses = [task["courseId"] for task in tasks if task.get("courseId")]
            self.assertEqual(len(courses), 20)
            self.assertEqual(sum(not task.get("courseId") for task in tasks), 20)
            self.assertEqual(sum(key.startswith("G1:positive:preparation:") for key in courses), 2)
            self.assertEqual(sum(key.startswith("U4:positive:preparation:") for key in courses), 2)
            self.assertEqual(sum(key.startswith("J1:positive:preparation:") for key in courses), 2)
            self.assertEqual(Counter((self.index[key]["variant"],
                self.index[key]["layer"]) for key in courses), {
                    ("positive", "preparation"): 9, ("control", "preparation"): 3,
                    ("positive", "payoff"): 6, ("control", "payoff"): 2})
            self.assertTrue(all(self.index[key]["split"] == "train" for key in courses))
            seen.update(":".join(key.split(":")[:3]) for key in courses)
            self.assertEqual(tasks, parallel.make_tasks(c4.SEED + 40 * (update - 1),
                40, update, "A", self.index, "A2S1C4"))
        self.assertEqual(set(seen), {":".join(key.split(":")[:3]) for key, entry in
            self.index.items() if entry["split"] == "train"})
        self.assertEqual(plan(self.index, 5)["missingCombinations"], [])

    def test_resume_reconstructs_independent_start_cursor(self):
        first = plan(self.index, 11)
        resumed = plan(dict(reversed(list(self.index.items()))), 11)
        self.assertEqual(first, resumed)
        self.assertNotEqual(first["courseIds"], plan(self.index, 10)["courseIds"])

    def test_real_arena_install_requires_zone_transition(self):
        entry = next(item for item in self.entries if item["template"] == "U4" and
                          item["variant"] == "positive" and
                          item["layer"] == "preparation" and item["split"] == "train")
        client = ppo.ArenaClient(card_set="signals")
        try:
            response = client.request(op="restore", snapshot=entry["snapshot"],
                                      comboTelemetry=True)
            observation = response["observation"]
            candidate = next(item for item in observation["candidates"] if
                             item.get("definitionId") == "special_84" and
                             item.get("kind") == "source")
            tracker = metrics.new_tracker(entry["courseId"], entry["snapshot"], detail=True)
            result = client.request(op="step", action={**observation["decision"],
                "actionId": candidate["id"]}, comboTelemetry=True)
            metrics.record_step(tracker, result["comboTelemetry"],
                                observation["decision"]["decisionId"])
            actual = tracker["modelInstallations"]
            self.assertEqual(len(actual), 1)
            self.assertEqual(actual[0]["definitionId"], "special_84")
            self.assertEqual(actual[0]["zone"], "active")
            self.assertEqual(actual[0]["cardId"], candidate["cardId"])
        finally:
            client.close()

    def test_extra_play_zone_install_and_cancelled_selection(self):
        tracker = metrics.new_tracker(None, {"round": 1}, detail=True)
        selected = {"kind": "choice", "choiceIds": ["united_states:special_84:1"],
            "extraCards": [{"cardId": "united_states:special_84:1",
                "definitionId": "special_84", "fromZone": {"zone": "hand"}}]}
        base = {"version": "combo-settlement-v1", "round": 2,
            "decisionSeat": "united_states", "activeSeat": "united_states",
            "choiceKind": "EXTRA_CARD", "offeredTriggers": [],
            "selected": selected, "commits": []}
        metrics.record_step(tracker, base, 12)
        self.assertFalse(tracker["modelInstallations"])
        commit = {"epoch": 1, "serial": 1, "round": 2, "phase": "PLAY",
            "activeSeat": "united_states", "events": [], "added": [], "removed": [],
            "installs": [{"cardId": "united_states:special_84:1",
                "definitionId": "special_84", "zone": "active"}]}
        metrics.record_step(tracker, {**base, "commits": [commit]}, 12)
        metrics.record_step(tracker, {**base, "commits": [commit]}, 12)
        self.assertEqual(len(tracker["modelInstallations"]), 1)
        self.assertEqual(tracker["modelInstallations"][0]["actionSource"], "extra_card")

    def test_normal_and_preparation_statistics_have_separate_denominators(self):
        normal = {"courseId": None, "comboDetail": {"cards": {"special_84": {
            "legalPreparationChoices": 2, "autonomousInstallations": 1,
            "linkedEffectiveSettlements": 0}}}}
        course = {"courseId": "U4:positive:preparation:1", "comboDetail": {
            "cards": {"special_84": {"legalPreparationChoices": 1,
            "autonomousInstallations": 0, "linkedEffectiveSettlements": 0,
            "unrealizedReason": "not_prepared"}}}}
        groups = outcome_summary([normal, course])["groups"]
        self.assertEqual(groups["normal"]["templates"]["U4"]["preparationRate"], .5)
        self.assertEqual(groups["positive:preparation"]["templates"]["U4"]["preparationRate"], 0)
        self.assertEqual(groups["positive:preparation"]["templates"]["U4"]["notPrepared"], 1)

    def test_c4_metric_version_round_merge(self):
        tracker = metrics.new_tracker(None, {"round": 1}, detail=True)
        episode = {"comboDetail": detail_metrics.summarize_detail(tracker,
            {"courseId": None}, 0)}
        summary = detail_metrics.aggregate_detail([episode])
        summary["version"] = detail_metrics.C4_VERSION
        merged = detail_metrics.merge_update_summaries([summary, summary])
        self.assertEqual(merged["version"], detail_metrics.C4_VERSION)
        self.assertEqual(merged["groups"]["normal"]["episodes"], 2)


if __name__ == "__main__":
    unittest.main()
