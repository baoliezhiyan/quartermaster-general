"""Reachable A2S1 combo starts; preparation uses only arena legal decisions.

The preparation trace is deliberately outside PPO. Every saved start can be
replayed from reset with its seed and exact action IDs before use for training.
"""
from __future__ import annotations

import gzip
import argparse
import hashlib
import json
import random
import time
from dataclasses import dataclass
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network

VERSION = "a2s1-reachable-combos-v1"
MIX = {"normal": 28, "course": 12, "payoffFraction": 2 / 3,
       "rotation": "per-template-alternating-variant-v1"}


@dataclass(frozen=True)
class Prep:
    seat: str
    card: str
    region: str | None = None


@dataclass(frozen=True)
class Template:
    key: str
    owner: str
    cards: tuple[str, ...]
    regions: tuple[str, ...]
    steps: tuple[Prep, ...]
    last_setup: str | None
    max_decisions: int = 750
    attempts: int = 12


TEMPLATES = (
    Template("G1", "germany", ("special_136",), ("eastern_europe", "ukraine"),
             (Prep("germany", "special_136"), Prep("germany", "build_army", "eastern_europe"),
              Prep("soviet_union", "build_army", "ukraine")), "special_136"),
    Template("G2", "germany", ("special_136", "special_137"),
             ("eastern_europe", "ukraine", "moscow"),
             (Prep("germany", "special_136"), Prep("germany", "special_137"),
              Prep("germany", "build_army", "eastern_europe"),
              Prep("soviet_union", "build_army", "ukraine")), "special_137"),
    Template("G3", "germany", ("special_134", "special_136"), ("western_europe",),
             (Prep("germany", "land_battle", "western_europe"),
              Prep("united_kingdom", "build_navy", "sea_north_sea"),
              Prep("united_kingdom", "build_army", "western_europe"),
              Prep("united_states", "build_navy", "sea_north_atlantic"),
              Prep("united_states", "build_navy", "sea_north_sea"),
              Prep("united_states", "build_army", "western_europe"),
              Prep("germany", "special_134"), Prep("germany", "special_136")), "special_136",
             1100, 20),
    Template("U1", "united_states", ("special_111",),
             ("western_europe", "germany", "italy"),
             (Prep("germany", "land_battle", "western_europe"),
              Prep("united_states", "build_navy", "sea_north_atlantic"),
              Prep("united_states", "build_navy", "sea_north_sea")),
             "build_navy", 800, 16),
    Template("U2", "united_states", ("special_78", "special_88"),
             ("sea_east_pacific", "hawaii"),
             (Prep("japan", "build_navy", "sea_east_china"),
              Prep("japan", "build_navy", "sea_north_pacific"),
              Prep("japan", "build_army", "hawaii"),
              Prep("united_states", "special_78"),
              Prep("united_states", "special_88")), "special_88", 1100, 20),
    Template("U3", "united_states", ("special_88",),
             ("western_europe", "sea_north_sea"),
             (Prep("germany", "land_battle", "western_europe"),
              Prep("germany", "build_army", "western_europe"),
              Prep("united_states", "build_navy", "sea_north_atlantic"),
              Prep("united_states", "build_navy", "sea_north_sea"),
              Prep("united_states", "special_88")), "special_88", 1000, 20),
    Template("J1", "japan", ("special_199",), ("eastern_china", "sea_east_china"),
             (Prep("japan", "build_navy", "sea_east_china"),
              Prep("japan", "special_199")), "special_199"),
    Template("J2", "japan", ("special_190", "special_189"), ("eastern_china",),
             (Prep("japan", "special_190"), Prep("japan", "special_189")), "special_189"),
)

CONTROL_STEPS = {
    "U1": (Prep("germany", "build_army", "western_europe"),),
    "J2": (Prep("japan", "build_navy", "sea_east_china"),
           Prep("japan", "land_battle", "eastern_china")),
}


def _has(state, country, kind, region):
    return any(unit["country"] == country and unit["type"] == kind and
               unit["regionId"] == region for unit in state["units"])


def _installed(state, seat, definition):
    return any(card["definitionId"] == definition for card in
               state["decks"][seat]["active" if definition not in
               ("special_199", "special_190", "special_189") else "faceDown"])


def _source(obs, definition, region=None):
    return next((item for item in obs["candidates"] if item["kind"] == "source" and
                 item.get("definitionId") == definition and
                 (region is None or any(choice.get("regionId") == region
                                        for choice in item.get("choices") or []))), None)


