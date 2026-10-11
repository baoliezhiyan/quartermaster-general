import unittest
from unittest.mock import patch

from scripts.ppo_auto_explore import review_routes


class Archive:
    def __init__(self):
        self.status = None
        self.labels = None
        self.observation = {"candidates": [{"id": "normal"}, {"id": "explore"}]}

    def routes(self, status=None):
        return ["route"] if status == "candidate" and self.status is None else []

    def route(self, route_id):
        return {"evidence": {"rootId": "root", "firstActionId": "explore",
            "firstCardId": "germany:special_136", "firstDefinitionId": "special_136",
            "candidate": {"routeSignature": ["unit:germany:army:ukraine"]},
            "path": [{"decisionId": 10, "actionId": "explore", "seat": "germany",
                      "cardId": "germany:special_136",
                      "observation": self.observation}]}}

    def read_root(self, _):
        return {"observation": self.observation}

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
    def test_only_eight_complete_independent_pairs_enable_demo(self):
        archive = Archive()

        def fake_branch(_client, _root, _policy, _index, *, kind, **_kwargs):
            proposed = kind == "proposal-review"
            return {"steps": 2, "naturalEnd": True,
                "reward": {"axis": 1.0 if proposed else 0.0, "allies": 0.0},
                "side": "axis", "outcome": "useful" if proposed else "completed",
                "routeSignature": ["unit:germany:army:ukraine"] if proposed else []}

        with patch("scripts.ppo_auto_explore.run_branch", side_effect=fake_branch):
            report = review_routes([object(), object()], Policy("new"), Policy("old"),
                                   archive, wall_seconds=30)
        self.assertEqual(archive.status, "enabled")
        self.assertEqual(len(report["reviewed"][0]["pairs"]), 8)
        self.assertEqual(report["reviewed"][0]["routeRepetitions"], 8)
        self.assertEqual(len(archive.labels), 1)
        self.assertEqual(archive.labels[0]["actionId"], "explore")

    def test_truncated_review_cannot_masquerade_as_qualified(self):
        archive = Archive()

        def fake_branch(_client, _root, _policy, _index, *, kind, **_kwargs):
            return {"steps": 2, "naturalEnd": False,
                "reward": {"axis": 1.0 if kind == "proposal-review" else 0.0,
                           "allies": 0.0},
                "side": "axis", "outcome": "useful",
                "routeSignature": ["unit:germany:army:ukraine"]}

        with patch("scripts.ppo_auto_explore.run_branch", side_effect=fake_branch):
            report = review_routes([object(), object()], Policy("new"), Policy("old"),
                                   archive, wall_seconds=30)
        self.assertEqual(report["reviewed"][0]["status"], "unresolved")
        self.assertIsNone(archive.status)
        self.assertIsNone(archive.labels)


if __name__ == "__main__":
    unittest.main()
