import gzip
import json
import unittest

from scripts import ppo_train as ppo
from scripts.ppo_auto_archive import digest
from scripts.ppo_auto_explore import demonstration_path
from scripts.ppo_combo_accept import probe

POOL = ppo.ROOT / 'PPO训练/.state/A2AUTO2SEM-V6/course-pool-v3.json.gz'


class RealComboPathTests(unittest.TestCase):
    def test_g1_install_attack_trigger_and_target_survive_demo_filter(self):
        if not POOL.exists():
            self.skipTest('Legally replayed v6 course fixture is a local artifact')
        with gzip.open(POOL, "rt", encoding="utf-8") as stream:
            entries = json.load(stream)["entries"]
        preparation = next(item for item in entries if item["template"] == "G1" and
            item["variant"] == "positive" and item["layer"] == "preparation" and
            item["split"] == "train")
        payoff = next(item for item in entries if item["template"] == "G1" and
            item["variant"] == "positive" and item["layer"] == "payoff" and
            item["seed"] == preparation["seed"])
        client = ppo.ArenaClient(card_set="signals")
        try:
            obs = client.request(op="restore", snapshot=preparation["snapshot"],
                                 comboTelemetry="full")["observation"]
            path = []
            for item in payoff["trace"][len(preparation["trace"]):]:
                candidate = next(c for c in obs["candidates"] if c["id"] == item["actionId"])
                response = client.request(op="step", action={**obs["decision"],
                    "actionId": candidate["id"]}, comboTelemetry=True)
                path.append({"decisionId": obs["decision"]["decisionId"],
                    "seat": obs["decisionSeat"], "actionId": candidate["id"],
                    "cardId": candidate.get("cardId"),
                    "candidateHash": digest(obs["candidates"]),
                    "observation": obs,
                    "behavior": "explicit_exploration" if
                        candidate.get("definitionId") == "special_136" else "frozen_sample",
                    "events": response["comboTelemetry"]["commits"]})
                obs = response["observation"]
            self.assertEqual(client.request(op="snapshot")["snapshot"]["state"],
                             payoff["snapshot"]["state"])
            report = probe(client, payoff, combo_telemetry=True,
                           include_observations=True)
            self.assertEqual(report["goalsCompleted"], report["goalsTotal"])
            for step in report["steps"]:
                if not step.get("chosen"):
                    continue
                observation = step["observation"]
                candidate = step["chosen"]
                path.append({"decisionId": observation["decision"]["decisionId"],
                    "seat": observation["decisionSeat"], "actionId": candidate["id"],
                    "cardId": candidate.get("cardId"),
                    "candidateHash": digest(observation["candidates"]),
                    "observation": observation, "behavior": "frozen_sample",
                    "events": step["telemetry"]["commits"]})
            first = next(i for i, step in enumerate(path) if
                step["observation"]["candidates"] and
                next(c for c in step["observation"]["candidates"] if
                     c["id"] == step["actionId"]).get("definitionId") == "special_136")
            path = path[first:]
            route = {"firstCardId": path[0]["cardId"],
                     "firstActionId": path[0]["actionId"],
                     "candidate": {"side": "axis"}, "path": path}
            labels = demonstration_path({"prefix": []}, route)
            ids = {label["actionId"] for label in labels}
            self.assertIn(route["firstActionId"], ids)
            for step in report["steps"]:
                if step.get("matched") and step.get("chosen"):
                    self.assertIn(step["chosen"]["id"], ids)
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
