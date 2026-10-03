"""Small, non-PPO acceptance checks for the A1S2 white-plan derivative."""
from __future__ import annotations

import json
import random

import torch

from scripts import ppo_train as ppo
from scripts.ppo_a1s2_adapt import OUTPUT, file_sha256, load_parent, summary, east_probes, load_labels
from scripts.ppo_network_factory import ADAPTED_MAP, make_network


def validate(samples=100):
    if samples < 20:
        raise ValueError("Sampling check requires at least 20 independent seeds")
    path = OUTPUT / "模型.pt"
    payload = torch.load(path, map_location="cpu", weights_only=False)
    client = ppo.ArenaClient()
    try:
        encoder, parent, identity = load_parent(client)
        labels, controls, data = load_labels(encoder)
        if (payload.get("format") != "quartermaster-a1s2-white-plan-adapted-v1" or
            payload.get("parent") != identity or payload.get("dataSha256") != data["fileSha256"] or
            payload.get("networkArchitecture") != ADAPTED_MAP or
            payload.get("buildFingerprint") != client.fingerprint):
            raise ValueError("Adapted model parent, labels or build differ")
        model = make_network(ADAPTED_MAP, encoder)
        model.load_state_dict(payload["modelState"])
        model.eval()
        if ppo.model_weights_sha256(model) != payload["weightsSha256"]:
            raise ValueError("Reloaded adapted weights differ")
        probes = east_probes(client, encoder)
        before = summary(parent, probes + controls, torch.device("cpu"))
        after = summary(model, probes + controls, torch.device("cpu"))
        value_drift = max(abs(after[key]["value"] - before[key]["value"]) for key in after)
        opening = after["east_vacant"]
        invalid = {key: after[key]["whiteProbability"] for key in
                   ("east_repeated", "east_blocked", "east_friendly")}
        if (opening["whiteRank"] != 1 or not .65 <= opening["whiteProbability"] <= .78 or
            value_drift > 1e-7 or max(invalid.values()) > .1):
            raise AssertionError("Adaptation acceptance checks failed after reload")
        # Full engine choices, not just model readouts. The first game retains
        # Arden; the second is the real resource-discard seed from the demo.
        executions = []
        for seed, expect_arden in ((20600000, True), (20600020, False)):
            obs = client.request(op="reset", seed=seed, mode="A", cardSet="events")["observation"]
            state, choices = encoder.encode(obs)
            with torch.inference_mode():
                logits, _ = model(*ppo.batch_tensors([{"state": state, "candidates": choices}], "cpu"))
            first = obs["candidates"][int(logits[0, :len(choices)].argmax())]
            if first.get("definitionId") != "special_150":
                raise AssertionError("Argmax did not play white plan")
            response = client.request(op="step", action={**obs["decision"], "actionId": first["id"]})
            extra = response["observation"]
            recruited = any(unit["country"] == "germany" and unit["type"] == "army" and
                            unit["regionId"] == "eastern_europe" for unit in extra["units"])
            if not recruited or extra.get("choiceKind") != "EXTRA_CARD":
                raise AssertionError("White plan did not recruit and reach extra-card choice")
            legal_arden = [i for i, candidate in enumerate(extra["candidates"])
                           if "germany:special_158" in (candidate.get("choiceIds") or ())]
            state, choices = encoder.encode(extra)
            with torch.inference_mode():
                logits, _ = model(*ppo.batch_tensors([{"state": state, "candidates": choices}], "cpu"))
            second = extra["candidates"][int(logits[0, :len(choices)].argmax())]
            if bool(legal_arden) != expect_arden or (expect_arden and
                    "germany:special_158" not in (second.get("choiceIds") or ())):
                raise AssertionError("Arden legality or priority differs from real discard result")
            client.request(op="step", action={**extra["decision"], "actionId": second["id"]})
            executions.append({"seed": seed, "whitePlayed": True, "eastRecruited": recruited,
                               "ardenLegal": bool(legal_arden), "extraSelected": second["id"]})
        sampled_white = 0
        for seed in range(20710000, 20710000 + samples):
            obs = client.request(op="reset", seed=seed, mode="A", cardSet="events")["observation"]
            state, choices = encoder.encode(obs)
            with torch.inference_mode():
                logits, _ = model(*ppo.batch_tensors([{"state": state, "candidates": choices}], "cpu"))
                probs = logits[0, :len(choices)].softmax(-1).tolist()
            draw = random.Random(seed ^ 0xA152).random()
            running, chosen = 0.0, len(probs) - 1
            for index, probability in enumerate(probs):
                running += probability
                if draw < running:
                    chosen = index
                    break
            selected = obs["candidates"][chosen]
            if selected.get("definitionId") == "special_150":
                sampled_white += 1
            client.request(op="step", action={**obs["decision"], "actionId": selected["id"]})
        outcome = {"format": "quartermaster-a1s2-white-plan-acceptance-v1",
                   "derivedModelSha256": file_sha256(path), "parent": identity,
                   "sampleSeedStart": 20710000, "sampleCount": samples,
                   "sampledWhiteCount": sampled_white,
                   "sampledWhiteRate": sampled_white / samples,
                   "expectedWhiteProbability": opening["whiteProbability"],
                   "executions": executions,
                   "openingAndControlsBefore": before, "openingAndControlsAfter": after,
                   "maximumValueDrift": value_drift,
                   "ardenLabelCount": sum(item["label"] == "arden_after_white" for item in labels),
                   "noPpoSamples": True}
        (OUTPUT / "验收.json").write_text(json.dumps(outcome, ensure_ascii=False, indent=2), encoding="utf-8")
        return outcome
    finally:
        client.close()


if __name__ == "__main__":
    result = validate()
    print(json.dumps({key: result[key] for key in
        ("sampleCount", "sampledWhiteCount", "sampledWhiteRate", "executions", "maximumValueDrift")},
        ensure_ascii=False))
