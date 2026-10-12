import gzip
import json
import unittest

from scripts import ppo_train as ppo
from scripts.ppo_auto_archive import digest
from scripts.ppo_auto_explore import match_recorded_action, run_branch
from scripts.ppo_auto_semantic_v2_migrate import POOL
from scripts.ppo_combo_accept import probe


class SkipTriggerPolicy:
    file_hash = "test-frozen-policy"
    weight_hash = "test-frozen-policy-weights"

    def probabilities(self, observation):
        values = [0.0] * len(observation["candidates"])
        values[0] = 1.0  # the real G1 trigger window lists Skip first
        return values, 0.0


class RouteExecutorTests(unittest.TestCase):
    def test_real_g1_route_overrides_old_policy_skip_without_ppo_samples(self):
        with gzip.open(POOL, "rt", encoding="utf-8") as stream:
            entries = json.load(stream)["entries"]
        entry = next(item for item in entries if item["template"] == "G1" and
            item["variant"] == "positive" and item["layer"] == "payoff" and
            item["split"] == "train")
        client = ppo.ArenaClient(card_set="signals")
        try:
            report = probe(client, entry, combo_telemetry=True, include_observations=True)
            self.assertEqual(report["goalsCompleted"], report["goalsTotal"])
            recorded = []
            for step in report["steps"]:
                if not step.get("chosen"):
                    continue
                observation = step["observation"]
                recorded.append({"observation": observation,
                    "actionId": step["chosen"]["id"],
                    "candidateHash": digest(observation["candidates"])})
            self.assertGreaterEqual(len(recorded), 2)
            root = {"id": "g1-real-engine", "snapshot": entry["snapshot"],
                    "observation": recorded[0]["observation"], "prefix": []}
            first = next(index for index, candidate in enumerate(
                root["observation"]["candidates"]) if
                candidate["id"] == recorded[0]["actionId"])
            policy = SkipTriggerPolicy()
            reference = run_branch(client, root, policy, first, kind="reference",
                seed=28, max_steps=2, stop_after_two_turns=False)
            self.assertEqual(reference["path"][1]["actionId"], "choose:[]")
            proposal = run_branch(client, root, policy, first,
                kind="proposal-review", seed=28, max_steps=2,
                stop_after_two_turns=False, route_plan=recorded[:2])
            self.assertTrue(proposal["routeComplete"])
            self.assertEqual(proposal["path"][1]["behavior"],
                             "review_route_intervention")
            self.assertEqual(proposal["path"][1]["actionId"], recorded[1]["actionId"])
            self.assertNotEqual(reference["endHash"], proposal["endHash"])
            self.assertFalse(any(step["behavior"] == "ppo_sample"
                                 for step in proposal["path"]))
        finally:
            client.close()

    def test_target_cannot_be_substituted_when_recorded_target_disappears(self):
        before = {"decisionSeat": "germany", "activeSeat": "germany",
                  "node": "SOURCE", "phase": "PLAY", "choiceKind": None,
                  "choiceField": None, "sourceSeat": "germany",
                  "candidates": [{"id": "attack-ukraine", "kind": "source",
                                  "definitionId": "land_battle",
                                  "choices": [{"regionId": "ukraine"}]}]}
        recorded = {"observation": before, "actionId": "attack-ukraine",
                    "candidateHash": digest(before["candidates"])}
        changed = {**before, "candidates": [{"id": "attack-moscow", "kind": "source",
                            "definitionId": "land_battle",
                            "choices": [{"regionId": "moscow"}]}]}
        self.assertEqual(match_recorded_action(recorded, changed),
                         (None, "required_action_illegal_or_missing"))


if __name__ == "__main__":
    unittest.main()
