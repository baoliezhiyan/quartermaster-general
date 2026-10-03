"""Bounded, audited white-plan adaptation from the completed A1S2 map model.

The historical checkpoint still identifies itself as S2MAP. A1S2 is its
display/storage name; this script never rewrites the old checkpoint or replay.
"""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import json
import random
import time
from collections import Counter
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts.ppo_action_semantics import action_facts
from scripts.ppo_network_factory import ADAPTED_MAP, MAP, make_network
from scripts.ppo_opening_adapter import PpoOpeningAdapter
from scripts.ppo_stage2 import sha256 as file_sha256

ROOT = ppo.ROOT / "PPO训练"
DISPLAY_ID = "A1S2"
HISTORICAL_ID = "S2MAP"
SOURCE_ROUND = 2
DEMO = ROOT / "第二阶段示范"
OUTPUT = ROOT / DISPLAY_ID / "白色方案示范适应"
CONFIG = {"learningRate": 0.2, "maxSteps": 300, "maxSeconds": 70,
          "targetProbability": 0.70, "maxOpeningProbability": 0.78,
          "maxControlKl": 0.15, "maxInvalidEastWhite": 0.10,
          "controlWeight": 3.0, "ardenWeight": 0.5,
          "prototypeSeparation": 25.0, "checkEvery": 1,
          "trainingSeed": 20261004}


def source_paths(root=ROOT):
    return (root / DISPLAY_ID / f"第{SOURCE_ROUND:03d}轮" / "模型.pt",
            root / ".state" / DISPLAY_ID / "latest.pt",
            root / ".state" / DISPLAY_ID / "training-report.json")


def load_parent(client, root=ROOT):
    weights_path, checkpoint_path, report_path = source_paths(root)
    weights = torch.load(weights_path, map_location="cpu", weights_only=False)
    saved = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    encoder = ppo.Encoder(client.schema)
    expected_network = {"stateDim": encoder.state_dim, "candidateDim": encoder.candidate_dim}
    if not (weights.get("experimentId") == saved.get("experimentId") ==
            report.get("experimentId") == HISTORICAL_ID and
            weights.get("round") == SOURCE_ROUND and
            weights.get("policyVersion") == saved.get("update") == SOURCE_ROUND * 10 and
            len(report.get("updates", ())) == SOURCE_ROUND * 10 and
            saved.get("completedEpisodes") == SOURCE_ROUND * 400 and
            weights.get("networkArchitecture") == saved.get("networkArchitecture") == MAP and
            saved.get("network") == expected_network and
            weights.get("encoderVersion") == saved.get("encoderVersion") == ppo.ENCODER_VERSION and
            weights.get("buildFingerprint") == saved.get("buildFingerprint") ==
            report.get("buildFingerprint") == client.fingerprint and
            weights.get("experimentConfigSha256") == saved.get("experimentConfigSha256") ==
            report.get("experimentConfigSha256") and
            saved.get("mode") == weights.get("mode") == "A" and
            saved.get("optimizerConfig", {}).get("entropy") == 0.01 and
            saved.get("rewardConfig") == ppo.REWARD_CONFIG and
            all(torch.equal(value, saved["modelState"][key]) for key, value in
                weights["modelState"].items())):
        raise ValueError("A1S2/S2MAP 第002轮原件、检查点、报告或当前训练构建不一致")
    model = make_network(MAP, encoder)
    model.load_state_dict(saved["modelState"])
    return encoder, model, {"displayId": DISPLAY_ID, "historicalExperimentId": HISTORICAL_ID,
        "round": SOURCE_ROUND, "update": saved["update"],
        "weightsFileSha256": file_sha256(weights_path),
        "checkpointSha256": file_sha256(checkpoint_path),
        "reportSha256": file_sha256(report_path),
        "modelWeightsSha256": ppo.model_weights_sha256(model),
        "trainerSourceSha256": saved["trainerSourceSha256"],
        "experimentConfigSha256": saved["experimentConfigSha256"],
        "buildFingerprint": client.fingerprint, "encoderVersion": ppo.ENCODER_VERSION,
        "networkArchitecture": MAP, "resourceMode": "A", "entropyCoefficient": 0.01}


