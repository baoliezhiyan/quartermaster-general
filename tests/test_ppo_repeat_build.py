import copy
import unittest

import torch

from scripts.ppo_parallel import decision_rewards
from scripts.ppo_train import ArenaClient, Encoder, PpoNetwork, batch_tensors


class RepeatedBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = ArenaClient()
        cls.encoder = Encoder(cls.client.schema)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def scene(self, seat, units=(), seed=871):
        self.client.request(op="reset", seed=seed, mode="A", cardSet="events")
        snapshot = self.client.request(op="snapshot")["snapshot"]
        state = snapshot["state"]
        state.update(activeSeat=seat, operatorSeat=seat, viewSeat=seat,
                     phase="PLAY", status="PLAYING", resolution=None)
        state["units"].extend(copy.deepcopy(list(units)))
        return self.client.request(op="restore", snapshot=snapshot)["observation"]

    def play(self, observation, candidate):
        return self.client.request(op="step", action={
            **observation["decision"], "actionId": candidate["id"]})

    def candidate(self, observation, definition, region=None):
        return next(c for c in observation["candidates"]
                    if c.get("definitionId") == definition and
                    (region is None or c.get("choices", [{}])[0].get("regionId") == region))

    def test_soviet_first_and_repeated_build_have_distinct_actual_tensors(self):
        first = self.scene("soviet_union")
        self.assertFalse(any(u["country"] == "soviet_union" and u["regionId"] == "ukraine"
                             for u in first["units"]))
        build = self.candidate(first, "build_army", "ukraine")
        self.assertFalse(build["choices"][0]["repeated"])
        result = self.play(first, build)
        self.assertFalse(result["info"]["wasteCheck"]["penalty"])
        self.assertEqual(result["info"]["wasteCheck"]["reason"], "not_repeated")
        snapshot = self.client.request(op="snapshot")["snapshot"]
        self.assertEqual(sum(u["country"] == "soviet_union" and u["type"] == "army" and
                             u["regionId"] == "ukraine" for u in snapshot["state"]["units"]), 1)

        repeat = self.scene("soviet_union", [{"id": "test:soviet:ukraine", "country": "soviet_union",
                                               "type": "army", "regionId": "ukraine"}])
        repeated = self.candidate(repeat, "build_army", "ukraine")
        self.assertTrue(repeated["choices"][0]["repeated"])
        self.assertNotEqual(self.encoder.encode_state(first), self.encoder.encode_state(repeat))
        self.assertNotEqual(self.encoder.encode_candidate(first, build),
                            self.encoder.encode_candidate(repeat, repeated))
        state, candidates = self.encoder.encode(repeat)
        self.assertGreater(float(candidates[repeat["candidates"].index(repeated)].abs().sum()), 0)
        network = PpoNetwork(self.encoder.state_dim, self.encoder.candidate_dim)
        logits, _ = network(*batch_tensors([{"state": state, "candidates": candidates}],
                                          torch.device("cpu")))
        self.assertEqual(logits.shape[1], len(repeat["candidates"]))
        result = self.play(repeat, repeated)
        check = result["info"]["wasteCheck"]
        self.assertTrue(check["penalty"], check)
        self.assertEqual(check["seat"], "soviet_union")
        self.assertEqual(check["reason"], "repeated_basic_build")
        state_after = self.client.request(op="snapshot")["snapshot"]["state"]
        self.assertEqual(sum(u["country"] == "soviet_union" and u["type"] == "army" and
                             u["regionId"] == "ukraine" for u in state_after["units"]), 1)
        base, adjusted = decision_rewards(repeat, result["result"]["allianceScores"] if result["result"]
                                          else result["observation"]["allianceScores"],
                                          result["result"], result["info"])
        self.assertAlmostEqual(adjusted["allies"] - base["allies"], -0.01)
        self.assertEqual(adjusted["axis"], base["axis"])
        self.assertGreater(result["info"]["scoreDelta"]["allies"], 0)

    def test_repeated_build_without_new_placement_alternative_is_exempt(self):
        observation = self.scene("soviet_union", [{"id": "test:soviet:ukraine", "country": "soviet_union",
                                                   "type": "army", "regionId": "ukraine"}])
        # Remove all other available basic construction candidates from the open resource pool.
        snapshot = self.client.request(op="snapshot")["snapshot"]
        open_ids = snapshot["state"]["trainingCourse"]["openIds"]["soviet_union"]
        snapshot["state"]["trainingCourse"]["openIds"]["soviet_union"] = [
            card_id for card_id in open_ids if not any(token in card_id for token in ("build_army", "build_navy"))]
        # Keep one army card open; all legal construction must then repeat.
        army = next(card["id"] for card in snapshot["state"]["decks"]["soviet_union"]["hand"]
                    if card["definitionId"] == "build_army")
        snapshot["state"]["trainingCourse"]["openIds"]["soviet_union"].append(army)
        # This scene may still have non-repeated destinations; the exemption is
        # tested by constraining reserve to zero and leaving the existing army.
        snapshot["state"]["units"].extend({"id": f"test:reserve:{i}", "country": "soviet_union",
                                            "type": "army", "regionId": region}
                                           for i, region in enumerate(["siberia", "kazakhstan", "ross_region",
                                                                        "eastern_europe", "balkans"], 1))
        restored = self.client.request(op="restore", snapshot=snapshot)["observation"]
        repeated = self.candidate(restored, "build_army", "ukraine")
        check = self.play(restored, repeated)["info"]["wasteCheck"]
        self.assertFalse(check["penalty"])
        self.assertEqual(check["reason"], "no_valid_alternative")

    def test_real_multi_effect_event_can_repeat_then_add_unit_without_penalty(self):
        observation = self.scene("italy", [{"id": "test:italy:ukraine", "country": "italy",
                                            "type": "army", "regionId": "ukraine"}])
        event = self.candidate(observation, "special_238")
        self.assertEqual([(effect["action"], effect["regions"]) for effect in event["effects"]],
                         [("recruit_army", ["ukraine"]), ("recruit_army", ["ross_region"])])
        encoded = self.encoder.encode_candidate(observation, event)
        shortened = copy.deepcopy(event)
        shortened["effects"] = shortened["effects"][:1]
        self.assertNotEqual(encoded, self.encoder.encode_candidate(observation, shortened))
        result = self.play(observation, event)
        for _ in range(5):
            next_observation = result["observation"]
            if next_observation is None or next_observation["node"] != "ENGINE_CHOICE":
                break
            choice = next_observation["candidates"][0]
            result = self.play(next_observation, choice)
        self.assertFalse(result["info"].get("wasteCheck", {}).get("penalty", False))
        self.assertTrue(any(u["country"] == "italy" and u["regionId"] == "ukraine"
                            for u in self.client.request(op="snapshot")["snapshot"]["state"]["units"]))
        state = self.client.request(op="snapshot")["snapshot"]["state"]
        self.assertTrue(any(u["country"] == "italy" and u["regionId"] == "ross_region"
                            for u in state["units"]))

    def test_score_and_other_non_build_actions_never_get_basic_build_penalty(self):
        observation = self.scene("germany", [{"id": "test:germany:western_europe",
                                             "country": "germany", "type": "army",
                                             "regionId": "western_europe"}])
        event = self.candidate(observation, "special_166")
        result = self.play(observation, event)
        self.assertFalse(result["info"].get("wasteCheck", {}).get("penalty", False))
        pass_observation = self.scene("soviet_union")
        passed = self.play(pass_observation, next(c for c in pass_observation["candidates"]
                                                  if c["kind"] == "pass"))
        self.assertNotIn("wasteCheck", passed["info"])

    def test_japanese_repeated_build_uses_same_training_signal(self):
        self.scene("japan")
        snapshot = self.client.request(op="snapshot")["snapshot"]
        snapshot["state"]["units"] = [unit for unit in snapshot["state"]["units"]
                                       if unit["regionId"] != "eastern_china"]
        snapshot["state"]["units"].append({"id": "test:japan:east", "country": "japan",
                                          "type": "army", "regionId": "eastern_china"})
        snapshot["state"]["units"].append({"id": "test:japan:near", "country": "japan",
                                          "type": "army", "regionId": "western_china"})
        # Keep this fixed diagnostic unit supplied so placement legality tests
        # the repeated-build signal rather than an unrelated supply cutoff.
        snapshot["state"]["turnFlags"] = {"protected": [], "battleProtected": [],
                                             "supplied": ["test:japan:east", "test:japan:near"],
                                             "supplyCountries": [], "supplyRegions": [],
                                             "suppressed": [], "noAirDefense": False}
        observation = self.client.request(op="restore", snapshot=snapshot)["observation"]
        candidate = self.candidate(observation, "build_army", "eastern_china")
        self.assertTrue(candidate["choices"][0]["repeated"])
        check = self.play(observation, candidate)["info"]["wasteCheck"]
        self.assertTrue(check["penalty"], check)
        self.assertEqual(check["seat"], "japan")

    def test_waste_opportunity_counts_decision_even_when_another_action_is_selected(self):
        observation = self.scene("soviet_union", [{"id": "test:soviet:ukraine",
            "country": "soviet_union", "type": "army", "regionId": "ukraine"}])
        passed = self.play(observation, next(c for c in observation["candidates"]
                                             if c["kind"] == "pass"))
        self.assertGreater(passed["info"]["wasteOpportunity"]["candidateCount"], 0)
        self.assertFalse(passed["info"]["wasteOpportunity"]["chosen"])
        repeated = self.scene("soviet_union", [{"id": "test:soviet:ukraine",
            "country": "soviet_union", "type": "army", "regionId": "ukraine"}])
        selected = self.play(repeated, self.candidate(repeated, "build_army", "ukraine"))
        self.assertTrue(selected["info"]["wasteOpportunity"]["chosen"])

    def test_reward_is_only_assigned_to_initiator_not_other_team_or_next_seat(self):
        previous = {"decisionSeat": "soviet_union", "allianceScores": {"axis": 1, "allies": 2}}
        after = {"axis": 1, "allies": 6}
        info = {"wasteCheck": {"seat": "soviet_union", "repeated": True,
                               "penalty": True, "reason": "repeated_basic_build"}}
        base, adjusted = decision_rewards(previous, after, None, info)
        self.assertAlmostEqual(adjusted["allies"] - base["allies"], -0.01)
        self.assertEqual(adjusted["axis"], base["axis"])
        with self.assertRaisesRegex(RuntimeError, "initiating decision"):
            decision_rewards(previous, after, None, {"wasteCheck": {
                **info["wasteCheck"], "seat": "italy"}})
        self.assertEqual(decision_rewards(previous, after, None, {})[0],
                         decision_rewards(previous, after, None, {})[1])


if __name__ == "__main__":
    unittest.main()
