"""Fixed, read-only C3 evaluation. No scripted choices or PPO samples."""
from __future__ import annotations

import random
import time

import torch

from scripts import ppo_train as ppo
from scripts.ppo_combo_c3_metrics import CARDS

NORMAL_SEEDS = (20630001, 20630002)
COURSE_SEED = 20630003


def _card(candidate):
    return candidate.get("definitionId") or next((choice.get("definitionId")
        for choice in candidate.get("choices") or []
        if choice.get("kind") == "trigger"), None)


def _profile(model, encoder, observation, card):
    state, choices = encoder.encode(observation)
    with torch.inference_mode():
        logits, _ = model(*ppo.batch_tensors([{"state": state,
            "candidates": choices}], torch.device("cpu")))
        probabilities = logits[0, :len(choices)].softmax(-1)
    rows = [{"candidateId": candidate["id"],
             "probability": float(probabilities[index]),
             "rank": int((logits[0, :len(choices)] > logits[0, index]).sum()) + 1}
            for index, candidate in enumerate(observation["candidates"])
            if _card(candidate) == card]
    return {"cardProbability": sum(row["probability"] for row in rows),
        "specificCandidates": rows, "bestRank": min((row["rank"] for row in rows),
                                                     default=None),
        "candidateCount": len(choices)}


def _fixed_scene(client, model, encoder, entry, card, limit=120):
    observation = client.request(op="restore", snapshot=entry["snapshot"])["observation"]
    rng = random.Random((entry["seed"] << 32) ^ COURSE_SEED)
    for offset in range(limit):
        if observation is None:
            break
        if any(_card(candidate) == card for candidate in observation["candidates"]):
            return {"opportunityFound": True, "decisionsFromTakeover": offset,
                "round": observation["round"], "decisionId":
                    observation["decision"]["decisionId"],
                **_profile(model, encoder, observation, card)}
        state, choices = encoder.encode(observation)
        index, _, _ = ppo.select_action(model, state, choices, torch.device("cpu"),
                                         deterministic=True, rng=rng)
        chosen = observation["candidates"][index]
        observation = client.request(op="step", action={**observation["decision"],
            "actionId": chosen["id"]})["observation"]
    return {"opportunityFound": False, "decisionsFromTakeover": offset + 1,
            "cardProbability": None, "specificCandidates": [], "bestRank": None}


def fixed_evaluation(model, encoder, entries, *, include_normal=True):
    from scripts.ppo_combo_v2_eval import normal_game
    start = time.perf_counter()
    client = ppo.ArenaClient(card_set="signals")
    try:
        result = []
        for template, card in (("G1", "special_136"), ("U4", "special_84"),
                               ("J1", "special_199")):
            for layer in ("preparation", "payoff"):
                entry = next(item for item in entries if item["split"] == "evaluation" and
                             item["template"] == template and item["variant"] == "positive" and
                             item["layer"] == layer)
                result.append({"template": template, "cardId": card, "layer": layer,
                    "courseId": entry["courseId"], "seed": entry["seed"],
                    "fixedReviewedRegressionSet": True,
                    "choice": _fixed_scene(client, model, encoder, entry, card)})
        normal = ([normal_game(client, encoder, model, NORMAL_SEEDS[0], True),
                   normal_game(client, encoder, model, NORMAL_SEEDS[1], False)]
                  if include_normal else [])
        return {"format": "a2s1c3-fixed-evaluation-v1",
            "courseChoices": result, "normalGames": normal,
            "evaluationSeconds": time.perf_counter() - start,
            "limitation": "Reviewed fixed C2 scenes; self-play behavior is not an absolute strength measure."}
    finally:
        client.close()