def _key(item):
    digest = hashlib.sha256()
    digest.update(item["label"].encode())
    digest.update(item["state"].numpy().tobytes())
    digest.update(item["candidates"].numpy().tobytes())
    digest.update(int(item["chosen"]).to_bytes(4, "little"))
    return digest.hexdigest()


def load_labels(encoder, root=ROOT):
    folder = root / "第二阶段示范"
    path = folder / "expert-labels.pt"
    bundle = torch.load(path, map_location="cpu", weights_only=False)
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    if (bundle.get("format") != "quartermaster-ppo-stage2-expert-labels-v1" or
        bundle.get("encoderVersion") != ppo.ENCODER_VERSION or
        bundle.get("seeds") != manifest.get("seeds") or len(bundle["seeds"]) != 32 or
        len(manifest.get("episodes", ())) != 32):
        raise ValueError("示范来源或编码版本不匹配")
    by_decision = {(item["seed"], item["decisionId"]): item for item in bundle["labels"]}
    verified, controls, seen = 0, {}, set()
    for seed in bundle["seeds"]:
        with gzip.open(folder / f"seed-{seed}.jsonl.gz", "rt", encoding="utf-8") as stream:
            for line in stream:
                row = json.loads(line)
                if row.get("type") != "decision":
                    continue
                obs = row["observation"]
                if row["selectedBy"] == "script":
                    identity = (seed, row["decision"]["decisionId"])
                    item = by_decision.get(identity)
                    if item is None or identity in seen or row.get("scriptLabel") != item["label"]:
                        raise ValueError("脚本标签和完整记录不一致")
                    state, candidates = encoder.encode(obs)
                    if not (torch.equal(state, item["state"]) and
                            torch.equal(candidates, item["candidates"]) and
                            row["legalCandidates"] == item["candidateIds"] and
                            row["selectedIndex"] == item["chosen"] and
                            item["label"] in ("white_plan", "arden_after_white")):
                        raise ValueError("旧示范不能无损转换为当前地图网络输入")
                    seen.add(identity)
                    verified += 1
                elif obs.get("node") == "SOURCE":
                    seat = obs.get("activeSeat")
                    category = ("later_germany" if seat == "germany" and obs.get("round", 0) > 1
                                else seat if seat != "germany" else None)
                    if category and category not in controls:
                        state, candidates = encoder.encode(obs)
                        controls[category] = {"label": category, "state": state,
                                              "candidates": candidates,
                                              "candidateIds": row["legalCandidates"],
                                              "observation": obs}
    if verified != len(by_decision) or set(controls) != {
            "later_germany", "united_kingdom", "japan", "soviet_union", "italy", "united_states"}:
        raise ValueError("脚本标签或六国对照局面不完整")
    distinct = {}
    multiplicity = Counter()
    for item in bundle["labels"]:
        signature = _key(item)
        distinct.setdefault(signature, item)
        multiplicity[signature] += 1
    return list(distinct.values()), list(controls.values()), {
        "fileSha256": file_sha256(path), "recordedLabels": verified,
        "labelCounts": dict(Counter(item["label"] for item in bundle["labels"])),
        "distinctByLabel": dict(Counter(item["label"] for item in distinct.values())),
        "distinctEncodings": len(distinct), "seeds": bundle["seeds"],
        "ardenRandomlyDiscardedEpisodes": sum(bool(x["ardenDiscarded"]) for x in manifest["episodes"]),
        "unscriptedActionsUsedAsLabels": False}


def east_probes(client, encoder):
    client.request(op="reset", seed=20700000, mode="A", cardSet="events")
    original = client.request(op="snapshot")["snapshot"]
    probes = []
    for occupant, name in ((None, "east_vacant"), ("germany", "east_repeated"),
                           ("soviet_union", "east_blocked"), ("italy", "east_friendly")):
        snapshot = copy.deepcopy(original)
        snapshot["state"]["units"] = [unit for unit in snapshot["state"]["units"]
                                      if unit["regionId"] != "eastern_europe"]
        if occupant:
            snapshot["state"]["units"].append({"id": f"a1s2:{name}", "country": occupant,
                                                 "type": "army", "regionId": "eastern_europe"})
        obs = client.request(op="restore", snapshot=snapshot)["observation"]
        state, candidates = encoder.encode(obs)
        white = next((index for index, candidate in enumerate(obs["candidates"])
                      if candidate.get("definitionId") == "special_150"), None)
        outcome = (action_facts(obs, obs["candidates"][white], client.schema["regions"])[0]["outcome"]
                   if white is not None else None)
        probes.append({"label": name, "state": state, "candidates": candidates,
                       "candidateIds": [candidate["id"] for candidate in obs["candidates"]],
                       "observation": obs, "whiteIndex": white, "recruitOutcome": outcome})
    return probes


