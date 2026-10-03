import copy
import unittest

import torch

from scripts.ppo_action_semantics import action_facts, opportunity_facts
from scripts.ppo_train import (ArenaClient, Encoder, PpoNetwork,
                               apply_reward_adjustments, batch_tensors)


class ActionSemanticsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = ArenaClient()
        cls.encoder = Encoder(cls.client.schema)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def scene(self, seat="germany", units=()):
        self.client.request(op="reset", seed=871, mode="A", cardSet="events")
        snapshot = self.client.request(op="snapshot")["snapshot"]
        snapshot["state"].update(activeSeat=seat, operatorSeat=seat, viewSeat=seat,
                                 phase="PLAY", status="PLAYING", resolution=None)
        snapshot["state"]["units"].extend(copy.deepcopy(list(units)))
        return self.client.request(op="restore", snapshot=snapshot)["observation"]

    @staticmethod
    def candidate(obs, definition, region=None):
        return next(c for c in obs["candidates"] if c.get("definitionId") == definition and
                    (region is None or (c.get("choices") or [{}])[0].get("regionId") == region))

    def step(self, obs, candidate):
        return self.client.request(op="step", action={**obs["decision"], "actionId": candidate["id"]})

    def finish_white_plan(self, initial, extra_definition="build_army"):
        card = self.candidate(initial, "special_150")
        response = self.step(initial, card)
        events = []
        for _ in range(12):
            events.extend(response["info"].get("rewardAdjustments") or [])
            obs = response["observation"]
            if obs is None or obs["node"] == "SOURCE":
                break
            selected = next((c for c in obs["candidates"] if any(
                extra_definition in item for item in c.get("choiceIds") or [])), None)
            if selected is None:
                selected = next((c for c in obs["candidates"] if c.get("choices") and
                                 c["choices"][0].get("regionId") == "germany"),
                                obs["candidates"][0])
            response = self.step(obs, selected)
        else:
            self.fail("White Plan did not finish")
        return response, events

    def test_basic_and_event_fixed_build_share_region_facts(self):
        obs = self.scene("germany")
        basic = self.candidate(obs, "build_army", "eastern_europe")
        event = self.candidate(obs, "special_150")
        basic_fact = action_facts(obs, basic, self.client.schema["regions"])[0]
        event_fact = action_facts(obs, event, self.client.schema["regions"])[0]
        for key in ("action", "country", "regionId", "unitType", "outcome", "same",
                    "allied", "enemy", "supplyPoint"):
            if key == "action":
                self.assertEqual((basic_fact[key], event_fact[key]),
                                 ("build_army", "recruit_army"))
            else:
                self.assertEqual(basic_fact[key], event_fact[key], key)
        first = self.encoder.encode_candidate(obs, basic)
        second = self.encoder.encode_candidate(obs, event)
        self.assertEqual(len(first), len(second))
        self.assertNotEqual(first, second)
        state, candidates = self.encoder.encode(obs)
        model = PpoNetwork(self.encoder.state_dim, self.encoder.candidate_dim)
        logits, _ = model(*batch_tensors([{"state": state, "candidates": candidates}],
                                         torch.device("cpu")))
        self.assertEqual(logits.shape[1], len(obs["candidates"]))

    def test_white_plan_recruitment_and_extra_play_have_separate_responsibility(self):
        for occupant, expected in ((None, False), ("germany", True),
                                   ("soviet_union", True), ("italy", False)):
            units = [] if occupant is None else [{"id": "probe:east", "country": occupant,
                                                  "type": "army", "regionId": "eastern_europe"}]
            obs = self.scene(units=units)
            card = self.candidate(obs, "special_150")
            facts = action_facts(obs, card, self.client.schema["regions"])
            self.assertEqual(facts[0]["outcome"],
                "new" if occupant in (None, "italy") else
                "repeated" if occupant == "germany" else "blocked")
            opportunity = opportunity_facts(card)
            self.assertEqual(opportunity["extraPlayEffects"], 1)
            self.assertEqual(opportunity["replacesSpentPlay"], 1)
            response, adjustments = self.finish_white_plan(obs)
            white = [a for a in adjustments if a["cardId"] == "germany:special_150"]
            self.assertEqual(bool(white), expected, (occupant, adjustments))
            if white:
                self.assertEqual(white[0]["decisionId"], 0)
                self.assertEqual(white[0]["reason"], "white_plan_empty_recruit")
            self.assertIn("special_150", response["info"]["resolvedCardDefinitions"])

    def test_white_plan_random_discard_refreshes_arden_extra_play_candidates(self):
        self.scene("germany")
        baseline = self.client.request(op="snapshot")["snapshot"]
        deck = baseline["state"]["decks"]["germany"]
        white = next(c for c in deck["hand"] if c["definitionId"] == "special_150")
        arden = next(c for c in deck["hand"] if c["definitionId"] == "special_158")
        fallbacks = [c for c in deck["hand"] if c["definitionId"] == "build_army"][:2]
        seen = set()
        outcomes = []
        for random_state in range(24):
            snapshot = copy.deepcopy(baseline)
            state = snapshot["state"]
            state["decks"]["germany"]["hand"] = [white, arden, *fallbacks]
            state["trainingCourse"]["openIds"]["germany"] = [
                white["id"], arden["id"], *(c["id"] for c in fallbacks)]
            state["trainingCourse"]["discardRandomState"] = random_state
            obs = self.client.request(op="restore", snapshot=snapshot)["observation"]
            after = self.step(obs, self.candidate(obs, "special_150"))
            current = self.client.request(op="snapshot")["snapshot"]["state"]["decks"]["germany"]
            arden_in_hand = any(c["id"] == arden["id"] for c in current["hand"])
            arden_offered = any(arden["id"] in c.get("choiceIds", []) for c in
                                 after["observation"]["candidates"])
            self.assertEqual(arden_offered, arden_in_hand,
                             (random_state, current["discardPile"], after["observation"]["node"]))
            seen.add(arden_in_hand)
            outcomes.append((random_state, [c["definitionId"] for c in current["hand"]],
                             [c["definitionId"] for c in current["discardPile"]],
                             after["observation"]["node"]))
            if len(seen) == 2:
                break
        self.assertEqual(seen, {True, False}, outcomes)

    def test_delayed_penalty_only_changes_initiator_reward(self):
        rewards = [{"axis": .2, "allies": -.2}, {"axis": .1, "allies": -.1}]
        samples = [{"seat": "germany"}, {"seat": "united_kingdom"}]
        info = {"rewardAdjustments": [{"decisionId": 0, "seat": "germany",
                 "cardId": "germany:special_150", "reason": "white_plan_empty_recruit",
                 "penalty": -.01, "afterCap": -.01}]}
        apply_reward_adjustments(rewards, samples, info)
        self.assertAlmostEqual(rewards[0]["axis"], .19)
        self.assertEqual(rewards[0]["allies"], -.2)
        self.assertEqual(rewards[1], {"axis": .1, "allies": -.1})
        with self.assertRaises(RuntimeError):
            apply_reward_adjustments(rewards, samples, {"rewardAdjustments": [
                {**info["rewardAdjustments"][0], "seat": "italy"}]})

    def test_fixed_partial_event_stays_useful_and_empty_destroy_is_penalized(self):
        italy = self.scene("italy", [{"id": "probe:italy:ukraine", "country": "italy",
                                      "type": "army", "regionId": "ukraine"}])
        selected = self.candidate(italy, "special_238")
        response = self.step(italy, selected)
        adjustments = list(response["info"].get("rewardAdjustments") or [])
        for _ in range(5):
            obs = response["observation"]
            if obs is None or obs["node"] == "SOURCE":
                break
            response = self.step(obs, obs["candidates"][0])
            adjustments.extend(response["info"].get("rewardAdjustments") or [])
        self.assertFalse(any(a["cardId"] == "italy:special_238" for a in adjustments))
        self.assertTrue(any(u["country"] == "italy" and u["regionId"] == "ross_region"
                            for u in self.client.request(op="snapshot")["snapshot"]["state"]["units"]))

        british = self.scene("united_kingdom")
        empty_destroy = self.candidate(british, "special_22")
        result = self.step(british, empty_destroy)
        self.assertTrue(any(a["reason"] == "whole_action_no_effect" for a in
                            result["info"].get("rewardAdjustments") or []))

    def test_cross_country_target_waste_belongs_to_chooser_and_caps_card(self):
        american = self.scene("united_states")
        event = self.candidate(american, "special_93")
        result = self.step(american, event)
        self.assertEqual(result["observation"]["decisionSeat"], "soviet_union")
        self.assertTrue(any(u["country"] == "soviet_union" and u["regionId"] == "ross_region"
                            for u in result["observation"]["units"]))
        option = next(c for c in result["observation"]["candidates"]
                      if c.get("choiceIds") == ["ross_region"])
        result = self.step(result["observation"], option)
        penalty = result["info"]["rewardAdjustments"]
        self.assertEqual(len(penalty), 1)
        self.assertEqual(penalty[0]["decisionId"], 1)
        self.assertEqual(penalty[0]["seat"], "soviet_union")
        self.assertEqual(penalty[0]["reason"], "avoidable_repeated_target")

    def test_supply_loss_is_delayed_to_source_and_used_unit_is_exempt(self):
        for used, alternative, expect_penalty in ((False, True, True),
                                                   (True, True, False),
                                                   (False, False, False)):
            self.scene()
            snapshot = self.client.request(op="snapshot")["snapshot"]
            state = snapshot["state"]
            state["units"].append({"id": "probe:unsupplied", "country": "germany",
                                   "type": "army", "regionId": "siberia"})
            state.update(phase="PLAY", activeSeat="germany", operatorSeat="germany",
                         viewSeat="germany")
            state["trainingCourse"]["openIds"]["germany"] = []
            snapshot["decisionCount"] = 1
            snapshot["actionLedgers"] = {"probe:card": {
                "cardId": "probe:card", "definitionId": "build_army", "seat": "germany",
                "originDecisionId": 0, "alternative": alternative, "supported": True,
                "positive": [], "newUnitIds": ["probe:unsupplied"],
                "usedUnitIds": ["probe:unsupplied"] if used else [],
                "penalized": False, "extraCard": False, "supplyEligible": True,
                "supplyCandidates": []}}
            observation = self.client.request(op="restore", snapshot=snapshot)["observation"]
            result = self.step(observation, next(c for c in observation["candidates"]
                                                 if c["kind"] == "pass"))
            adjustments = result["info"].get("rewardAdjustments") or []
            self.assertEqual(bool(adjustments), expect_penalty)
            if adjustments:
                self.assertEqual((adjustments[0]["decisionId"], adjustments[0]["seat"]),
                                 (0, "germany"))


if __name__ == "__main__":
    unittest.main()
