import unittest

from scripts import ppo_train as ppo
from scripts.ppo_auto_archive import digest
from scripts.ppo_auto_explore import match_recorded_action, run_branch
from scripts.ppo_auto_route_match import (route_window_status,
    route_plan_with_ordinals, route_context)


class SkipTriggerPolicy:
    file_hash = "test-frozen-policy"
    weight_hash = "test-frozen-policy-weights"

    def probabilities(self, observation):
        values = [0.0] * len(observation["candidates"])
        values[0] = 1.0  # the real G1 trigger window lists Skip first
        return values, 0.0


class RouteExecutorTests(unittest.TestCase):
    def test_real_g1_route_overrides_old_policy_skip_without_ppo_samples(self):
        client = ppo.ArenaClient(card_set="signals")
        try:
            client.request(op="reset", seed=5, mode="A", cardSet="signals")
            snapshot = client.request(op="snapshot")["snapshot"]
            state = snapshot["state"]
            state["units"] = [
                {"id":"de-home","country":"germany","type":"army","regionId":"germany"},
                {"id":"de-east","country":"germany","type":"army","regionId":"eastern_europe"},
                {"id":"su-uk","country":"soviet_union","type":"army","regionId":"ukraine"}]
            deck = state["decks"]["germany"]
            for zone in ("drawPile", "hand", "discardPile"):
                card = next((card for card in deck[zone] if
                    card["definitionId"] == "special_136"), None)
                if card:
                    deck[zone].remove(card)
                    deck["active"].append(card)
                    break
            self.assertIsNotNone(card)
            before = client.request(op="restore", snapshot=snapshot)["observation"]
            root = {"id":"g1-real-engine", "snapshot":client.request(op="snapshot")["snapshot"],
                    "observation":before, "prefix":[]}
            attack = next(candidate for candidate in before["candidates"] if any(
                choice.get("action") == "land_battle" and choice.get("regionId") == "ukraine"
                for choice in candidate.get("choices", ())))
            after = client.request(op="step", action={**before["decision"],
                "actionId":attack["id"]})["observation"]
            trigger = next(candidate for candidate in after["candidates"] if any(
                choice.get("definitionId") == "special_136"
                for choice in candidate.get("choices", ())))
            recorded = [{"observation": observation, "actionId": selected["id"],
                "candidateHash": digest(observation["candidates"])} for observation, selected
                in ((before, attack), (after, trigger))]
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
                                  "choices": [{"kind": "action_plan", "action": "land_battle",
                                               "country": "germany", "regionId": "ukraine"}]}]}
        recorded = {"observation": before, "actionId": "attack-ukraine",
                    "candidateHash": digest(before["candidates"])}
        changed = {**before, "candidates": [{"id": "attack-moscow", "kind": "source",
                            "definitionId": "land_battle",
                            "choices": [{"kind": "action_plan", "action": "land_battle",
                                         "country": "germany", "regionId": "moscow"}]}]}
        self.assertEqual(match_recorded_action(recorded, changed),
                         (None, "required_action_illegal_or_missing"))

    def test_real_engine_two_defenders_in_one_region_keep_country_identity(self):
        client = ppo.ArenaClient(card_set="signals")
        try:
            client.request(op="reset", seed=5, mode="A", cardSet="signals")
            snapshot = client.request(op="snapshot")["snapshot"]
            snapshot["state"]["units"] = [
                {"id": "de-home", "country": "germany", "type": "army", "regionId": "germany"},
                {"id": "de-east", "country": "germany", "type": "army", "regionId": "eastern_europe"},
                {"id": "su-uk", "country": "soviet_union", "type": "army", "regionId": "ukraine"},
                {"id": "uk-uk", "country": "united_kingdom", "type": "army", "regionId": "ukraine"}]
            before = client.request(op="restore", snapshot=snapshot)["observation"]
            attacks = [c for c in before["candidates"] if any(
                choice.get("action") == "land_battle" and
                choice.get("regionId") == "ukraine" for choice in c.get("choices", []))]
            soviet = next(c for c in attacks if any(
                choice.get("target", {}).get("country") == "soviet_union"
                for choice in c["choices"]))
            british = next(c for c in attacks if any(
                choice.get("target", {}).get("country") == "united_kingdom"
                for choice in c["choices"]))
            recorded = {"observation": before, "actionId": soviet["id"],
                        "candidateHash": digest(before["candidates"])}
            only_british = {**before, "candidates": [british]}
            self.assertEqual(match_recorded_action(recorded, only_british),
                             (None, "required_action_illegal_or_missing"))
            same_intent = {**before, "candidates": [{**soviet, "id": "renumbered"}]}
            self.assertEqual(match_recorded_action(recorded, same_intent), (0, None))
            duplicate_fact = {**before, "units": [*before["units"],
                {"id":"same-semantic-second-unit","country":"soviet_union",
                 "type":"army","regionId":"ukraine"}]}
            self.assertEqual(match_recorded_action(recorded, duplicate_fact),
                             (None, "unsupported_or_incomplete_action_intent"))
        finally:
            client.close()

    def test_real_engine_two_attack_sources_keep_region_identity(self):
        client = ppo.ArenaClient(card_set="signals")
        try:
            client.request(op="reset", seed=5, mode="A", cardSet="signals")
            snapshot = client.request(op="snapshot")["snapshot"]
            snapshot["state"]["units"] = [
                {"id":"home","country":"germany","type":"army","regionId":"germany"},
                {"id":"east","country":"germany","type":"army","regionId":"eastern_europe"},
                {"id":"balk","country":"germany","type":"army","regionId":"balkans"},
                {"id":"soviet","country":"soviet_union","type":"army","regionId":"ukraine"}]
            before = client.request(op="restore", snapshot=snapshot)["observation"]
            attacks = [candidate for candidate in before["candidates"] if any(
                choice.get("action") == "land_battle" and
                choice.get("regionId") == "ukraine" for choice in candidate.get("choices", ()))]
            east = next(candidate for candidate in attacks if any(
                choice.get("source", {}).get("regionId") == "eastern_europe"
                for choice in candidate["choices"]))
            balkans = next(candidate for candidate in attacks if any(
                choice.get("source", {}).get("regionId") == "balkans"
                for choice in candidate["choices"]))
            recorded = {"observation": before, "actionId": east["id"],
                        "candidateHash": digest(before["candidates"])}
            self.assertEqual(match_recorded_action(recorded,
                {**before, "candidates": [balkans]}),
                (None, "required_action_illegal_or_missing"))
        finally:
            client.close()

    def test_same_kind_later_window_cannot_replace_missed_window(self):
        base = {"round": 2, "decisionSeat": "germany", "activeSeat": "germany",
            "node": "ENGINE_CHOICE", "phase": "PLAY", "choiceKind": "TRIGGER",
            "currentSourceDefinition": "special_136", "originAction": {
                "country": "germany", "action": "land_battle", "regionId": "ukraine"}}
        step = {"decisionId": 1, "actionId": "fire", "observation": base}
        expected = route_plan_with_ordinals([step], [step])[0]
        seen = {route_context(base): 1}
        self.assertEqual(route_window_status(expected, base, seen), "match")
        seen[route_context(base)] = 2
        self.assertEqual(route_window_status(expected, base, seen),
                         "expected_window_ordinal_missed")
        self.assertEqual(route_window_status(expected, {**base, "round": 3}, seen),
                         "expected_round_expired")
        self.assertEqual(route_window_status(expected, {**base, "node": "SOURCE"}, seen),
                         "expected_parent_resolution_closed")
        # An opponent response may appear before the original window returns.
        self.assertEqual(route_window_status(expected, {**base,
            "decisionSeat": "soviet_union"}, seen), "wait")
        self.assertEqual(route_window_status(expected, {**base,
            "round": 1, "node": "SOURCE"}, seen), "wait")
        two = [{"decisionId": 1, "actionId": "skip", "observation": base},
               {"decisionId": 2, "actionId": "fire", "observation": base}]
        second = route_plan_with_ordinals(two, [two[1]])[0]
        self.assertEqual(second["_routeOrdinal"], 2)
        self.assertEqual(route_window_status(second, base, seen), "match")

    def test_different_fee_branch_or_status_never_matches(self):
        base = {"round": 1, "decisionSeat": "germany", "activeSeat": "germany",
            "node": "ENGINE_CHOICE", "phase": "PLAY", "choiceKind": "SELECT"}
        chosen = {"id": "one", "kind": "choice", "choices": [{"kind": "pay_cost",
            "action": "land_battle", "country": "germany", "regionId": "ukraine",
            "definitionId": "special_137"}], "effects": [{"kind": "action",
            "action": "land_battle", "country": "germany", "fee": True, "count": 1,
            "regions": ["ukraine"]}]}
        before = {**base, "candidates": [chosen]}
        recorded = {"observation": before, "actionId": "one",
                    "candidateHash": digest(before["candidates"])}
        variants = [
            {**chosen, "choices": [{**chosen["choices"][0], "definitionId": "special_136"}]},
            {**chosen, "effects": [{**chosen["effects"][0], "count": 2}]},
            {**chosen, "choices": [{**chosen["choices"][0], "regionId": "moscow"}]},
            {**chosen, "choices": [{**chosen["choices"][0], "country": "italy"}]},
        ]
        for candidate in variants:
            with self.subTest(candidate=candidate):
                self.assertEqual(match_recorded_action(recorded,
                    {**base, "candidates": [candidate]}),
                    (None, "required_action_illegal_or_missing"))
        unknown = {**chosen, "unexpectedPaymentRule": "free"}
        self.assertEqual(match_recorded_action(recorded,
            {**base, "candidates": [unknown]}),
            (None, "unsupported_or_incomplete_action_intent"))

    def test_targets_candidate_matches_visible_unit_semantics_not_instance_number(self):
        before = {"round": 2, "decisionSeat": "germany", "activeSeat": "germany",
            "node": "TARGETS", "phase": "PLAY", "sourceSeat": "germany",
            "units": [{"id":"old-soviet","country":"soviet_union",
                       "type":"army","regionId":"ukraine"}],
            "candidates": [{"id":"choose-old-soviet","kind":"targets",
                            "targetIds":["old-soviet"]}]}
        recorded = {"observation": before, "actionId":"choose-old-soviet",
                    "candidateHash":digest(before["candidates"])}
        renumbered = {**before, "units":[{"id":"new-soviet",
            "country":"soviet_union","type":"army","regionId":"ukraine"}],
            "candidates":[{"id":"choose-new-soviet","kind":"targets",
                           "targetIds":["new-soviet"]}]}
        self.assertEqual(match_recorded_action(recorded, renumbered), (0, None))
        replaced = {**renumbered, "units":[{"id":"new-soviet",
            "country":"united_kingdom","type":"army","regionId":"ukraine"}]}
        self.assertEqual(match_recorded_action(recorded, replaced),
                         (None, "required_action_illegal_or_missing"))


if __name__ == "__main__":
    unittest.main()