def distribution(model, item, device):
    logits, value = model(*ppo.batch_tensors([item], device))
    return logits[0, :item["candidates"].shape[0]].softmax(-1), value[0]


def summary(model, items, device):
    model.eval()
    output = {}
    with torch.inference_mode():
        for item in items:
            probs, value = distribution(model, item, device)
            ids = item["candidateIds"]
            obs = item.get("observation")
            cards = obs["candidates"] if obs else None
            ranking = sorted(range(len(ids)), key=lambda index: float(probs[index]), reverse=True)
            white = item.get("whiteIndex")
            if white is None and cards:
                white = next((i for i, c in enumerate(cards) if c.get("definitionId") == "special_150"), None)
            output[item["label"]] = {"candidateCount": len(ids), "value": float(value),
                "whiteProbability": float(probs[white]) if white is not None else None,
                "whiteRank": ranking.index(white) + 1 if white is not None else None,
                "recruitOutcome": item.get("recruitOutcome"),
                "top": [{"id": ids[i], "definitionId": cards[i].get("definitionId") if cards else None,
                         "probability": float(probs[i])} for i in ranking[:5]]}
    return output


def save_auxiliary(output, model, encoder, opening, ardens, anchors, adapted_hash,
                   fingerprint):
    target = output / "辅助示范.pt"
    if target.exists():
        raise FileExistsError(f"辅助示范已存在，拒绝覆盖：{target}")
    with torch.inference_mode():
        content = {"format": "quartermaster-a1s2-auxiliary-v1",
            "adaptedWeightsSha256": adapted_hash, "buildFingerprint": fingerprint,
            "encoderVersion": ppo.ENCODER_VERSION,
            "opening": {key: opening[key] for key in
                        ("state", "candidates", "chosen", "candidateIds")},
            "arden": [{key: item[key] for key in
                       ("state", "candidates", "chosen", "candidateIds")}
                      for item in ardens],
            "controls": [{"label": item["label"], "state": item["state"],
                          "candidates": item["candidates"],
                          "teacher": distribution(model, item, torch.device("cpu"))[0].cpu()}
                         for item in anchors]}
    torch.save(content, target)
    return target


def prepare_existing_auxiliary(root=ROOT, output=OUTPUT):
    client = ppo.ArenaClient()
    try:
        encoder, _parent_model, parent = load_parent(client, root)
        payload = torch.load(output / "模型.pt", map_location="cpu", weights_only=False)
        if payload.get("parent") != parent or payload.get("networkArchitecture") != ADAPTED_MAP:
            raise ValueError("派生模型与当前父模型不一致")
        model = make_network(ADAPTED_MAP, encoder)
        model.load_state_dict(payload["modelState"])
        if ppo.model_weights_sha256(model) != payload["weightsSha256"]:
            raise ValueError("派生模型权重哈希不一致")
        labels, controls, data = load_labels(encoder, root)
        if payload.get("dataSha256") != data["fileSha256"]:
            raise ValueError("派生模型示范数据不一致")
        opening = next(item for item in labels if item["label"] == "white_plan")
        ardens = [item for item in labels if item["label"] == "arden_after_white"]
        anchors = east_probes(client, encoder)[1:] + controls
        return save_auxiliary(output, model, encoder, opening, ardens, anchors,
                              payload["weightsSha256"], client.fingerprint)
    finally:
        client.close()


