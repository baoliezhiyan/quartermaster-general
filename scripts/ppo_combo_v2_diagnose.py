"""Fixed-scene actor/encoder diagnostics; counterfactuals never enter training.

The B scene comes from a replayable C1 start. A/C/D change exactly the listed
public rule facts in a disposable snapshot and are only representation probes.
"""
from __future__ import annotations

import copy
import gzip
import json
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts import ppo_combo_course as first
from scripts import ppo_combo_course_v2 as second
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network


def _candidate(observation, card, region):
    return next((i for i, c in enumerate(observation["candidates"]) if
        c.get("definitionId") == card and any(x.get("regionId") == region
        for x in c.get("choices") or ())), None)


def _probe(client, encoder, model, name, snapshot, card, region):
    observation = client.request(op="restore", snapshot=snapshot)["observation"]
    state, choices = encoder.encode(observation)
    index = _candidate(observation, card, region)
    with torch.no_grad():
        logits, values = model(*ppo.batch_tensors([{"state": state,
                                                   "candidates": choices}], torch.device("cpu")))
        logits = logits[0, :len(choices)]
        probabilities = torch.softmax(logits, -1)
    selected = (None if index is None else {"probability": float(probabilities[index]),
        "rank": int((logits > logits[index]).sum()) + 1,
        "candidateId": observation["candidates"][index]["id"],
        "candidateVector": choices[index].tolist()})
    return {"name": name, "state": state, "selected": selected,
            "candidateCount": len(choices), "value": float(values[0])}


def _four_way(client, encoder, model, base, status, card, region,
              no_target, no_fee):
    variants = {"B_installed_target_payable": copy.deepcopy(base)}
    a = copy.deepcopy(base)
    deck = a["state"]["decks"][a["state"]["activeSeat"]]
    moved = next(c for c in deck["active"] if c["definitionId"] == status)
    deck["active"].remove(moved)
    deck["discardPile"].append(moved)
    variants["A_not_installed"] = a
    c = copy.deepcopy(base)
    no_target(c)
    variants["C_installed_no_target"] = c
    d = copy.deepcopy(base)
    no_fee(d)
    variants["D_installed_fee_scarce"] = d
    probes = [_probe(client, encoder, model, name, snapshot, card, region)
              for name, snapshot in variants.items()]
    baseline = probes[0]
    return [{"scene": item["name"], "candidateCount": item["candidateCount"],
             "action": {k: v for k, v in item["selected"].items()
                        if k != "candidateVector"} if item["selected"] else None,
             "changedStateCoordinatesVsInstalled": int((item["state"] != baseline["state"]).sum()),
             "sameCandidateEncodingVsInstalled": item["selected"] is not None and
                baseline["selected"] is not None and
                item["selected"]["candidateVector"] == baseline["selected"]["candidateVector"],
             "value": item["value"]} for item in probes]