def ready(template: Template, observation, state, variant="positive"):
    if observation["activeSeat"] != template.owner:
        return False
    if template.key == "J2":
        return (observation.get("choiceKind") == "TRIGGER" and
                all(_installed(state, "japan", name) for name in template.cards) and
                (_has(state, "china", "army", "eastern_china") ==
                 (variant == "positive")))
    if observation["node"] != "SOURCE" or observation["phase"] != "PLAY":
        return False
    if template.key != "U1" and not (template.key in ("J1", "U3") and variant != "positive") and not all(
            _installed(state, template.owner, name) for name in template.cards):
        return False
    if template.key in ("G1", "G2"):
        return ((_has(state, "germany", "army", "eastern_europe") ==
                 (template.key != "G2" or variant == "positive")) and
                (template.key == "G2" and variant != "positive" or
                 _has(state, "soviet_union", "army", "ukraine") ==
                 (variant == "positive")) and
                (variant != "positive" or _source(observation, "land_battle", "ukraine")))
    if template.key == "G3":
        needed = ("united_kingdom",) if variant != "positive" else (
            "united_kingdom", "united_states")
        return all(_has(state, seat, "army", "western_europe") for seat in needed) and (
            variant == "positive" or not _has(state, "united_states", "army", "western_europe")) and bool(
            _source(observation, "land_battle", "western_europe"))
    if template.key == "U1":
        return (bool(_source(observation, "special_111")) and
                _has(state, "united_states", "navy", "sea_north_sea") and
                ((variant == "positive" and not any(u["type"] == "army" and
                 u["regionId"] == "western_europe" for u in state["units"])) or
                 (variant != "positive" and _has(state, "germany", "army", "western_europe"))))
    if template.key == "U2":
        return (bool(_source(observation, "build_navy", "sea_east_pacific")) and
                (_has(state, "japan", "army", "hawaii") == (variant == "positive")))
    if template.key == "U3":
        return (_has(state, "germany", "army", "western_europe") and
                _has(state, "united_states", "navy", "sea_north_sea") and
                (_installed(state, "united_states", "special_88") == (variant == "positive")) and
                bool(_source(observation, "land_battle", "western_europe")))
    if template.key == "J1":
        return (_has(state, "japan", "navy", "sea_east_china") and
                _has(state, "china", "army", "eastern_china") and
                (_installed(state, "japan", "special_199") == (variant == "positive")) and
                bool(_source(observation, "land_battle", "eastern_china")))
    raise KeyError(template.key)


def _planned(template, completed, obs, state, variant):
    if (template.key == "J2" and obs["activeSeat"] == "japan" and
            obs.get("choiceKind") == "TRIGGER" and not all(
                _installed(state, "japan", name) for name in template.cards)):
        decline = next((candidate for candidate in obs["candidates"] if
                        candidate.get("choiceIds") == []), None)
        if decline:
            return -1, decline
    steps = (*CONTROL_STEPS.get(template.key, ()), *template.steps) if variant != "positive" else template.steps
    for number, step in enumerate(steps):
        if step.seat != obs["activeSeat"]:
            continue
        if number in completed:
            if step.card in ("build_army", "build_navy") and step.region and not _has(
                    state, step.seat, "army" if step.card == "build_army" else "navy", step.region):
                completed.remove(number)
            else:
                continue
        if variant != "positive" and template.key in ("G1", "G2") and step.seat == "soviet_union":
            continue
        if variant != "positive" and template.key == "G2" and step.card == "build_army":
            continue
        if variant != "positive" and template.key == "G3" and step.seat == "united_states" and step.card == "build_army":
            continue
        if template.key == "G3" and step.card == "build_army" and step.region == "western_europe" and not all(
                _installed(state, "germany", name) for name in template.cards):
            continue
        if variant != "positive" and template.key == "U2" and step.seat == "japan" and step.card == "build_army":
            continue
        if variant != "positive" and template.key == "J1" and step.card == "special_199":
            continue
        if variant != "positive" and template.key == "U3" and step.card == "special_88":
            continue
        candidate = _source(obs, step.card, step.region)
        if candidate:
            return number, candidate
    return None, None


