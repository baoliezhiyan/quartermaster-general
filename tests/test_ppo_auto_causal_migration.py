import unittest

import torch

from scripts import ppo_train as ppo
from scripts.ppo_auto_causal_migrate import (SOURCE, SOURCE_SHA, SOURCE_WEIGHTS,
    DEST, REPORT, compare, file_sha, observations)
from scripts.ppo_legacy_potential import encoder_classes, vector
from scripts.ppo_network_factory import (A2S1_ADAPTER, HISTORICAL_GATE_ADAPTER,
    make_network, migrate_scoped_signal_historical_gate)


class HistoricalGateMigrationTests(unittest.TestCase):
    def test_parent_preserved_and_reloaded_model_matches_frozen_observations(self):
        self.assertEqual(file_sha(SOURCE), SOURCE_SHA)
        saved = torch.load(SOURCE, map_location="cpu", weights_only=False)
        self.assertEqual(saved["weightsSha256"], SOURCE_WEIGHTS)
        migrated = torch.load(DEST, map_location="cpu", weights_only=False)
        self.assertEqual(migrated["parentFileSha256"], SOURCE_SHA)
        self.assertEqual(migrated["networkArchitecture"], HISTORICAL_GATE_ADAPTER)
        client = ppo.ArenaClient(card_set="signals")
        try:
            Old, New = encoder_classes()
            old_encoder, encoder = Old(client.schema), New(client.schema)
            old_model = make_network(A2S1_ADAPTER, old_encoder)
            old_model.load_state_dict(saved["modelState"], strict=True)
            new_model = make_network(HISTORICAL_GATE_ADAPTER, encoder)
            new_model.load_state_dict(migrated["modelState"], strict=True)
            self.assertEqual(ppo.model_weights_sha256(new_model),
                             migrated["weightsSha256"])
            self.assertEqual(encoder.historical_start, 19487)
            checks = [compare(old_model, new_model, old_encoder, encoder, obs)
                      for obs in observations(client)]
            self.assertGreaterEqual(len(checks), 30)
            self.assertLessEqual(max(item["maxLogitError"] for item in checks), 1e-5)
            self.assertLessEqual(max(item["maxProbabilityError"] for item in checks), 1e-6)
            self.assertFalse(any(item["argmaxChanged"] for item in checks))
            client.request(op="reset", seed=5, mode="A", cardSet="signals")
            snapshot = client.request(op="snapshot")["snapshot"]
            state = snapshot["state"]
            state["phase"] = "PLAY"
            state["activeSeat"] = state["operatorSeat"] = "germany"
            state["units"] = [
                {"id": "g-home", "country": "germany", "type": "army", "regionId": "germany"},
                {"id": "g-east", "country": "germany", "type": "army", "regionId": "eastern_europe"},
                {"id": "s-uk", "country": "soviet_union", "type": "army", "regionId": "ukraine"}]
            deck = state["decks"]["germany"]
            for zone in ("hand", "drawPile", "discardPile"):
                installed = next((card for card in deck[zone] if
                    card["definitionId"] == "special_136"), None)
                if installed:
                    deck[zone].remove(installed)
                    deck["active"].append(installed)
                    break
            self.assertIsNotNone(installed)
            scene = client.request(op="restore", snapshot=snapshot)["observation"]
            attack = next(candidate for candidate in scene["candidates"] if any(
                choice.get("action") == "land_battle" and
                choice.get("regionId") == "ukraine" for choice in
                candidate.get("choices", ())))
            check = compare(old_model, new_model, old_encoder, encoder, scene)
            self.assertLessEqual(check["maxProbabilityError"], 1e-6)
            trigger = client.request(op="step", action={**scene["decision"],
                "actionId": attack["id"]})["observation"]
            self.assertEqual(trigger["node"], "ENGINE_CHOICE")
            check = compare(old_model, new_model, old_encoder, encoder, trigger)
            self.assertLessEqual(check["maxProbabilityError"], 1e-6)
            self.assertFalse(check["argmaxChanged"])
            # The historical opening gate has learned weight and is retained.
            self.assertGreater(abs(float(new_model.opening_logit.detach())), 1)
            self.assertTrue(torch.equal(new_model.opening_logit,
                                        old_model.opening_logit))
            self.assertEqual(torch.count_nonzero(new_model.map.base.candidate_net[0]
                .weight[:, 17784:]).item(), 0)
            self.assertEqual(file_sha(SOURCE), SOURCE_SHA)
        finally:
            client.close()

    def test_historical_projection_is_separate_from_corrected_semantics(self):
        client = ppo.ArenaClient(card_set="signals")
        try:
            Old, New = encoder_classes()
            old_encoder, encoder = Old(client.schema), New(client.schema)
            observation = client.request(op="reset", seed=5, mode="A",
                cardSet="signals")["observation"]
            target = next(item for item in observation["candidates"] if
                item.get("definitionId") == "special_136")
            self.assertEqual(target["potential"]["futureActions"], ["build_army"])
            old = vector(old_encoder, "special_136", target["potential"])
            current = encoder._potential_vector(target["potential"])
            self.assertEqual(len(old), 281)
            self.assertNotEqual(len(old), len(current))
            candidate = encoder.encode_candidate(observation, target)
            self.assertEqual(candidate[encoder.historical_start:], old)
        finally:
            client.close()

    def test_old_version_and_nonzero_historical_weights_are_rejected(self):
        client = ppo.ArenaClient(card_set="signals")
        try:
            New = encoder_classes()[1]
            encoder = New(client.schema)
            saved = torch.load(SOURCE, map_location="cpu", weights_only=False)
            changed = {**saved, "encoderVersion": "unknown"}
            with self.assertRaises(ValueError):
                migrate_scoped_signal_historical_gate(changed, encoder)
            changed = {**saved, "modelState": dict(saved["modelState"])}
            weight = saved["modelState"]["map.base.candidate_net.0.weight"].clone()
            weight[0, 17784] = 0.5
            changed["modelState"]["map.base.candidate_net.0.weight"] = weight
            with self.assertRaises(ValueError):
                migrate_scoped_signal_historical_gate(changed, encoder)
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
