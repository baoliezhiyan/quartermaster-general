import tempfile
import unittest
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_auto_archive import ExplorationArchive
from scripts.ppo_auto_explore import FrozenPolicy, run_branch, explore_pairs, review_routes
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network


class RealEngineBranchTests(unittest.TestCase):
    def test_two_bounded_followup_interventions_are_off_policy(self):
        client = ppo.ArenaClient(card_set="signals")
        try:
            encoder = ppo.Encoder(client.schema)
            torch.manual_seed(20261012)
            model = make_network(A2S1_ADAPTER, encoder)
            policy = FrozenPolicy.from_live(model, encoder, torch.device("cpu"),
                                            source_hash="test-policy")
            observation = client.request(op="reset", seed=1, gameId="branch-test",
                mode="A", cardSet="signals", comboTelemetry="full")["observation"]
            snapshot = client.request(op="snapshot")["snapshot"]
            with tempfile.TemporaryDirectory() as folder:
                with ExplorationArchive(Path(folder) / "archive.sqlite",
                    {"buildFingerprint": client.fingerprint,
                     "encoderVersion": ppo.encoder_version("signals"),
                     "rewardConfig": ppo.reward_config("signals")}) as archive:
                    root_id, _ = archive.add_root(snapshot, observation, [])
                    root = archive.read_root(root_id)
                    result = run_branch(client, root, policy, 0, kind="coverage",
                        seed=131, max_steps=32, max_extra_interventions=2,
                        archive=archive, budget_key="p2_engine_steps",
                        budget_ceiling=32)
                    self.assertGreater(result["extraInterventions"], 0)
                    self.assertLessEqual(result["extraInterventions"], 2)
                    self.assertEqual(archive.counter("p2_engine_steps"), result["steps"])
                    self.assertEqual(sum(step["behavior"] == "downstream_exploration"
                        for step in result["path"]), result["extraInterventions"])
                    self.assertTrue(all(step["behavior"] != "ppo_sample"
                        for step in result["path"]))
        finally:
            client.close()

    def test_tiny_p2_and_p3_budgets_stop_at_safe_boundaries(self):
        clients = [ppo.ArenaClient(card_set="signals") for _ in range(2)]
        try:
            encoder = ppo.Encoder(clients[0].schema)
            model = make_network(A2S1_ADAPTER, encoder)
            policy = FrozenPolicy.from_live(model, encoder, torch.device("cpu"),
                                            source_hash="test-policy")
            observation = clients[0].request(op="reset", seed=1, gameId="budget-test",
                mode="A", cardSet="signals", comboTelemetry="full")["observation"]
            snapshot = clients[0].request(op="snapshot")["snapshot"]
            with tempfile.TemporaryDirectory() as folder:
                with ExplorationArchive(Path(folder) / "archive.sqlite",
                    {"buildFingerprint": clients[0].fingerprint,
                     "encoderVersion": ppo.encoder_version("signals"),
                     "rewardConfig": ppo.reward_config("signals")}) as archive:
                    root, _ = archive.add_root(snapshot, observation, [])
                    p2 = explore_pairs(clients, policy, archive, max_pairs=1,
                        max_steps=1, wall_seconds=60)
                    self.assertLessEqual(archive.counter("p2_engine_steps"), 1)
                    self.assertEqual(p2["pairs"], 0)
                    archive.add_route(root, {"rootId": root,
                        "firstActionId": observation["candidates"][0]["id"],
                        "firstCardId": observation["candidates"][0].get("cardId"),
                        "candidate": {"routeSignature": ["none"],
                                      "mechanismSignature": ["none"]},
                        "path": []})
                    parent = FrozenPolicy.from_live(make_network(A2S1_ADAPTER, encoder),
                        encoder, torch.device("cpu"), source_hash="independent")
                    report = review_routes(clients, policy, parent, archive,
                        max_routes=1, max_steps=1, wall_seconds=60)
                    self.assertLessEqual(archive.counter("p3_engine_steps"), 1)
                    self.assertEqual(report["reviewed"][0]["status"], "unresolved")
                    self.assertEqual(archive.routes("enabled"), [])
        finally:
            for client in clients:
                client.close()


if __name__ == "__main__":
    unittest.main()
