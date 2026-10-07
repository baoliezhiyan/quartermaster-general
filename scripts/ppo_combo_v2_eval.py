"""Fixed A2S1C2 actor diagnostics; no PPO updates or scripted normal opening."""
from __future__ import annotations

import argparse
import gzip
import json
import random
from collections import Counter
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_combo_course_v2 import BY_KEY
from scripts.ppo_combo_metrics import CARD_IDS
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network

TRANSFER_IDS = ("special_83", "special_193")  # registered before inspecting results
NORMAL_SEEDS = (20620001, 20620002)


def _card(candidate):
    direct = candidate.get("definitionId")
    if direct:
        return direct
    return next((choice.get("definitionId") for choice in candidate.get("choices") or ()
                 if choice.get("kind") == "trigger"), None)


def _profile(model, encoder, observation, card_ids):
    state, candidates = encoder.encode(observation)
    with torch.no_grad():
        logits, value = model(*ppo.batch_tensors([{"state": state,
                                                  "candidates": candidates}], torch.device("cpu")))
        logits = logits[0, :len(candidates)]
        probabilities = logits.softmax(-1)
    rows = []
    for index, candidate in enumerate(observation["candidates"]):
        card = _card(candidate)
        if card in card_ids:
            rows.append({"cardId": card, "candidateId": candidate["id"],
                "probability": float(probabilities[index]),
                "rank": int((logits > logits[index]).sum()) + 1,
                "legalCandidates": len(candidates)})
    return {"cards": rows, "value": float(value[0]), "candidateCount": len(candidates)}


def _load_model(path, encoder, expected=None):
    saved = torch.load(path, map_location="cpu", weights_only=False)
    if expected and saved.get("experimentId") != expected:
        raise ValueError(f"Model experiment differs: {path}")
    model = make_network(A2S1_ADAPTER, encoder)
    model.load_state_dict(saved["modelState"], strict=True)
    model.eval()
    return model, ppo.model_weights_sha256(model)


def normal_game(client, encoder, model, seed, deterministic):
    observation = client.request(op="reset", seed=seed, mode="A", cardSet="signals")["observation"]
    rng = random.Random((seed << 32) ^ (0xC2 if deterministic else 0xC3))
    opportunities, selections = Counter(), Counter()
    other_blitz = {"opportunities": 0, "selected": 0}
    for decisions in range(3000):
        if observation is None:
            break
        candidates = observation["candidates"]
        available = {_card(item) for item in candidates}
        for card in TRANSFER_IDS:
            if card in available:
                opportunities[card] += 1
        blitz = [item for item in candidates if _card(item) == "special_136" and
                 any(choice.get("regionId") not in ("ukraine", "western_europe", None)
                     for choice in item.get("choices") or ())]
        if blitz:
            other_blitz["opportunities"] += 1
        state, encoded = encoder.encode(observation)
        index, _, _ = ppo.select_action(model, state, encoded, torch.device("cpu"),
                                         deterministic=deterministic, rng=rng)
        chosen = candidates[index]
        card = _card(chosen)
        if card in TRANSFER_IDS:
            selections[card] += 1
        if chosen in blitz:
            other_blitz["selected"] += 1
        response = client.request(op="step", action={**observation["decision"],
                                                     "actionId": chosen["id"]})
        outcome = response["result"]
        observation = response["observation"]
    else:
        raise RuntimeError("Fixed normal evaluation hit the 3000-decision safety limit")
    if outcome["termination"] != "natural":
        raise RuntimeError("Fixed normal evaluation did not end naturally")
    return {"seed": seed, "sampling": "greedy" if deterministic else "policy-probability",
            "decisions": decisions + 1, "winner": outcome["winner"],
            "allianceScores": outcome["allianceScores"],
            "transferOpportunity": dict(opportunities),
            "transferSelection": dict(selections),
            "taughtCardNewRegion": other_blitz}


def evaluate(parent, adapted, pool, normal_seeds=NORMAL_SEEDS):
    torch.set_num_threads(2)
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        before, before_sha = _load_model(parent, encoder, "A2S1C1")
        after, after_sha = _load_model(adapted, encoder, "A2S1C2")
        with gzip.open(pool, "rt", encoding="utf-8") as stream:
            entries = json.load(stream)["entries"]
        if not entries or not any(e.get("split") == "evaluation" for e in entries):
            raise ValueError("Evaluation starts must remain separate from demonstration labels")
        for template in BY_KEY:
            training_seeds = {e["seed"] for e in entries if e["template"] == template and
                              e["split"] == "train"}
            evaluation_seeds = {e["seed"] for e in entries if e["template"] == template and
                                e["split"] == "evaluation"}
            if training_seeds & evaluation_seeds:
                raise ValueError("A preparation trajectory appears in both splits")
        scenes = []
        for entry in entries:
            if entry["split"] != "evaluation":
                continue
            observation = client.request(op="restore", snapshot=entry["snapshot"])["observation"]
            cards = CARD_IDS[entry["template"]]
            scenes.append({"courseId": entry["courseId"], "template": entry["template"],
                "variant": entry["variant"], "layer": entry["layer"],
                "startRound": entry["snapshot"]["state"]["round"],
                "before": _profile(before, encoder, observation, cards),
                "after": _profile(after, encoder, observation, cards)})
        normal = []
        for name, model in (("before", before), ("after", after)):
            for seed in normal_seeds:
                for greedy in (True, False):
                    normal.append({"model": name, **normal_game(client, encoder, model, seed, greedy)})
        return {"format": "a2s1c2-three-layer-diagnostic-v1",
                "buildFingerprint": client.fingerprint,
                "beforeWeightsSha256": before_sha, "afterWeightsSha256": after_sha,
                "taughtCombinationHoldout": scenes,
                "taughtCardOtherRegionAndSimilarUnshownMechanisms": normal,
                "registeredUnshownCards": TRANSFER_IDS,
                "limitation": "Same-policy games are behavior diagnostics, not an overall strength benchmark; zero opportunity means untested."}
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser(description="Bounded C2 before/after diagnostics")
    parser.add_argument("--parent", type=Path, default=ppo.ROOT / "PPO训练" /
                        ".state" / "A2S1C1" / "latest.pt")
    parser.add_argument("--adapted", type=Path, default=ppo.ROOT / "PPO训练" /
                        ".state" / "A2S1C2" / "post-demonstration.pt")
    parser.add_argument("--pool", type=Path, default=ppo.ROOT / "PPO训练" /
                        ".state" / "A2S1C2" / "course-pool-v8.json.gz")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = evaluate(args.parent, args.adapted, args.pool)
    content = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        if args.output.exists():
            raise FileExistsError(args.output)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content, encoding="utf-8")
    print(content)


if __name__ == "__main__":
    main()
