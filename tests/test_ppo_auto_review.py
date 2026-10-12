import unittest
from unittest.mock import patch

from scripts.ppo_auto_explore import review_routes
from scripts.ppo_auto_archive import digest
import time


class Archive:
    def __init__(self):
        self.status = None
        self.labels = None
        self.observation = {"decisionSeat": "germany", "decision": {"decisionId": 10},
                            "candidates": [{"id": "normal"}, {"id": "explore"}]}

    def phase_deadline(self, phase, seconds):
        return time.time() + seconds

    def remaining_budget(self, key, ceiling):
        return ceiling

    def routes(self, status=None):
        return ["route"] if status == "candidate" and self.status is None else []

    def route(self, route_id):
        return {"evidence": {"rootId": "root", "firstActionId": "explore",
            "firstCardId": "germany:special_136", "firstDefinitionId": "special_136",
            "candidate": {"routeSignature": ["unit:germany:army:ukraine"],
                          "mechanismSignature": ["attack-then-build"] , "side": "axis"},
            "path": [{"decisionId": 10, "actionId": "explore", "seat": "germany",
                      "cardId": "germany:special_136",
                      "candidateHash": digest(self.observation["candidates"]),
                      "observation": self.observation}]}}

    def read_root(self, _):
        return {"observation": self.observation, "prefix": []}

    def set_route_status(self, _, status):
        self.status = status

    def add_demonstrations(self, _, family, labels):
        self.labels = labels
        return len(labels), "stored"


class Policy:
    def __init__(self, weight):
        self.weight_hash = weight

    def probabilities(self, _):
        return [0.9, 0.1], 0.0


class ReviewTests(unittest.TestCase):
    def test_review_budget_is_persistent_across_calls(self):
        class ExhaustedArchive(Archive):
            def routes(self, status=None):
                if status == "reviewed":
                    return ["one", "two", "three"]
                return super().routes(status)

        with patch("scripts.ppo_auto_explore.run_branch") as branch:
            report = review_routes([object(), object()], Policy("new"),
                                   Policy("old"), ExhaustedArchive(), max_routes=3)
        self.assertEqual(report["reviewed"], [])
        branch.assert_not_called()

    def test_only_eight_complete_independent_pairs_enable_demo(self):
        archive = Archive()

        def fake_branch(_client, _root, _policy, _index, *, kind, **_kwargs):
            proposed = kind == "proposal-review"
            if proposed:
                self.assertEqual(len(_kwargs["route_plan"]), 1)
                self.assertEqual(_kwargs["route_plan"][0]["actionId"], "explore")
            else:
                self.assertIsNone(_kwargs["route_plan"])
            self.assertEqual(_policy.weight_hash, "new")
            return {"steps": 2, "naturalEnd": True,
                "reward": {"axis": 1.0 if proposed else 0.0, "allies": 0.0},
                "side": "axis", "outcome": "useful" if proposed else "completed",
                "routeSignature": ["unit:germany:army:ukraine"] if proposed else [],
                "mechanismSignature": ["attack-then-build"] if proposed else [],
                "routeInterruption": None, "routeComplete": proposed}

        with patch("scripts.ppo_auto_explore.run_branch", side_effect=fake_branch):
            report = review_routes([object(), object()], Policy("new"), Policy("old"),
                                   archive, wall_seconds=30)
        self.assertEqual(archive.status, "enabled")
        self.assertEqual(len(report["reviewed"][0]["pairs"]), 8)
        self.assertEqual(report["reviewed"][0]["routeRepetitions"], 8)
        self.assertEqual(report["reviewed"][0]["naturalArgmaxRepetitions"], 0)
        self.assertEqual(len(archive.labels), 1)
        self.assertEqual(archive.labels[0]["actionId"], "explore")

    def test_truncated_review_cannot_masquerade_as_qualified(self):
        archive = Archive()

        def fake_branch(_client, _root, _policy, _index, *, kind, **_kwargs):
            return {"steps": 2, "naturalEnd": False,
                "reward": {"axis": 1.0 if kind == "proposal-review" else 0.0,
                           "allies": 0.0},
                "side": "axis", "outcome": "useful",
                "routeSignature": ["unit:germany:army:ukraine"],
                "mechanismSignature": ["attack-then-build"],
                "routeInterruption": None, "routeComplete": kind == "proposal-review"}

        with patch("scripts.ppo_auto_explore.run_branch", side_effect=fake_branch):
            report = review_routes([object(), object()], Policy("new"), Policy("old"),
                                   archive, wall_seconds=30)
        self.assertEqual(report["reviewed"][0]["status"], "unresolved")
        self.assertIsNone(archive.status)
        self.assertIsNone(archive.labels)


if __name__ == "__main__":
    unittest.main()
