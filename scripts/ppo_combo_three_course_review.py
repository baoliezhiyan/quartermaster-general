"""Read-only post-selection checks for the bounded three-course candidate."""
from __future__ import annotations

import collections
import gzip
import json
import random

import torch

from scripts import ppo_train as ppo
from scripts import ppo_combo_bc as bc
from scripts import ppo_combo_three_course as study
from scripts.ppo_combo_metrics import new_tracker, record_step, summarize
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network


def opening(client, encoder, model, seed, stochastic, limit):
    observation = client.request(op="reset", seed=seed, mode="A",
                                 cardSet="signals", comboTelemetry=True)["observation"]
    snapshot = client.request(op="snapshot")["snapshot"]
    trackers = {key: new_tracker(f"{key}:normal:preparation:{seed}", snapshot)
                for key in study.TARGETS}
    rng = random.Random(seed ^ 0x71A2)
    first_source, selected, opportunities = {}, collections.Counter(), collections.Counter()
    result = None
    decisions = 0
    for offset in range(limit):
        if observation is None:
            break
        if observation["node"] == "SOURCE":
            for key, card in study.TARGETS.items():
                if (observation["decisionSeat"] == study.OWNERS[key] and any(
                    candidate.get("definitionId") == card for candidate in
                    observation["candidates"])):
                    opportunities[key] += 1
        state, candidates = encoder.encode(observation)
        index, _, _ = ppo.select_action(model, state, candidates, torch.device("cpu"),
            rng=rng, deterministic=not stochastic)
        action = observation["candidates"][index]
        if observation["node"] == "SOURCE":
            first_source.setdefault(observation["decisionSeat"], action.get(
                "definitionId") or action.get("kind"))
            if action.get("definitionId") in study.TARGETS.values():
                selected[action["definitionId"]] += 1
        response = client.request(op="step", action={**observation["decision"],
            "actionId": action["id"]}, comboTelemetry=True)
        for tracker in trackers.values():
            record_step(tracker, response.get("comboTelemetry"), offset)
        decisions += 1
        observation, result = response["observation"], response.get("result")
        if result is not None:
            break
    outcome = result or {"winner": "allies", "allianceScores": {"axis": 0,
                                                                   "allies": 0}}
    return {"seed": seed, "stochastic": stochastic, "decisions": decisions,
        "naturalTerminal": result is not None, "firstSourceBySeat": first_source,
        "targetOpportunities": dict(opportunities),
        "targetSelections": dict(selected),
        "combo": {key: {name: summary.get(name) for name in
            ("specifiedComboAchieved", "tacticalResultAchieved", "comboStatus",
             "comboMatchedSteps", "comboRequiredSteps", "telemetryMissing")}
            for key, tracker in trackers.items() for summary in
            [summarize(tracker, outcome)]}}


def main():
    torch.set_num_threads(2)
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        baseline, _, identity = study.open_models(encoder)
        saved = torch.load(study.ROOT / "candidate.pt", map_location="cpu",
                           weights_only=False)
        candidate = make_network(A2S1_ADAPTER, encoder)
        candidate.load_state_dict(saved["modelState"], strict=True)
        if ppo.model_weights_sha256(candidate) != saved["weightsSha256"]:
            raise ValueError("Candidate weight hash differs after reload")
        with gzip.open(study.BASE / "course-pool-v8.json.gz", "rt",
                       encoding="utf-8") as stream:
            existing = json.load(stream)
        other = [entry for entry in existing["entries"] if entry["template"] not in
                 study.TARGETS]
        observations = bc.assess_holdout(client, encoder, baseline, candidate, other)
        plan = json.loads(study.PLAN.read_text(encoding="utf-8"))
        seeds = plan["evaluation"]["normalOpeningSeeds"]
        limit = plan["evaluation"]["normalOpeningMaxDecisions"]
        rows = []
        for name, model in (("baseline", baseline), ("candidate", candidate)):
            for stochastic in (False, True):
                for seed in seeds:
                    rows.append({"model": name, **opening(client, encoder, model,
                        seed, stochastic, limit)})
        output = {"format": "three-course-read-only-postselection-v1",
            "source": identity, "candidateWeightsSha256": saved["weightsSha256"],
            "normalOpenings": rows,
            "sixUntaughtTemplates": [row for row in observations["scenes"] if
                row["template"] not in study.TARGETS]}
        study.atomic_new_json(study.ROOT / "postselection-review.json", output)
        print(json.dumps({"normalGames": len(rows),
            "sixUntaughtScenes": len(output["sixUntaughtTemplates"]),
            "candidateWeightsSha256": saved["weightsSha256"]}, ensure_ascii=False))
    finally:
        client.close()


if __name__ == "__main__":
    main()