def generate_one(client, encoder, model, device, template: Template, seed: int,
                 variant="positive"):
    """Return one reachable start, or a bounded failure report."""
    beginning = time.perf_counter()
    observation = client.request(op="reset", seed=seed, mode="A", cardSet="signals")["observation"]
    rng = random.Random((seed << 32) ^ 0xC0B0)
    trace, completed = [], set()
    preparation = None
    for _ in range(template.max_decisions):
        if observation is None:
            break
        if observation["node"] == "SOURCE" or template.key == "J2" and observation.get("choiceKind") == "TRIGGER":
            snapshot = client.request(op="snapshot")["snapshot"]
            if ready(template, observation, snapshot["state"], variant):
                return {"template": template.key, "variant": variant,
                        "layer": "payoff", "seed": seed, "snapshot": snapshot,
                        "trace": trace, "preparation": preparation,
                        "generatedSeconds": time.perf_counter() - beginning}
        else:
            snapshot = None
        planned, candidate = (None, None)
        if observation["node"] == "SOURCE" or template.key == "J2" and observation.get("choiceKind") == "TRIGGER":
            planned, candidate = _planned(template, completed, observation,
                                          snapshot["state"], variant)
            final_setup = ("build_navy" if variant != "positive" and template.key in ("J1", "U3")
                           else template.last_setup)
            if (candidate and candidate.get("definitionId") == final_setup and
                    preparation is None):
                preparation = {"snapshot": snapshot, "traceLength": len(trace)}
        if candidate is None:
            state, candidates = encoder.encode(observation)
            index, _, _ = ppo.select_action(model, state, candidates, device, rng=rng)
            candidate = observation["candidates"][index]
        choice = {**observation["decision"], "actionId": candidate["id"]}
        response = client.request(op="step", action=choice)
        trace.append({"decision": observation["decision"], "actionId": candidate["id"],
                      "activeSeat": observation["activeSeat"], "phase": observation["phase"],
                      "choiceKind": observation.get("choiceKind"),
                      "scripted": planned is not None})
        if planned is not None and planned >= 0:
            completed.add(planned)
        observation = response["observation"]
    return {"template": template.key, "variant": variant, "seed": seed,
            "failure": "natural_end" if observation is None else "preparation_budget",
            "decisions": len(trace),
            "trace": trace, "completedSteps": sorted(completed),
            "generatedSeconds": time.perf_counter() - beginning}


def replay(client, entry):
    observation = client.request(op="reset", seed=entry["seed"], mode="A", cardSet="signals")["observation"]
    for item in entry["trace"]:
        stable = lambda d: {key: value for key, value in d.items() if key != "episodeId"}
        if stable(observation["decision"]) != stable(item["decision"]) or item["actionId"] not in {
                candidate["id"] for candidate in observation["candidates"]}:
            raise ValueError("Preparation trace is not a legal replay")
        observation = client.request(op="step", action={**observation["decision"],
                                       "actionId": item["actionId"]})["observation"]
    snapshot = client.request(op="snapshot")["snapshot"]
    if snapshot["state"] != entry["snapshot"]["state"]:
        raise ValueError("Preparation replay differs from stored start")
    return observation


def pool_identity(client, parent_hash, model_hash):
    payload = {"version": VERSION, "buildFingerprint": client.fingerprint,
               "courseVersion": client.schema["courseVersion"],
               "observationVersion": client.schema["observationSchemaVersion"],
               "actionVersion": client.schema["actionSchemaVersion"],
               "encoderVersion": ppo.encoder_version("signals"),
               "rewardConfig": ppo.reward_config("signals"),
               "parentCheckpointSha256": parent_hash, "generatorWeightsSha256": model_hash,
               "resourceMode": "A", "preparationPolicy": "goal-legal-plus-frozen-model-v1"}
    payload["identitySha256"] = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    return payload


def write_pool(path: Path, identity: dict, entries: list[dict], failures: list[dict]):
    if path.exists():
        raise FileExistsError(path)
    payload = {"identity": identity, "entries": entries, "failures": failures}
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=6) as output:
        json.dump(payload, output, ensure_ascii=False, separators=(",", ":"))


def read_pool(path: Path, expected_identity: dict):
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        payload = json.load(stream)
    if payload["identity"] != expected_identity:
        raise ValueError("Course pool build, reward, encoding, or generator identity differs")
    return payload


def generation_summary(pool: dict):
    limits = {item.key: item.max_decisions for item in TEMPLATES}
    rows = {item.key: {"successfulStarts": 0, "successfulSeeds": set(),
                       "failedAttempts": 0, "failureReasons": {}} for item in TEMPLATES}
    for entry in pool["entries"]:
        row = rows[entry["template"]]
        row["successfulStarts"] += 1
        row["successfulSeeds"].add(entry["seed"])
    for failed in pool["failures"]:
        row = rows[failed["template"]]
        row["failedAttempts"] += int(failed.get("seed") is not None)
        reason = failed["failure"]
        if reason == "natural_end_or_preparation_budget":
            reason = "preparation_budget" if failed["decisions"] >= limits[failed["template"]] else "natural_end"
        row["failureReasons"][reason] = row["failureReasons"].get(reason, 0) + 1
    return {key: {**row, "successfulSeeds": len(row["successfulSeeds"]),
                  "attempts": len(row["successfulSeeds"]) + row["failedAttempts"]}
            for key, row in rows.items()}


