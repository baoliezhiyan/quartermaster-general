import copy
import json
import random
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

from scripts import ppo_stage2 as stage2
from scripts.ppo_network_factory import FLAT, MAP, make_network, map_from_flat, migrate_flat_state
from scripts.ppo_train import ArenaClient, Encoder, batch_tensors, model_weights_sha256
from scripts import ppo_train as ppo


class StageTwoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = ArenaClient()
        cls.encoder = Encoder(cls.client.schema)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def test_actual_strait_adjacency_changes_with_controller(self):
        self.client.request(op="reset", seed=992, mode="A", cardSet="events")
        snapshot = self.client.request(op="snapshot")["snapshot"]
        strait = self.client.schema["straits"][0]
        index = 0
        for country, alliance in (("germany", "axis"), ("united_kingdom", "allies")):
            state = copy.deepcopy(snapshot)
            state["state"]["units"] = [u for u in state["state"]["units"]
                                         if u["regionId"] != strait["landRegion"]]
            state["state"]["units"].append({"id": f"controller:{country}",
                "country": country, "type": "army", "regionId": strait["landRegion"]})
            obs = self.client.request(op="restore", snapshot=state)["observation"]
            self.assertTrue(obs["effectiveStraits"][country][index])
            opponent = "united_kingdom" if alliance == "axis" else "germany"
            self.assertFalse(obs["effectiveStraits"][opponent][index])
            encoded = self.encoder.encode_state(obs)
            base = self.encoder.effective_straits_start
            width = len(self.client.schema["straits"])
            for actor in (country, opponent):
                offset = base + self.encoder.countries.index(actor) * width
                self.assertEqual(bool(encoded[offset + index]), actor == country)

    def test_arden_forcing_only_when_random_discard_keeps_it(self):
        self.client.request(op="reset", seed=961, mode="A", cardSet="events")
        baseline = self.client.request(op="snapshot")["snapshot"]
        hand = baseline["state"]["decks"]["germany"]["hand"]
        chosen = [next(c for c in hand if c["definitionId"] == definition)
                  for definition in ("special_150", "special_158")]
        chosen.extend(c for c in hand if c["definitionId"] == "build_army" and
                      len(chosen) < 4)
        observed = set()
        for random_state in range(24):
            snapshot = copy.deepcopy(baseline)
            state = snapshot["state"]
            state["decks"]["germany"]["hand"] = chosen
            state["trainingCourse"]["openIds"]["germany"] = [c["id"] for c in chosen]
            state["trainingCourse"]["discardRandomState"] = random_state
            obs = self.client.request(op="restore", snapshot=snapshot)["observation"]
            white = next(c for c in obs["candidates"] if c.get("definitionId") == "special_150")
            after = self.client.request(op="step", action={**obs["decision"],
                                                            "actionId": white["id"]})["observation"]
            discard = self.client.request(op="snapshot")["snapshot"]["state"]["decks"]["germany"]["discardPile"]
            arden_discarded = any(c["definitionId"] == "special_158" for c in discard)
            index, label = stage2._scripted_choice(after, False, True)
            self.assertEqual(label == "arden_after_white", not arden_discarded)
            self.assertEqual(index is not None, not arden_discarded)
            observed.add(arden_discarded)
            if len(observed) == 2:
                break
        self.assertEqual(observed, {True, False})

    def test_migration_and_map_training_keep_architectures_separate(self):
        saved, _ = stage2.verify_source()
        flat = migrate_flat_state(saved, self.encoder)
        self.assertEqual(flat.state_net[0].weight.shape[1], self.encoder.state_dim)
        self.assertTrue(torch.count_nonzero(flat.state_net[0].weight[:,
            saved["network"]["stateDim"]:]) == 0)
        mapped = map_from_flat(flat, self.encoder)
        obs = self.client.request(op="reset", seed=933, mode="A", cardSet="events")["observation"]
        state, options = self.encoder.encode(obs)
        sample = batch_tensors([{"state": state, "candidates": options}], torch.device("cpu"))
        with torch.no_grad():
            old_logits, old_value = flat(*sample)
            map_logits, map_value = mapped(*sample)
        self.assertTrue(torch.equal(old_logits, map_logits))
        self.assertTrue(torch.equal(old_value, map_value))
        self.assertNotEqual(model_weights_sha256(flat), model_weights_sha256(mapped))
        self.assertEqual(make_network(MAP, self.encoder).architecture, mapped.architecture)
        with self.assertRaises(RuntimeError):
            make_network(FLAT, self.encoder).load_state_dict(mapped.state_dict())

        index = next(i for i, c in enumerate(obs["candidates"])
                     if c.get("definitionId") == "build_army")
        optimizer = torch.optim.Adam(mapped.parameters(), lr=1e-3)
        original = mapped.region_projection[0].weight.detach().clone()
        first = None
        for step in range(2):
            logits, value = mapped(*sample)
            loss = -logits[0, index] + 0.1 * value.square().mean()
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            gradient = mapped.region_projection[0].weight.grad.abs().sum().item()
            if step == 0:
                first = gradient
            optimizer.step()
        self.assertLess(first, 1e-10)
        self.assertGreater(gradient, 0)
        self.assertFalse(torch.equal(original, mapped.region_projection[0].weight))

    def test_checkpoint_architecture_is_strict(self):
        self.client.request(op="reset", seed=942, mode="A", cardSet="events")
        mapped = make_network(MAP, self.encoder)
        optimizer = torch.optim.Adam(mapped.parameters(), lr=3e-4)
        initial_hash = model_weights_sha256(mapped)
        payload = ppo.checkpoint_payload(mapped, optimizer, self.encoder, self.client,
            "A", 0, 0, random.Random(10), 20266930, "events", completed_episodes=0,
            training_seed=20266930, experiment_id="S2MAP", entropy_coefficient=.01,
            initial_weights_sha256=initial_hash, architecture=MAP)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.pt"
            torch.save(payload, path)
            restored = make_network(MAP, self.encoder)
            restored_optimizer = torch.optim.Adam(restored.parameters(), lr=3e-4)
            ppo.restore_checkpoint(path, restored, restored_optimizer, self.encoder,
                self.client, "A", random.Random(), "events", training_seed=20266930,
                experiment_id="S2MAP", entropy_coefficient=.01,
                initial_weights_sha256=initial_hash, architecture=MAP)
            self.assertEqual(model_weights_sha256(restored), initial_hash)
            wrong = make_network(FLAT, self.encoder)
            with self.assertRaises(ValueError):
                ppo.restore_checkpoint(path, wrong,
                    torch.optim.Adam(wrong.parameters()),
                    self.encoder, self.client, "A", random.Random(), "events",
                    training_seed=20266930, experiment_id="S2FLAT",
                    entropy_coefficient=.01, initial_weights_sha256=initial_hash,
                    architecture=FLAT)

    def test_scripted_vs_model_choices_and_random_arden_branch(self):
        saved, identity = stage2.verify_source()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            common = root / ".state" / "stage2" / "common-flat.pt"
            with patch.object(stage2, "verify_source", return_value=(saved, identity)), \
                 patch.object(stage2, "COMMON", common), \
                 patch.object(stage2, "DEMO_SEEDS", (20600001,)):
                output = stage2.generate_demonstrations(root, seeds=(20600001,))
                manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
                labels = torch.load(output / "expert-labels.pt", map_location="cpu", weights_only=False)
                self.assertEqual(len(manifest["episodes"]), 1)
                self.assertTrue(labels["labels"])
                self.assertTrue(all(item["label"] in ("white_plan", "arden_after_white")
                                    for item in labels["labels"]))
                import gzip
                with gzip.open(output / "seed-20600001.jsonl.gz", "rt", encoding="utf-8") as stream:
                    records = [json.loads(line) for line in stream]
                decisions = [row for row in records if row["type"] == "decision"]
                self.assertTrue(any(row["selectedBy"] == "frozen_model_sample" for row in decisions))
                self.assertEqual(sum(row["selectedBy"] == "script" for row in decisions),
                                 len(labels["labels"]))
                self.assertEqual(records[-1]["type"], "result")
                stage2.adapt_demonstrations(root)
                bc_report = json.loads(common.with_suffix(".json").read_text(encoding="utf-8"))
                self.assertGreater(bc_report["acceptedUpdates"], 0)
                self.assertFalse(bc_report["valueTargetsUsed"])
                self.assertFalse(bc_report["ppoSamplesUsed"])
                stage2.prepare_pair(root)
                for name, architecture in (("S2FLAT", FLAT), ("S2MAP", MAP)):
                    initial = torch.load(root / ".state" / "stage2" / f"{name}-initial.pt",
                                         map_location="cpu", weights_only=False)
                    self.assertEqual(initial["networkArchitecture"], architecture)
                    model = make_network(architecture, self.encoder)
                    model.load_state_dict(initial["modelState"])
                    self.assertEqual(model_weights_sha256(model), initial["weightsSha256"])

    def test_interrupted_pair_plan_does_not_add_flat_budget_twice(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            common = root / "common.pt"
            torch.save({"weightsSha256": "shared"}, common)
            plan_path = root / "plan.json"
            initials = {}
            for name in ("S2FLAT", "S2MAP"):
                path = root / f"{name}.pt"
                path.write_bytes(name.encode())
                initials[name] = (path, {"weightsSha256": name + "-hash",
                                         "sourceModelSha256": "source",
                                         "commonWeightsSha256": "shared"})
            completed = {"S2FLAT": 0, "S2MAP": 0}
            executed = []

            def fake_round(_, name, number, *unused):
                if completed[name] >= number:
                    return
                if name == "S2MAP" and not any(row[0] == "resume" for row in executed):
                    raise RuntimeError("simulated interruption after flat group")
                executed.append((name, number))
                completed[name] = number

            source = {"modelSha256": "source"}
            with patch.object(stage2, "verify_source", return_value=({}, source)), \
                 patch.object(stage2, "COMMON", common), \
                 patch.object(stage2, "PLAN", plan_path), \
                 patch.object(stage2, "_initial", side_effect=lambda _, name: initials[name]), \
                 patch.object(stage2, "progress", side_effect=lambda _, name, __:
                              (completed[name], completed[name] * 10)), \
                 patch.object(stage2, "complete_round", side_effect=fake_round), \
                 patch("torch.cuda.is_available", return_value=True):
                with self.assertRaisesRegex(RuntimeError, "simulated interruption"):
                    stage2.train_pair(root, rounds_to_add=1)
                pending = json.loads(plan_path.read_text(encoding="utf-8"))
                self.assertEqual(pending["status"], "pending")
                self.assertEqual(pending["targetRounds"], {"S2FLAT": 1, "S2MAP": 1})
                self.assertEqual(completed, {"S2FLAT": 1, "S2MAP": 0})
                with self.assertRaises(ValueError):
                    stage2.train_pair(root, rounds_to_add=1)
                executed.append(("resume", 0))
                stage2.train_pair(root, continue_plan=True)
            self.assertEqual(completed, {"S2FLAT": 1, "S2MAP": 1})
            self.assertEqual(executed.count(("S2FLAT", 1)), 1)
            self.assertEqual(json.loads(plan_path.read_text(encoding="utf-8"))["status"], "completed")


if __name__ == "__main__":
    unittest.main()
