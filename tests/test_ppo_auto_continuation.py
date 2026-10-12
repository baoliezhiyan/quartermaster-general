import gzip
import json
import tempfile
import unittest
from pathlib import Path

from scripts import ppo_train as ppo
from scripts.ppo_auto_archive import ExplorationArchive, complete_prefix, digest
from scripts.ppo_auto_explore import demonstration_path
from scripts.ppo_auto_semantic_v2_migrate import POOL
from scripts.ppo_combo_accept import probe


class ContinuationPrefixTests(unittest.TestCase):
    def test_real_g1_reference_prefix_survives_archive_restart_and_teaches_install(self):
        with gzip.open(POOL, "rt", encoding="utf-8") as stream:
            entries = json.load(stream)["entries"]
        prep = next(item for item in entries if item["template"] == "G1" and
            item["variant"] == "positive" and item["layer"] == "preparation" and
            item["split"] == "train")
        payoff = next(item for item in entries if item["template"] == "G1" and
            item["variant"] == "positive" and item["layer"] == "payoff" and
            item["seed"] == prep["seed"])
        client = ppo.ArenaClient(card_set="signals")
        try:
            observation = client.request(op="restore", snapshot=prep["snapshot"],
                                         comboTelemetry="full")["observation"]
            prefix = []
            for item in payoff["trace"][len(prep["trace"]):]:
                candidate = next(choice for choice in observation["candidates"] if
                                 choice["id"] == item["actionId"])
                response = client.request(op="step", action={**observation["decision"],
                    "actionId": candidate["id"]}, comboTelemetry=True)
                prefix.append({"decisionId": observation["decision"]["decisionId"],
                    "seat": observation["decisionSeat"], "round": observation["round"],
                    "actionId": candidate["id"], "cardId": candidate.get("cardId"),
                    "definitionId": candidate.get("definitionId"),
                    "candidateHash": digest(observation["candidates"]),
                    "observation": observation, "behavior": "frozen_sample",
                    "events": response["comboTelemetry"]["commits"]})
                observation = response["observation"]
            self.assertTrue(complete_prefix(prefix))
            self.assertTrue(any(item["definitionId"] == "special_136" for item in prefix))
            snapshot = client.request(op="snapshot")["snapshot"]
            self.assertEqual(snapshot["state"], payoff["snapshot"]["state"])
            with tempfile.TemporaryDirectory() as directory:
                file = Path(directory) / "continuation.sqlite"
                identity = {"buildFingerprint": client.fingerprint,
                            "encoderVersion": ppo.encoder_version("signals"),
                            "test": "real-g1-continuation"}
                with ExplorationArchive(file, identity) as archive:
                    root_id, state = archive.add_root(snapshot, observation, prefix,
                        "reference-branch")
                    self.assertEqual(state, "stored")
                with ExplorationArchive(file, identity) as archive:
                    root = archive.read_root(root_id)
                    self.assertTrue(complete_prefix(root["prefix"]))
                    report = probe(client, payoff, combo_telemetry=True,
                                   include_observations=True)
                    self.assertEqual(report["goalsCompleted"], report["goalsTotal"])
                    self.assertTrue(any(event.get("kind") == "deckTop" and
                        event.get("sourceDefinitionId") == "special_136" for step in
                        report["steps"] for commit in step["telemetry"]["commits"] for
                        event in commit.get("events", ())))
                    self.assertTrue(any(unit.get("regionId") == "ukraine" for step in
                        report["steps"] for commit in step["telemetry"]["commits"] for
                        unit in commit.get("added", ())))
                    path = []
                    for step in report["steps"]:
                        if not step.get("chosen"):
                            continue
                        obs, choice = step["observation"], step["chosen"]
                        path.append({"decisionId": obs["decision"]["decisionId"],
                            "seat": obs["decisionSeat"], "round": obs["round"],
                            "actionId": choice["id"], "cardId": choice.get("cardId"),
                            "definitionId": choice.get("definitionId"),
                            "candidateHash": digest(obs["candidates"]),
                            "observation": obs, "behavior": "explicit_exploration",
                            "events": step["telemetry"]["commits"]})
                    route = {"firstCardId": path[0]["cardId"],
                        "firstActionId": path[0]["actionId"],
                        "candidate": {"side": "axis"}, "path": path}
                    labels = demonstration_path(root, route)
                    ids = {item["actionId"] for item in labels}
                    self.assertIn("source:special_136", ids)
                    self.assertIn(path[0]["actionId"], ids)
                    self.assertTrue(any(step["actionId"] in ids for step in path[1:]))
                    self.assertTrue(all(item["observation"] and item["candidateHash"]
                                        for item in labels))
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