def compare(parent_path: Path, c1_pool: Path):
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        saved = torch.load(parent_path, map_location="cpu", weights_only=False)
        if saved.get("experimentId") != "A2S1C1" or saved.get("update") != 30:
            raise ValueError("Diagnostic needs the exact C1 update-30 model")
        model = make_network(A2S1_ADAPTER, encoder)
        model.load_state_dict(saved["modelState"], strict=True)
        model.eval()
        with gzip.open(c1_pool, "rt", encoding="utf-8") as stream:
            entries = json.load(stream)["entries"]
        base = next(e for e in entries if e["template"] == "G2" and
                    e["variant"] == "positive" and e["layer"] == "payoff")
        variants = {"B_installed_target_payable": copy.deepcopy(base["snapshot"])}
        no_status = copy.deepcopy(base["snapshot"])
        deck = no_status["state"]["decks"]["germany"]
        moved = next(c for c in deck["active"] if c["definitionId"] == "special_137")
        deck["active"].remove(moved)
        deck["discardPile"].append(moved)
        variants["A_not_installed"] = no_status
        no_target = copy.deepcopy(base["snapshot"])
        no_target["state"]["units"] = [u for u in no_target["state"]["units"] if
            not (u["country"] == "soviet_union" and u["regionId"] == "ukraine")]
        variants["C_installed_no_target"] = no_target
        no_fee = copy.deepcopy(base["snapshot"])
        deck = no_fee["state"]["decks"]["germany"]
        saved_card = next(c for c in deck["hand"] if c["definitionId"] == "build_army")
        deck["hand"] = [saved_card]
        deck["discardPile"].extend(c for c in base["snapshot"]["state"]["decks"]
            ["germany"]["hand"] if c["id"] != saved_card["id"])
        no_fee["state"]["trainingCourse"]["openIds"]["germany"] = [saved_card["id"]]
        variants["D_installed_fee_scarce"] = no_fee
        probes = [_probe(client, encoder, model, key, snapshot,
                         "build_army", "eastern_europe")
                  for key, snapshot in variants.items()]
        baseline = probes[0]
        rows = []
        for item in probes:
            selected = item["selected"]
            rows.append({"scene": item["name"], "candidateCount": item["candidateCount"],
                "buildEast": {k: v for k, v in selected.items() if k != "candidateVector"}
                if selected else None,
                "changedStateCoordinatesVsInstalled": int((item["state"] !=
                    baseline["state"]).sum()),
                "sameCandidateEncodingVsInstalled": selected is not None and
                    baseline["selected"] is not None and selected["candidateVector"] ==
                    baseline["selected"]["candidateVector"],
                "value": item["value"]})
        blitz = next(e for e in entries if e["template"] == "G1" and
                      e["variant"] == "positive" and e["layer"] == "payoff")
        def remove_ukraine(snapshot):
            snapshot["state"]["units"] = [unit for unit in snapshot["state"]["units"]
                if not (unit["country"] == "soviet_union" and unit["regionId"] == "ukraine")]
        def retain_one_attack(snapshot):
            deck = snapshot["state"]["decks"]["germany"]
            keep = next(c for c in deck["hand"] if c["definitionId"] == "land_battle")
            deck["discardPile"].extend(c for c in deck["hand"] if c["id"] != keep["id"])
            deck["hand"] = [keep]
            snapshot["state"]["trainingCourse"]["openIds"]["germany"] = [keep["id"]]
        blitz_rows = _four_way(client, encoder, model, blitz["snapshot"], "special_136",
            "land_battle", "ukraine", remove_ukraine, retain_one_attack)

        shipyard = second.generate_one(client, encoder, model, torch.device("cpu"),
            second.BY_KEY["U4"], 2026100500, "positive")
        if "failure" in shipyard:
            raise ValueError("Fixed real-engine shipyard diagnostic start no longer reachable")
        def occupy_north_sea(snapshot):
            unit = next(u for u in snapshot["state"]["units"] if
                        u["country"] == "united_states")
            duplicate = copy.deepcopy(unit)
            duplicate["id"] = "diagnostic-only-us-north-sea"
            duplicate["type"] = "navy"
            duplicate["regionId"] = "sea_north_sea"
            snapshot["state"]["units"].append(duplicate)
        def retain_one_navy(snapshot):
            deck = snapshot["state"]["decks"]["united_states"]
            keep = next(c for c in deck["hand"] if c["definitionId"] == "build_navy")
            deck["discardPile"].extend(c for c in deck["hand"] if c["id"] != keep["id"])
            deck["hand"] = [keep]
            snapshot["state"]["trainingCourse"]["openIds"]["united_states"] = [keep["id"]]
        shipyard_rows = _four_way(client, encoder, model, shipyard["snapshot"], "special_84",
            "build_navy", "sea_north_atlantic", occupy_north_sea, retain_one_navy)
        return {"sourceCheckpoint": str(parent_path),
                "sourceUpdate": saved["update"],
                "buildFingerprint": client.fingerprint,
                "encoderVersion": ppo.encoder_version("signals"),
                "sourceStartSeed": base["seed"], "comparisons": rows,
                "mechanisms": {"build_then_attack": rows,
                    "attack_then_build": blitz_rows,
                    "build_then_build": shipyard_rows},
                "interpretation": "The installed-status fact is visible to the state branch; a common source candidate has identical local encoding. Probability differences are diagnostic, not correctness targets."}
    finally:
        client.close()


def main():
    parent = ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" / "latest.pt"
    pool = ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" / "course-pool-v1.json.gz"
    print(json.dumps(compare(parent, pool), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
