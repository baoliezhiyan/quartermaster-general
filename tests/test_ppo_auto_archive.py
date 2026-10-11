import tempfile
import unittest
from pathlib import Path

from scripts.ppo_auto_archive import ExplorationArchive, action_family, cell_key


class AutoArchiveTests(unittest.TestCase):
    def observation(self, *, instance="japan:special_188", resources=2):
        return {"decisionSeat": "japan", "node": "SOURCE", "phase": "PLAY", "round": 2,
                "allianceScores": {"axis": 4, "allies": 2},
                "units": [{"id": "unit:stable:13", "country": "japan", "type": "army",
                           "regionId": "japan"}],
                "ownResources": {"open": {"build_army": resources}},
                "visibleCards": {"active": {"japan": []}},
                "candidates": [{"id": instance, "cardId": instance,
                                "definitionId": "special_188", "kind": "source",
                                "effects": [{"kind": "action", "action": "recruit_army",
                                             "country": "japan", "regions": ["southeast_asia"]}]},
                               {"id": "pass", "kind": "pass"}]}

    def test_equivalent_instances_and_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "archive.sqlite"
            obs = self.observation()
            other = self.observation(instance="japan:special_188:copy-2")
            self.assertEqual(cell_key(obs), cell_key(other))
            self.assertEqual(action_family(obs["candidates"][0]),
                             action_family(other["candidates"][0]))
            with ExplorationArchive(path, {"model": "abc"}, max_cells=1,
                                    representatives=1) as archive:
                root, reason = archive.add_root({"state": {"turn": 2}}, obs, ["legal-step"])
                self.assertEqual(reason, "stored")
                self.assertEqual(archive.add_root({"state": {"turn": 2}}, other, ["legal-step"])[1],
                                 "duplicate")
                self.assertEqual(archive.read_root(root)["prefix"], ["legal-step"])
                card = obs["candidates"][0]
                branch = {"kind": "coverage", "seed": 11,
                          "path": [{"actionId": card["id"]}], "outcome": "truncated"}
                family = action_family(card)
                archive.record_branch(root, card["definitionId"], family, branch, "truncated")
                archive.record_branch(root, card["definitionId"], family, branch, "truncated")
                self.assertEqual(archive.coverage_count(cell_key(obs), card["definitionId"], family),
                                 (1, 0))
                self.assertEqual(archive.stats()["branches"], 1)
                self.assertEqual(archive.branch_pairs(), 1)
            with ExplorationArchive(path, {"model": "abc"}) as reopened:
                self.assertEqual(reopened.stats()["roots"], 1)
                with self.assertRaises(ValueError):
                    ExplorationArchive(path, {"model": "different"})

    def test_resource_bucket_changes_and_limits(self):
        self.assertNotEqual(cell_key(self.observation(resources=0)),
                            cell_key(self.observation(resources=2)))
        with tempfile.TemporaryDirectory() as directory:
            with ExplorationArchive(Path(directory) / "a.sqlite", {"model": "a"},
                                    max_bytes=1) as archive:
                self.assertEqual(archive.add_root({"state": {}}, self.observation(), [])[1],
                                 "byte_capacity")

    def test_only_reviewed_routes_supply_a_bounded_recoverable_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "archive.sqlite"
            with ExplorationArchive(path, {"model": "abc"}) as archive:
                root, _ = archive.add_root({"state": {}}, self.observation(), [])
                route = archive.add_route(root, {"path": [{"actionId": "target"}]})
                with self.assertRaises(ValueError):
                    archive.add_demonstrations(route, "special_188", [self.observation()])
                archive.set_route_status(route, "enabled")
                added, reason = archive.add_demonstrations(route, "special_188", [
                    {"observation": self.observation(), "actionId": "target"},
                    {"observation": self.observation(), "actionId": "other"}])
                self.assertEqual((added, reason), (2, "stored"))
                self.assertEqual(len(archive.demonstration_batch(limit=1, seed=1)), 1)
                with self.assertRaises(ValueError):
                    archive.demonstration_batch(limit=65)
                total = archive.stats()["payloadBytes"]
                self.assertGreater(total, archive.stats()["snapshotBytes"])
            with ExplorationArchive(path, {"model": "abc"}) as reopened:
                self.assertEqual(len(reopened.demonstration_batch(limit=2, seed=4)), 2)


if __name__ == "__main__":
    unittest.main()
