"""Short natural games only; this test never starts a 40-game training update."""
import json
import random
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

from scripts import ppo_rounds as rounds
from scripts import ppo_stage2 as stage2
from scripts import ppo_train as ppo
from scripts.ppo_network_factory import FLAT, MAP, map_from_flat, migrate_flat_state


class StageTwoRuntimeTests(unittest.TestCase):
    def test_both_architectures_short_game_update_save_and_replay(self):
        saved, _ = stage2.verify_source()
        for architecture in (FLAT, MAP):
            with self.subTest(architecture=architecture), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                raw = root / "raw.jsonl"
                client = ppo.ArenaClient(log_path=raw, log_snapshots=True)
                try:
                    encoder = ppo.Encoder(client.schema)
                    flat = migrate_flat_state(saved, encoder)
                    model = flat if architecture == FLAT else map_from_flat(flat, encoder)
                    model.eval()
                    digest = ppo.model_weights_sha256(model)
                    seed = 907
                    metadata = {"round": 0, "policyVersion": 30, "experimentId": "short-test",
                        "resourceMode": "A", "entropyCoefficient": .01,
                        "trainingSeed": stage2.TRAIN_SEED, "recordSeed": seed,
                        "controller": "same-policy-self-play-both-teams",
                        "actionSampling": "deterministic-greedy-argmax", "modelSha256": digest,
                        "recordScope": "full-training-scene-replay-v1",
                        "networkArchitecture": architecture}
                    result = ppo.play_episode(client, encoder, model, torch.device("cpu"), "A", seed,
                        3000, trace="full", rng=random.Random(seed), card_set="events",
                        record_metadata=metadata, deterministic=True)
                    self.assertEqual(result["outcome"]["termination"], "natural")
                    self.assertGreater(result["decisions"], 0)
                    optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
                    before = ppo.model_weights_sha256(model)
                    metrics = ppo.ppo_update(model, optimizer, result["samples"],
                        torch.device("cpu"), random.Random(1), epochs=1, minibatch=32,
                        entropy_coefficient=.01)
                    self.assertGreater(metrics["samples"], 0)
                    self.assertNotEqual(ppo.model_weights_sha256(model), before)
                    model_file = root / "short-model.pt"
                    torch.save({"networkArchitecture": architecture,
                                "modelState": model.state_dict(),
                                "optimizerState": optimizer.state_dict()}, model_file)
                    restored = flat.__class__(encoder.state_dim, encoder.candidate_dim) if architecture == FLAT \
                        else map_from_flat(migrate_flat_state(saved, encoder), encoder)
                    restored_optimizer = torch.optim.Adam(restored.parameters(), lr=3e-4)
                    stored = torch.load(model_file, map_location="cpu", weights_only=False)
                    self.assertEqual(stored["networkArchitecture"], architecture)
                    restored.load_state_dict(stored["modelState"])
                    restored_optimizer.load_state_dict(stored["optimizerState"])
                    self.assertEqual(ppo.model_weights_sha256(model), ppo.model_weights_sha256(restored))
                finally:
                    client.close()
                prior_digest = rounds.validate_record(raw, result["decisions"], seed)
                with raw.open("a", encoding="utf-8", newline="\n") as stream:
                    stream.write(json.dumps({"recordType": "trainingSummary", "seed": seed,
                        "controller": "same-policy-self-play-both-teams",
                        "decisions": result["decisions"], "countryTurns": result["countryTurns"],
                        "winner": result["outcome"]["winner"],
                        "allianceScores": result["outcome"]["allianceScores"],
                        "sha256OfPriorLines": prior_digest}) + "\n")
                replay = root / "replay.jsonl"
                subprocess.run(["node", "scripts/ppo-export-training-replay.mjs",
                                str(raw), str(replay)], cwd=ppo.ROOT, check=True,
                               stdout=subprocess.PIPE, text=True)
                with replay.open(encoding="utf-8") as stream:
                    header = json.loads(stream.readline())
                self.assertEqual(header["type"], "header")
                self.assertEqual(header["formatVersion"], 3)
                if architecture == MAP:
                    # Exercise the production round exporter and its network factory.
                    initial_hash = ppo.model_weights_sha256(model)
                    checkpoint = root / "round-boundary.pt"
                    torch.save(ppo.checkpoint_payload(model, optimizer, encoder, client,
                        "A", 0, 0, random.Random(7), stage2.TRAIN_SEED, "events",
                        completed_episodes=0, training_seed=stage2.TRAIN_SEED,
                        experiment_id="S2MAP", entropy_coefficient=.01,
                        initial_weights_sha256=initial_hash, architecture=MAP), checkpoint)
                    exported = root / "round-export.jsonl"
                    rounds.record_game(checkpoint, exported, "A", 0, stage2.TRAIN_SEED,
                        stage2.sha256(model_file), experiment_id="S2MAP",
                        entropy_coefficient=.01, initial_weights_sha256=initial_hash,
                        architecture=MAP)
                    with exported.open(encoding="utf-8") as stream:
                        production_header = json.loads(stream.readline())
                    self.assertEqual(production_header["training"]["configuration"]
                                     ["networkArchitecture"], MAP)
                    with patch.object(stage2, "EVAL_SEEDS", (907,)):
                        evaluation = stage2.evaluate_round(checkpoint, "S2MAP",
                            initial_hash, stage2.verify_source()[0], root / "evaluation.json")
                    self.assertEqual(len(evaluation["games"]), 2)
                    self.assertEqual(evaluation["actionSampling"], "policy-probability")