def load_parent(path: Path, encoder, device):
    saved = torch.load(path, map_location="cpu", weights_only=False)
    if (saved.get("networkArchitecture") != A2S1_ADAPTER or
            saved.get("network") != {"stateDim": encoder.state_dim,
                                     "candidateDim": encoder.candidate_dim}):
        raise ValueError("Course parent network differs")
    model = make_network(A2S1_ADAPTER, encoder).to(device)
    model.load_state_dict(saved["modelState"], strict=True)
    model.eval()
    return model, ppo.model_weights_sha256(model)


def create_pool(client, encoder, model, device, parent_path: Path, output: Path,
                seed_base=2026100400, only=None, attempts_override=None):
    identity = pool_identity(client, hashlib.sha256(parent_path.read_bytes()).hexdigest(),
                             ppo.model_weights_sha256(model))
    entries, failures = [], []
    selected = [template for template in TEMPLATES if only is None or template.key in only]
    for template_index, template in enumerate(selected):
        for variant_index, variant in enumerate(("positive", "control")):
            result = None
            limit = attempts_override or template.attempts
            for attempt in range(limit):
                seed = seed_base + template_index * 1000 + variant_index * 100 + attempt
                attempted = generate_one(client, encoder, model, device, template, seed, variant)
                if "failure" in attempted:
                    failures.append({key: attempted[key] for key in (
                        "template", "variant", "seed", "failure", "decisions", "generatedSeconds")})
                    continue
                result = attempted
                break
            if result is None:
                failures.append({"template": template.key, "variant": variant,
                                 "failure": "attempt_budget_exhausted", "attempts": limit})
                continue
            payoff = {key: result[key] for key in ("template", "variant", "seed", "snapshot", "trace")}
            payoff["layer"] = "payoff"
            payoff["generationSeconds"] = result["generatedSeconds"]
            replay(client, payoff)
            entries.append(payoff)
            if result["preparation"] is not None:
                prep = {"template": template.key, "variant": variant,
                        "layer": "preparation", "seed": result["seed"],
                        "snapshot": result["preparation"]["snapshot"],
                        "trace": result["trace"][:result["preparation"]["traceLength"]],
                        "generationSeconds": result["generatedSeconds"]}
                replay(client, prep)
                entries.append(prep)
            print(json.dumps({"template": template.key, "variant": variant,
                              "seed": result["seed"], "steps": len(result["trace"]),
                              "layers": [entry["layer"] for entry in entries if
                                         entry["template"] == template.key and
                                         entry["variant"] == variant]}, ensure_ascii=False), flush=True)
    if len(entries) != len(selected) * 4:
        raise RuntimeError(json.dumps({"generated": len(entries), "expected": len(selected) * 4,
                                       "failures": failures}, ensure_ascii=False))
    write_pool(output, identity, entries, failures)
    return {"path": str(output), "identity": identity,
            "poolSize": len(entries), "bytes": output.stat().st_size,
            "failedAttempts": len(failures), "entries": [{
                "template": entry["template"], "variant": entry["variant"],
                "layer": entry["layer"], "seed": entry["seed"],
                "startRound": entry["snapshot"]["state"]["round"],
                "preparationDecisions": len(entry["trace"])} for entry in entries]}


def main():
    parser = argparse.ArgumentParser(description="Generate replayable A2S1 legal-action combo starts")
    parser.add_argument("--parent", type=Path,
                        default=ppo.ROOT / "PPO训练" / ".state" / "A2S1" / "latest.pt")
    parser.add_argument("--output", type=Path,
                        default=ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" / "course-pool-v1.json.gz")
    parser.add_argument("--seed-base", type=int, default=2026100400)
    parser.add_argument("--attempts", type=int)
    parser.add_argument("--only", nargs="*", choices=[item.key for item in TEMPLATES])
    args = parser.parse_args()
    torch.set_num_threads(2)
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        model, _ = load_parent(args.parent, encoder, device)
        print(json.dumps(create_pool(client, encoder, model, device, args.parent, args.output,
            args.seed_base, set(args.only) if args.only else None, args.attempts),
            ensure_ascii=False, indent=2))
    finally:
        client.close()


if __name__ == "__main__":
    main()
