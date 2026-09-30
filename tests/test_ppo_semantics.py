import copy
import random
import unittest

from scripts.ppo_train import ArenaClient, Encoder


class SemanticObservationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = ArenaClient()
        cls.encoder = Encoder(cls.client.schema)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def reset_as(self, seat, seed=81):
        self.client.request(op="reset", seed=seed, mode="A")
        snapshot = self.client.request(op="snapshot")["snapshot"]
        state = snapshot["state"]
        state.update(activeSeat=seat, operatorSeat=seat, viewSeat=seat,
                     phase="PLAY", status="PLAYING", resolution=None)
        return snapshot

    def choose_source(self, snapshot, definition):
        observation = self.client.request(op="restore", snapshot=snapshot)["observation"]
        source = next(candidate for candidate in observation["candidates"]
                      if candidate.get("definitionId") == definition)
        next_observation = self.client.request(op="step", action={
            **observation["decision"], "actionId": source["id"]})["observation"]
        return source, next_observation

    def test_barbarossa_order_and_live_precommit_target_semantics(self):
        snapshot = self.reset_as("germany")
        snapshot["state"]["units"] = [
            {"id": "g-home", "country": "germany", "type": "army", "regionId": "germany"},
            {"id": "g-front", "country": "germany", "type": "army", "regionId": "eastern_europe"},
            {"id": "s-ukr", "country": "soviet_union", "type": "army", "regionId": "ukraine"},
            {"id": "s-ross", "country": "soviet_union", "type": "army", "regionId": "ross_region"}]
        source, obs = self.choose_source(snapshot, "special_162")
        self.assertTrue(source["effects"][0]["precommitTargets"])
        options = {tuple(c["targetIds"]): c for c in obs["candidates"]}
        forward = self.encoder.encode_candidate(obs, options[("s-ukr", "s-ross")])
        reversed_order = self.encoder.encode_candidate(obs, options[("s-ross", "s-ukr")])
        self.assertNotEqual(forward, reversed_order)
        selected = self.client.request(op="step", action={
            **obs["decision"], "actionId": options[("s-ukr", "s-ross")]["id"]})["observation"]
        if selected is not None and selected["node"] == "ENGINE_CHOICE":
            self.assertEqual(len(selected["selectedTargetFacts"]), 2)
            self.encoder.encode(selected)

    def test_baotuan_and_first_fire_intermediate_effects_are_encodable(self):
        for seat, definition, binding in [
                ("soviet_union", "special_113", "new-china"),
                ("united_states", "special_107", "built-navy")]:
            snapshot = self.reset_as(seat, 91 if seat == "soviet_union" else 92)
            source, intermediate = self.choose_source(snapshot, definition)
            self.assertTrue(any(effect.get("bindAs") == binding for effect in source["effects"]))
            self.assertTrue(any(effect.get("fromBinding") == binding for effect in source["effects"]))
            self.assertIsNotNone(intermediate)
            self.encoder.encode(intermediate)
            trace = []
            current = intermediate
            for _ in range(12):
                if current is None or current.get("bindingFacts", {}).get(binding):
                    break
                trace.append((current["node"], current.get("choiceKind"),
                              len(current["candidates"])))
                selected = next((candidate for candidate in current["candidates"]
                                 if candidate.get("choiceIds") and candidate["choiceIds"]),
                                current["candidates"][0])
                current = self.client.request(op="step", action={
                    **current["decision"], "actionId": selected["id"]})["observation"]
            self.assertIsNotNone(current, trace)
            self.assertTrue(current.get("bindingFacts", {}).get(binding), trace)
            self.encoder.encode(current)

    def test_effects_keep_all_regions_targets_and_visible_bindings(self):
        obs = self.encoder._dummy()
        first = copy.deepcopy(obs)
        second = copy.deepcopy(obs)
        first["activeEffects"] = [{"kind": "action", "action": "recruit_army", "country": "germany",
                                   "regions": ["germany", "ukraine"], "children": []}]
        second["activeEffects"] = copy.deepcopy(first["activeEffects"])
        second["activeEffects"][0]["regions"][1] = "moscow"
        self.assertNotEqual(self.encoder.encode_state(first), self.encoder.encode_state(second))
        first = copy.deepcopy(obs)
        second = copy.deepcopy(obs)
        first["selectedTargetFacts"] = [{"country": "soviet_union", "type": "army", "regionId": "ukraine"}]
        second["selectedTargetFacts"] = [{"country": "soviet_union", "type": "army", "regionId": "moscow"}]
        self.assertNotEqual(self.encoder.encode_state(first), self.encoder.encode_state(second))
        first["bindingFacts"] = {"new-china": first["selectedTargetFacts"]}
        self.assertNotEqual(self.encoder.encode_state(first), self.encoder.encode_state(second))
        first = copy.deepcopy(obs)
        second = copy.deepcopy(obs)
        first["activeEffects"] = [{"kind": "action", "action": "land_battle", "country": "germany",
                                   "targetFacts": [{"country": "soviet_union", "type": "army",
                                                    "regionId": "ukraine"}], "children": []}]
        second["activeEffects"] = copy.deepcopy(first["activeEffects"])
        second["activeEffects"][0]["targetFacts"][0]["regionId"] = "moscow"
        self.assertNotEqual(self.encoder.encode_state(first), self.encoder.encode_state(second))

    def test_real_build_order_and_recruit_recycle_choices_are_distinct(self):
        for seed, step, kind, left, right in [
                (929600, 23, "BUILD_ORDER", "build_army|british_isles", "build_navy|sea_north_sea"),
                (929602, 57, "ACTION", "recruit:western_china:initial:china",
                 "recruit:western_china:unit:30:9")]:
            rng = random.Random(seed)
            obs = self.client.request(op="reset", seed=seed, mode="A", cardSet="events")["observation"]
            for _ in range(step):
                candidate = rng.choice(obs["candidates"])
                obs = self.client.request(op="step", action={
                    **obs["decision"], "actionId": candidate["id"]})["observation"]
            self.assertEqual(obs["choiceKind"], kind)
            candidates = {c["choiceIds"][0]: c for c in obs["candidates"] if c.get("choiceIds")}
            a, b = candidates[left], candidates[right]
            self.assertNotEqual(self.encoder.encode_candidate(obs, a),
                                self.encoder.encode_candidate(obs, b))
            if kind == "ACTION":
                self.assertEqual(a["choices"][0]["source"]["regionId"], "eastern_china")
                self.assertEqual(b["choices"][0]["source"]["regionId"], "southeast_asia")
                equivalent = copy.deepcopy(b)
                equivalent["choiceIds"] = ["recruit:western_china:unit:999:999"]
                self.assertEqual(self.encoder.encode_candidate(obs, b),
                                 self.encoder.encode_candidate(obs, equivalent))

    def test_unstructured_choice_is_rejected(self):
        obs = self.encoder._dummy()
        with self.assertRaisesRegex(ValueError, "lacks structured semantics"):
            self.encoder.encode_candidate(obs, {"kind": "choice", "choiceIds": ["opaque"]})


if __name__ == "__main__":
    unittest.main()
