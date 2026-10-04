import copy
import unittest

from scripts.ppo_train import ArenaClient, Encoder


class A2S1UseCountEncodingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = ArenaClient(card_set="signals")
        cls.encoder = Encoder(cls.client.schema)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def test_turn_and_round_uses_change_the_actual_tensor_independently(self):
        obs = self.client.request(op="reset", seed=410, mode="A", cardSet="signals")["observation"]
        self.assertIn("special_137", self.encoder.cards)
        baseline = self.encoder.encode_state(obs)
        turn = copy.deepcopy(obs)
        turn["visibleUseCounts"]["special_137"] = 1
        turn_vector = self.encoder.encode_state(turn)
        changed_turn = [i for i, (a, b) in enumerate(zip(baseline, turn_vector)) if a != b]
        self.assertEqual(len(changed_turn), 1)
        self.assertAlmostEqual(turn_vector[changed_turn[0]] - baseline[changed_turn[0]], 1 / 3)
        per_round = copy.deepcopy(obs)
        per_round["visibleRoundUseCounts"]["special_137"] = 1
        round_vector = self.encoder.encode_state(per_round)
        changed_round = [i for i, (a, b) in enumerate(zip(baseline, round_vector)) if a != b]
        self.assertEqual(len(changed_round), 1)
        self.assertNotEqual(changed_turn[0], changed_round[0])
        missing = copy.deepcopy(obs)
        del missing["visibleRoundUseCounts"]
        with self.assertRaisesRegex(ValueError, "current-round use"):
            self.encoder.encode_state(missing)


if __name__ == "__main__":
    unittest.main()
