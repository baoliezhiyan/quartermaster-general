"""One paired read-only comparison: telemetry on/off, no PPO update."""
from __future__ import annotations

import json
import random

import torch

from scripts import ppo_combo_c3_rounds as c3
from scripts import ppo_combo_metrics as combo
from scripts import ppo_train as ppo
from scripts.ppo_combo_c3_metrics import summarize_detail
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network


def run(seed=20630001):
    initial, _, _ = c3.identity()
    clients = [ppo.ArenaClient(card_set="signals") for _ in range(2)]
    try:
        encoder = ppo.Encoder(clients[0].schema)
        model = make_network(A2S1_ADAPTER, encoder)
        model.load_state_dict(initial["modelState"], strict=True)
        model.eval()
        observations = [client.request(op="reset", seed=seed, mode="A",
                                       cardSet="signals", comboTelemetry=bool(index))[
                                           "observation"]
                        for index, client in enumerate(clients)]
        tracker = combo.new_tracker(None, observations[1], detail=True)
        rng = random.Random(seed)
        for decision_count in range(3000):
            def without_instance_id(value):
                if isinstance(value, dict):
                    return {key: without_instance_id(item) for key, item in value.items()
                            if key != "episodeId"}
                if isinstance(value, list):
                    return [without_instance_id(item) for item in value]
                return value
            if without_instance_id(observations[0]) != without_instance_id(observations[1]):
                raise AssertionError(f"Arena observations diverged at decision {decision_count}")
            if observations[0] is None:
                break
            state, candidates = encoder.encode(observations[0])
            index, _, _ = ppo.select_action(model, state, candidates,
                torch.device("cpu"), deterministic=True, rng=rng)
            chosen = observations[0]["candidates"][index]
            plain = clients[0].request(op="step", action={**observations[0]["decision"],
                "actionId": chosen["id"]})
            tracked = clients[1].request(op="step", action={**observations[1]["decision"],
                "actionId": chosen["id"]}, comboTelemetry=True)
            if (without_instance_id(plain["observation"]) !=
                    without_instance_id(tracked["observation"]) or
                without_instance_id(plain["info"]) != without_instance_id(tracked["info"]) or
                plain["result"] != tracked["result"]):
                raise AssertionError(f"Read-only telemetry changed result at decision {decision_count}")
            combo.record_step(tracker, tracked["comboTelemetry"],
                              observations[0]["decision"]["decisionId"])
            observations = [plain["observation"], tracked["observation"]]
            if plain["result"]:
                if plain["result"]["termination"] != "natural":
                    raise AssertionError("Smoke game was not a natural ending")
                return {"seed": seed, "decisions": decision_count + 1,
                    "winner": plain["result"]["winner"],
                    "telemetry": summarize_detail(tracker, {"jobId": "smoke"}, 0)}
        raise AssertionError("Smoke game did not finish within 3000 decisions")
    finally:
        for client in clients:
            client.close()


if __name__ == "__main__":
    result = run()
    print(json.dumps({"seed": result["seed"], "decisions": result["decisions"],
                      "winner": result["winner"], "readOnlyEquivalent": True,
                      "metricsVersion": result["telemetry"]["version"]},
                     ensure_ascii=False))