def run_adaptation(root=ROOT, output=None, config=None):
    config = {**CONFIG, **(config or {})}
    output = Path(output) if output is not None else root / DISPLAY_ID / "白色方案示范适应"
    if output.exists():
        raise FileExistsError(f"独立派生目录已存在，拒绝覆盖：{output}")
    torch.manual_seed(config["trainingSeed"])
    client = ppo.ArenaClient()
    try:
        encoder, parent_model, parent = load_parent(client, root)
        labels, controls, data = load_labels(encoder, root)
        probes = east_probes(client, encoder)
        opening = next(item for item in labels if item["label"] == "white_plan")
        ardens = [item for item in labels if item["label"] == "arden_after_white"]
        anchors = probes[1:] + controls
        target = opening["candidates"][opening["chosen"]]
        state_gap = min(float((item["state"] - opening["state"]).square().sum())
                        for item in anchors)
        candidate_gap = min(float((candidate - target).square().sum())
                            for index, candidate in enumerate(opening["candidates"])
                            if index != opening["chosen"])
        if state_gap <= 0 or candidate_gap <= 0:
            raise ValueError("标准开局与非目标局面或候选无法在当前编码中区分")
        state_scale = state_gap / config["prototypeSeparation"]
        candidate_scale = candidate_gap / config["prototypeSeparation"]
        model = PpoOpeningAdapter(encoder)
        model.map.load_state_dict(parent_model.state_dict())
        model.set_prototype(opening["state"], target, state_scale, candidate_scale)
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        model.to(device).eval()
        before = summary(model, probes + controls, device)
        with torch.no_grad():
            teacher = {item["label"]: distribution(model, item, device)[0].detach()
                       for item in anchors}
            arden_before = [float(distribution(model, item, device)[0][item["chosen"]])
                            for item in ardens]
        for name, parameter in model.named_parameters():
            parameter.requires_grad_(name == "opening_logit")
        optimizer = torch.optim.Adam([model.opening_logit], lr=config["learningRate"])
        started = time.perf_counter()
        history, accepted, stop = [], None, "max_steps"
        for step in range(1, config["maxSteps"] + 1):
            if time.perf_counter() - started >= config["maxSeconds"]:
                stop = "time_budget"
                break
            optimizer.zero_grad(set_to_none=True)
            white_probs, _ = distribution(model, opening, device)
            white_loss = -white_probs[opening["chosen"]].clamp_min(1e-30).log()
            arden = ardens[(step - 1) % len(ardens)]
            arden_probs, _ = distribution(model, arden, device)
            arden_loss = -arden_probs[arden["chosen"]].clamp_min(1e-30).log()
            selected = anchors
            kl_terms = []
            for anchor in selected:
                student, _ = distribution(model, anchor, device)
                reference = teacher[anchor["label"]]
                kl_terms.append((reference * (reference.clamp_min(1e-30).log() -
                                               student.clamp_min(1e-30).log())).sum())
            keep_loss = torch.stack(kl_terms).mean()
            loss = white_loss + config["ardenWeight"] * arden_loss + config["controlWeight"] * keep_loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_([model.opening_logit], 5.0)
            optimizer.step()
            if step == 1 or step % config["checkEvery"] == 0:
                with torch.inference_mode():
                    opening_probability = float(distribution(model, opening, device)[0][opening["chosen"]])
                    control_kls = {}
                    for anchor in anchors:
                        student, _ = distribution(model, anchor, device)
                        reference = teacher[anchor["label"]]
                        control_kls[anchor["label"]] = float((reference *
                            (reference.clamp_min(1e-30).log() - student.clamp_min(1e-30).log())).sum())
                    invalid_white = {item["label"]: float(distribution(model, item, device)[0][item["whiteIndex"]])
                                     for item in probes[1:]}
                    arden_probs = [float(distribution(model, item, device)[0][item["chosen"]])
                                   for item in ardens]
                row = {"step": step, "seconds": time.perf_counter() - started,
                       "openingProbability": opening_probability,
                       "ardenMinimum": min(arden_probs), "ardenMean": sum(arden_probs) / len(arden_probs),
                       "maxControlKl": max(control_kls.values()),
                       "maxInvalidEastWhite": max(invalid_white.values()),
                       "controlKls": control_kls,
                       "invalidEastWhite": invalid_white,
                       "openingLogit": float(model.opening_logit.detach()),
                       "whiteLoss": float(white_loss.detach()),
                       "ardenLoss": float(arden_loss.detach()), "keepLoss": float(keep_loss.detach())}
                history.append(row)
                acceptable = (opening_probability >= config["targetProbability"] and
                              opening_probability <= config["maxOpeningProbability"] and
                              max(control_kls.values()) <= config["maxControlKl"] and
                              max(invalid_white.values()) <= config["maxInvalidEastWhite"] and
                              min(arden_probs) >= 0.5)
                if acceptable:
                    accepted = {"step": step, "controlKls": control_kls,
                                "invalidEastWhite": invalid_white, "ardenProbabilities": arden_probs}
                    stop = "acceptance_target"
                    break
                if opening_probability > config["maxOpeningProbability"]:
                    stop = "overshot_opening_probability"
                    break
        after = summary(model, probes + controls, device)
        arden_after = []
        with torch.inference_mode():
            for item in ardens:
                probs, _ = distribution(model, item, device)
                arden_after.append(float(probs[item["chosen"]]))
        elapsed = time.perf_counter() - started
        model.cpu()
        report = {"format": "quartermaster-a1s2-white-plan-adaptation-report-v1",
                  "passed": accepted is not None, "stopReason": stop,
                  "steps": step if 'step' in locals() else 0, "seconds": elapsed,
                  "config": config, "parent": parent, "data": data,
                  "adaptationMethod": "verified-context-prototype-residual-behavior-cloning-v1",
                  "prototype": {"stateGapToNearestControl": state_gap,
                                "candidateGapToNearestOtherAction": candidate_gap,
                                "stateScale": state_scale,
                                "candidateScale": candidate_scale},
                  "openingAndControlsBefore": before, "openingAndControlsAfter": after,
                  "ardenProbabilitiesBefore": arden_before, "ardenProbabilitiesAfter": arden_after,
                  "history": history, "acceptance": accepted,
                  "trainableParameters": [name for name, parameter in model.named_parameters()
                                          if parameter.requires_grad],
                  "valueTargetsUsed": False, "ppoSamplesUsed": False}
        output.mkdir(parents=True)
        (output / "报告.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        if accepted is not None:
            payload = {"format": "quartermaster-a1s2-white-plan-adapted-v1",
                       "parent": parent, "dataSha256": data["fileSha256"], "config": config,
                       "steps": accepted["step"], "networkArchitecture": ADAPTED_MAP,
                       "encoderVersion": ppo.ENCODER_VERSION,
                       "buildFingerprint": client.fingerprint,
                       "network": {"stateDim": encoder.state_dim, "candidateDim": encoder.candidate_dim},
                       "weightsSha256": ppo.model_weights_sha256(model),
                       "modelState": model.state_dict()}
            torch.save(payload, output / "模型.pt")
            save_auxiliary(output, model, encoder, opening, ardens, anchors,
                           payload["weightsSha256"], client.fingerprint)
        return report
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser(description="A1S2: bounded white-plan adaptation, no PPO")
    parser.add_argument("--verify", action="store_true", help="read-only latest-model and label check")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-steps", type=int, default=CONFIG["maxSteps"])
    parser.add_argument("--max-seconds", type=float, default=CONFIG["maxSeconds"])
    parser.add_argument("--learning-rate", type=float, default=CONFIG["learningRate"])
    args = parser.parse_args()
    if args.max_steps < 1 or args.max_seconds <= 0 or args.learning_rate <= 0:
        parser.error("Adaptation budgets and learning rate must be positive")
    client = ppo.ArenaClient()
    try:
        encoder, _model, parent = load_parent(client)
        _labels, _controls, data = load_labels(encoder)
    finally:
        client.close()
    print(json.dumps({"parent": parent, "data": data, "output": str(OUTPUT)}, ensure_ascii=False))
    if args.verify or args.dry_run:
        return
    report = run_adaptation(config={"maxSteps": args.max_steps,
                                    "maxSeconds": args.max_seconds,
                                    "learningRate": args.learning_rate})
    print(json.dumps({"passed": report["passed"], "stopReason": report["stopReason"],
                      "steps": report["steps"], "seconds": report["seconds"],
                      "output": str(OUTPUT)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
