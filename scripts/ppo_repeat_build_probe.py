"""Read-only, deterministic policy probe for the three repeated-build scenes."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import subprocess
from pathlib import Path

import torch

from scripts import ppo_train as ppo


def scene(client, seat, extra_units, seed=871):
    client.request(op="reset", seed=seed, mode="A", cardSet="events")
    snapshot = client.request(op="snapshot")["snapshot"]
    state = snapshot["state"]
    state.update(activeSeat=seat, operatorSeat=seat, viewSeat=seat,
                 phase="PLAY", status="PLAYING", resolution=None)
    state["units"].extend(extra_units)
    return client.request(op="restore", snapshot=snapshot)["observation"]


def preference(model, encoder, observation, focus):
    state, candidates = encoder.encode(observation)
    device = next(model.parameters()).device
    with torch.inference_mode():
        logits, _ = model(*ppo.batch_tensors([{"state": state, "candidates": candidates}],
                                            device))
        probabilities = logits[0, :len(candidates)].softmax(-1).tolist()
    order = sorted(range(len(probabilities)), key=lambda i: (-probabilities[i], i))
    focus_index = next(i for i, candidate in enumerate(observation["candidates"]) if focus(candidate))
    return {"candidateCount": len(probabilities), "focusRank": order.index(focus_index) + 1,
            "focusProbability": probabilities[focus_index],
            "topFive": [{"definitionId": observation["candidates"][i].get("definitionId"),
                         "regionId": (observation["candidates"][i].get("choices") or [{}])[0].get("regionId"),
                         "repeated": (observation["candidates"][i].get("choices") or [{}])[0].get("repeated"),
                         "probability": probabilities[i]} for i in order[:5]]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model", type=Path, nargs="+")
    args = parser.parse_args()
    client = ppo.ArenaClient()
    try:
        encoder = ppo.Encoder(client.schema)
        report = {"sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"],
                   cwd=ppo.ROOT, text=True).strip(), "arenaBuildFingerprint": client.fingerprint,
                  "sceneRulesFingerprint": json.loads((ppo.ROOT / "src/matchLog/build-identity.json")
                                               .read_text(encoding="utf-8"))["rulesFingerprint"],
                  "observationSchema": client.schema["observationSchemaVersion"], "models": []}
        valid = scene(client, "soviet_union", [])
        repeated = scene(client, "soviet_union", [{"id": "probe:ukraine", "country": "soviet_union",
                                                  "type": "army", "regionId": "ukraine"}])
        legacy_repeated = copy.deepcopy(repeated)
        for candidate in legacy_repeated["candidates"]:
            for choice in candidate.get("choices") or []:
                if choice.get("kind") == "action_plan" and choice.get("action") in ("build_army", "build_navy"):
                    choice.pop("repeated", None)
        event = scene(client, "italy", [{"id": "probe:italy:ukraine", "country": "italy",
                                         "type": "army", "regionId": "ukraine"}])
        for path in args.model:
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            saved = torch.load(path, map_location="cpu", weights_only=False)
            model = ppo.PpoNetwork(encoder.state_dim, encoder.candidate_dim)
            model.load_state_dict(saved["modelState"])
            model.eval()
            focus = lambda candidate, definition: candidate.get("definitionId") == definition
            report["models"].append({"path": str(path.resolve()),
                "sha256": digest.hexdigest(), "round": saved.get("round"),
                "checkpointEncoderVersion": saved.get("encoderVersion"),
                "validBuild": preference(model, encoder, valid, lambda c: focus(c, "build_army") and
                                         c["choices"][0].get("regionId") == "ukraine"),
                "repeatedBuildOriginalV4": preference(model, encoder, legacy_repeated,
                    lambda c: focus(c, "build_army") and c["choices"][0].get("regionId") == "ukraine"),
                "repeatedBuildCorrectedV5": preference(model, encoder, repeated, lambda c: focus(c, "build_army") and
                                            c["choices"][0].get("regionId") == "ukraine"),
                "partialEvent": preference(model, encoder, event, lambda c: focus(c, "special_238"))})
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        client.close()


if __name__ == "__main__":
    main()
