"""Stage-two preparation: frozen-policy demonstrations, conservative BC and paired starts.

Nothing in this module starts PPO training without an explicit train command.
"""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import json
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

import torch
from torch.distributions import Categorical

from scripts import ppo_rounds as rounds
from scripts import ppo_train as ppo
from scripts.ppo_action_semantics import action_facts
from scripts.ppo_network_factory import FLAT, MAP, STAGE2_EXPERIMENTS, make_network, map_from_flat, migrate_flat_state

SOURCE_ROUND = 3
ENTROPY = 0.01
WORKERS = 8
TRAIN_SEED = 20266930
DEMO_SEEDS = tuple(range(20600000, 20600032))
EVAL_SEEDS = tuple(range(20700000, 20700020))
DEMO_VERSION = "white-plan-scripted-labels-v1"
BC_CONFIG = {"learningRate": 1e-5, "steps": 4, "lossWeight": 0.1,
             "maxMeanKl": 0.03, "maxOpeningWhiteProbability": 0.65}
ROOT = rounds.DEFAULT_RESULTS
STATE = ROOT / ".state" / "stage2"
PLAN = STATE / "stage2-comparison-plan.json"
DEMONSTRATIONS = ROOT / "第二阶段示范"
COMMON = STATE / "common-flat.pt"


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def source_files(root=ROOT):
    return (root / "A1S1" / "第003轮" / rounds.WEIGHTS_NAME,
            root / ".state" / "A1S1" / "latest.pt",
            root / ".state" / "A1S1" / "training-report.json",
            root / "A1S1" / "第003轮" / rounds.RECORD_NAME)


def verify_source(root=ROOT):
    weights_path, checkpoint_path, report_path, replay_path = source_files(root)
    for path in (weights_path, checkpoint_path, report_path, replay_path):
        if not path.is_file():
            raise FileNotFoundError(f"A1S1 第003轮原件缺失：{path}")
    weights = torch.load(weights_path, map_location="cpu", weights_only=False)
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    with replay_path.open(encoding="utf-8") as replay_stream:
        replay_header = json.loads(replay_stream.readline())
    digest = sha256(weights_path)
    stable = (weights.get("experimentId") == checkpoint.get("experimentId") ==
              report.get("experimentId") == "A1S1" and
              weights.get("round") == SOURCE_ROUND and checkpoint.get("update") ==
              weights.get("policyVersion") == 30 and len(report.get("updates", ())) == 30 and
              checkpoint.get("completedEpisodes") == 1200 and
              weights.get("mode") == checkpoint.get("mode") == report.get("mode") == "A" and
              weights.get("encoderVersion") == checkpoint.get("encoderVersion") ==
              report.get("encoderVersion") == "ppo-vector-v6-action-semantics" and
              weights.get("buildFingerprint") == checkpoint.get("buildFingerprint") ==
              report.get("buildFingerprint") and
              weights.get("experimentConfigSha256") == checkpoint.get("experimentConfigSha256") ==
              report.get("experimentConfigSha256") and
              weights.get("rewardConfig") == checkpoint.get("rewardConfig") ==
              report.get("rewardConfig") == ppo.REWARD_CONFIG and
              weights.get("entropyCoefficient") == checkpoint["optimizerConfig"]["entropy"] == ENTROPY and
              replay_header.get("training", {}).get("configuration", {}).get("modelSha256") == digest and
              replay_header.get("training", {}).get("configuration", {}).get("policyVersion") == 30 and
              all(torch.equal(t, checkpoint["modelState"][name]) for name, t in
                  weights["modelState"].items()))
    if not stable:
        raise ValueError("A1S1 第003轮权重、检查点、报告或回放身份不一致")
    return weights, {"round": SOURCE_ROUND, "policyVersion": 30,
                     "modelSha256": digest, "checkpointSha256": sha256(checkpoint_path),
                     "reportSha256": sha256(report_path), "replaySha256": sha256(replay_path),
                     "buildFingerprint": weights["buildFingerprint"],
                     "encoderVersion": weights["encoderVersion"],
                     "experimentConfigSha256": weights["experimentConfigSha256"]}


def source_model(client, weights):
    encoder = ppo.Encoder(client.schema)
    model = migrate_flat_state(weights, encoder)
    model.eval()
    return encoder, model


def _probabilities(model, state, candidates, device):
    with torch.inference_mode():
        logits, _ = model(*ppo.batch_tensors([{"state": state, "candidates": candidates}], device))
        return Categorical(logits=logits[0, :len(candidates)]).probs.cpu().tolist()


def _draw(probs, rng):
    value = rng.random()
    running = 0.0
    for index, probability in enumerate(probs):
        running += probability
        if value < running:
            return index
    return len(probs) - 1


def _scripted_choice(observation, first_german_source, pending_white):
    candidates = observation["candidates"]
    if first_german_source and observation["node"] == "SOURCE" and observation["activeSeat"] == "germany":
        index = next((i for i, c in enumerate(candidates) if c.get("definitionId") == "special_150"), None)
        return index, "white_plan" if index is not None else None
    if pending_white and observation.get("choiceKind") == "EXTRA_CARD":
        index = next((i for i, c in enumerate(candidates) if "germany:special_158" in
                      (c.get("choiceIds") or ())), None)
        return index, "arden_after_white" if index is not None else None
    return None, None


def generate_demonstrations(root=ROOT, seeds=DEMO_SEEDS, max_decisions=3000):
    weights, identity = verify_source(root)
    target = root / DEMONSTRATIONS.relative_to(ROOT)
    if target.exists():
        raise FileExistsError(f"示范目录已存在，拒绝覆盖：{target}")
    client = ppo.ArenaClient()
    try:
        encoder, model = source_model(client, weights)
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        model.to(device)
        staging = target.with_name(target.name + ".incomplete")
        if staging.exists():
            raise FileExistsError(f"发现未核查的上次示范临时目录：{staging}")
        staging.mkdir(parents=True)
        labels = []
        summaries = []
        try:
            for seed in seeds:
                rng = random.Random(seed ^ 0x9152A117)
                observation = client.request(op="reset", seed=seed, mode="A", cardSet="events")["observation"]
                first_german_source = True
                pending_white = False
                scripted = []
                decision_count = 0
                deck_discarded_arden = False
                arden_unavailable = False
                opening_recruit = False
                log_path = staging / f"seed-{seed}.jsonl.gz"
                with gzip.open(log_path, "wt", encoding="utf-8") as stream:
                    stream.write(json.dumps({"type": "header", "recordKind": "AI训练记录",
                        "seed": seed, "source": identity, "demoVersion": DEMO_VERSION,
                        "course": "A/events", "sampling": "frozen-model-probability"}, ensure_ascii=False) + "\n")
                    while observation is not None and decision_count < max_decisions:
                        state, candidates = encoder.encode(observation)
                        probs = _probabilities(model, state, candidates, device)
                        scripted_index, label = _scripted_choice(observation, first_german_source, pending_white)
                        index = scripted_index if scripted_index is not None else _draw(probs, rng)
                        selected = observation["candidates"][index]
                        if first_german_source and observation["node"] == "SOURCE" and observation["activeSeat"] == "germany":
                            first_german_source = False
                        if label == "white_plan":
                            pending_white = True
                        if label:
                            scripted.append(label)
                            labels.append({"seed": seed, "decisionId": observation["decision"]["decisionId"],
                                           "label": label, "state": state, "candidates": candidates,
                                           "chosen": index, "candidateIds": [c["id"] for c in observation["candidates"]]})
                        log = {"type": "decision", "seed": seed, "decision": observation["decision"],
                               "selectedBy": "script" if label else "frozen_model_sample",
                               "scriptLabel": label, "legalCandidates": [c["id"] for c in observation["candidates"]],
                               "selectedIndex": index, "selectedId": selected["id"],
                               "selectedProbability": probs[index], "observation": observation}
                        response = client.request(op="step", action={**observation["decision"],
                                                                      "actionId": selected["id"]})
                        if label == "white_plan":
                            deck = client.request(op="snapshot")["snapshot"]["state"]["decks"]["germany"]
                            deck_discarded_arden = any(c["definitionId"] == "special_158"
                                                        for c in deck["discardPile"])
                        log["info"] = response["info"]
                        stream.write(json.dumps(log, ensure_ascii=False, separators=(",", ":")) + "\n")
                        if pending_white and "special_150" in response["info"].get("resolvedCardDefinitions", ()):
                            pending_white = False
                        if label == "white_plan":
                            opening_recruit = any(u["country"] == "germany" and
                                                  u["regionId"] == "eastern_europe" and u["type"] == "army"
                                                  for u in (response["observation"] or {}).get("units", ()))
                        if pending_white and response["observation"] and \
                                not any(c.get("definitionId") == "special_158" for c in
                                        response["observation"].get("candidates", ())) and \
                                response["observation"].get("choiceKind") == "EXTRA_CARD":
                            arden_unavailable = True
                        observation = response["observation"]
                        decision_count += 1
                    outcome = response["result"] if decision_count else None
                    if observation is not None or not outcome or outcome["termination"] != "natural":
                        raise RuntimeError(f"示范种子 {seed} 未自然结束；保留临时诊断，不筛掉难局")
                    summary = {"seed": seed, "decisions": decision_count, "scriptLabels": scripted,
                               "ardenDiscarded": deck_discarded_arden,
                               "ardenUnavailableAtExtraPlay": arden_unavailable,
                               "whiteRecruitVisibleAfterSubmit": opening_recruit,
                               "winner": outcome["winner"], "round": outcome["round"],
                               "scores": outcome["allianceScores"]}
                    stream.write(json.dumps({"type": "result", **summary}, ensure_ascii=False) + "\n")
                    summaries.append(summary)
            torch.save({"format": "quartermaster-ppo-stage2-expert-labels-v1",
                        "source": identity, "demoVersion": DEMO_VERSION,
                        "encoderVersion": ppo.ENCODER_VERSION,
                        "labels": labels, "seeds": list(seeds)}, staging / "expert-labels.pt")
            atomic_json(staging / "manifest.json", {"source": identity, "seeds": list(seeds),
                        "demoVersion": DEMO_VERSION, "episodes": summaries,
                        "labelCount": len(labels), "scriptedOnly": True})
            os.replace(staging, target)
        except Exception:
            # Preserve the incomplete directory for diagnosis; never convert it to valid samples.
            raise
        return target
    finally:
        client.close()


def _opening_probabilities(client, encoder, model, device):
    obs = client.request(op="reset", seed=EVAL_SEEDS[0], mode="A", cardSet="events")["observation"]
    state, candidates = encoder.encode(obs)
    probs = _probabilities(model, state, candidates, device)
    return {"whitePlan": sum(p for p, c in zip(probs, obs["candidates"])
                             if c.get("definitionId") == "special_150"),
            "arden": sum(p for p, c in zip(probs, obs["candidates"])
                         if c.get("definitionId") == "special_158"),
            "basicBuildArmy": sum(p for p, c in zip(probs, obs["candidates"])
                                  if c.get("definitionId") == "build_army"),
            "pass": sum(p for p, c in zip(probs, obs["candidates"])
                        if c.get("kind") == "pass")}


def _fixed_probes(client, encoder, model, device):
    client.request(op="reset", seed=EVAL_SEEDS[0], mode="A", cardSet="events")
    original = client.request(op="snapshot")["snapshot"]
    outcomes = {}
    for occupant in (None, "germany", "soviet_union", "italy"):
        snapshot = copy.deepcopy(original)
        snapshot["state"]["units"] = [u for u in snapshot["state"]["units"]
                                       if u["regionId"] != "eastern_europe"]
        if occupant:
            snapshot["state"]["units"].append({"id": f"probe:east:{occupant}",
                "country": occupant, "type": "army", "regionId": "eastern_europe"})
        observation = client.request(op="restore", snapshot=snapshot)["observation"]
        state, candidates = encoder.encode(observation)
        probs = _probabilities(model, state, candidates, device)
        white = next((i for i, c in enumerate(observation["candidates"])
                      if c.get("definitionId") == "special_150"), None)
        outcomes[occupant or "vacant"] = {"whitePlanProbability": probs[white] if white is not None else None,
            "whitePlanLegality": white is not None,
            "recruitOutcome": action_facts(observation, observation["candidates"][white],
                                           client.schema["regions"])[0]["outcome"] if white is not None else None}
    return outcomes


def _label_statistics(model, labels, device):
    with torch.inference_mode():
        rows = []
        for item in labels:
            logits, _ = model(*ppo.batch_tensors([item], device))
            probs = logits[0, :len(item["candidateIds"])].softmax(-1)
            rows.append({"seed": item["seed"], "decisionId": item["decisionId"],
                         "label": item["label"], "probability": float(probs[item["chosen"]]),
                         "distribution": probs.cpu()})
        return rows


def adapt_demonstrations(root=ROOT, config=BC_CONFIG):
    weights, source = verify_source(root)
    demonstrations = root / DEMONSTRATIONS.relative_to(ROOT)
    manifest_path = demonstrations / "manifest.json"
    labels_path = demonstrations / "expert-labels.pt"
    if not manifest_path.exists() or not labels_path.exists():
        raise FileNotFoundError("请先显式生成并核查32局示范")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    bundle = torch.load(labels_path, map_location="cpu", weights_only=False)
    if (manifest.get("source") != source or bundle.get("source") != source or
        manifest.get("seeds") != list(DEMO_SEEDS) or bundle.get("seeds") != list(DEMO_SEEDS) or
        len(manifest.get("episodes", ())) != len(DEMO_SEEDS) or
        bundle.get("encoderVersion") != ppo.ENCODER_VERSION):
        raise ValueError("示范身份、固定种子或编码版本不一致")
    labels = bundle["labels"]
    if not labels or any(item["label"] not in ("white_plan", "arden_after_white") for item in labels):
        raise ValueError("行为克隆数据包含非脚本动作或没有脚本动作")
    if COMMON.exists():
        raise FileExistsError("共同适应模型已经存在，拒绝覆盖")
    client = ppo.ArenaClient()
    try:
        encoder, model = source_model(client, weights)
        if any(item["state"].shape[0] != encoder.state_dim or
               item["candidates"].shape[1] != encoder.candidate_dim or
               not 0 <= item["chosen"] < item["candidates"].shape[0] for item in labels):
            raise ValueError("示范编码或合法动作索引不匹配")
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        model.to(device)
        before_opening = _opening_probabilities(client, encoder, model, device)
        before_probes = _fixed_probes(client, encoder, model, device)
        before = _label_statistics(model, labels, device)
        reference_distributions = [row["distribution"].to(device) for row in before]
        optimizer = torch.optim.Adam(model.parameters(), lr=config["learningRate"])
        history = []
        for step in range(config["steps"]):
            prior = {key: tensor.detach().clone() for key, tensor in model.state_dict().items()}
            optimizer.zero_grad(set_to_none=True)
            losses = []
            for item in labels:
                logits, _ = model(*ppo.batch_tensors([item], device))
                losses.append(-logits[0, :len(item["candidateIds"])].log_softmax(-1)[item["chosen"]])
            loss = config["lossWeight"] * torch.stack(losses).mean()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 0.5)
            optimizer.step()
            current = _label_statistics(model, labels, device)
            mean_kl = sum(float(torch.sum(ref * (ref.clamp_min(1e-12).log() -
                row["distribution"].to(device).clamp_min(1e-12).log())))
                for ref, row in zip(reference_distributions, current)) / len(labels)
            opening = _opening_probabilities(client, encoder, model, device)
            if mean_kl > config["maxMeanKl"] or opening["whitePlan"] > config["maxOpeningWhiteProbability"]:
                model.load_state_dict(prior)
                history.append({"step": step + 1, "accepted": False, "meanKl": mean_kl,
                                "opening": opening})
                break
            history.append({"step": step + 1, "accepted": True, "meanKl": mean_kl,
                            "opening": opening, "loss": float(loss.detach())})
        after = _label_statistics(model, labels, device)
        after_opening = _opening_probabilities(client, encoder, model, device)
        after_probes = _fixed_probes(client, encoder, model, device)
        model.cpu()
        payload = {"format": "quartermaster-ppo-stage2-common-flat-v1",
                   "networkArchitecture": FLAT,
                   "network": {"stateDim": encoder.state_dim, "candidateDim": encoder.candidate_dim},
                   "encoderVersion": ppo.ENCODER_VERSION, "rewardConfig": ppo.REWARD_CONFIG,
                   "entropyCoefficient": ENTROPY, "buildFingerprint": client.fingerprint,
                   "source": source, "demoSha256": sha256(labels_path),
                   "bcConfig": dict(config), "weightsSha256": ppo.model_weights_sha256(model),
                   "modelState": model.state_dict()}
        COMMON.parent.mkdir(parents=True, exist_ok=True)
        temporary = COMMON.with_suffix(".tmp")
        torch.save(payload, temporary)
        os.replace(temporary, COMMON)
        report = {"source": source, "commonWeightsSha256": payload["weightsSha256"],
                  "demoSha256": payload["demoSha256"], "bcConfig": dict(config),
                  "acceptedUpdates": sum(row["accepted"] for row in history),
                  "history": history, "openingBefore": before_opening,
                  "openingAfter": after_opening,
                  "fixedProbesBefore": before_probes, "fixedProbesAfter": after_probes,
                  "labelsBefore": [{k: v for k, v in row.items() if k != "distribution"}
                                   for row in before],
                  "labelsAfter": [{k: v for k, v in row.items() if k != "distribution"}
                                  for row in after],
                  "valueTargetsUsed": False, "ppoSamplesUsed": False}
        atomic_json(COMMON.with_suffix(".json"), report)
        return COMMON
    finally:
        client.close()


def prepare_pair(root=ROOT):
    weights, source = verify_source(root)
    if not COMMON.is_file():
        raise FileNotFoundError("共同示范适应模型尚未生成")
    common = torch.load(COMMON, map_location="cpu", weights_only=False)
    if (common.get("source") != source or common.get("encoderVersion") != ppo.ENCODER_VERSION or
        common.get("rewardConfig") != ppo.REWARD_CONFIG or common.get("entropyCoefficient") != ENTROPY):
        raise ValueError("共同起点身份不匹配")
    client = ppo.ArenaClient()
    try:
        encoder = ppo.Encoder(client.schema)
        if common.get("buildFingerprint") != client.fingerprint:
            raise ValueError("共同起点与当前场面规则构建不匹配")
        flat = make_network(FLAT, encoder)
        flat.load_state_dict(common["modelState"])
        if ppo.model_weights_sha256(flat) != common["weightsSha256"]:
            raise ValueError("共同起点权重哈希不匹配")
        initial_dir = root / ".state" / "stage2"
        if any((initial_dir / f"{name}-initial.pt").exists() for name in STAGE2_EXPERIMENTS):
            raise FileExistsError("第二阶段分组初始权重已经存在，拒绝覆盖")
        for name, architecture in STAGE2_EXPERIMENTS.items():
            model = flat if name == "S2FLAT" else map_from_flat(flat, encoder)
            digest = ppo.model_weights_sha256(model)
            initial = {"format": "quartermaster-ppo-comparison-initial-v1",
                       "experimentId": name, "networkArchitecture": architecture,
                       "network": {"stateDim": encoder.state_dim, "candidateDim": encoder.candidate_dim},
                       "encoderVersion": ppo.ENCODER_VERSION,
                       "buildFingerprint": client.fingerprint,
                       "sourceModelSha256": source["modelSha256"],
                       "commonWeightsSha256": common["weightsSha256"],
                       "weightsSha256": digest,
                       "modelState": model.state_dict()}
            path = initial_dir / f"{name}-initial.pt"
            temporary = path.with_suffix(".tmp")
            torch.save(initial, temporary)
            os.replace(temporary, path)
        return initial_dir
    finally:
        client.close()


def _initial(root, name):
    path = root / ".state" / "stage2" / f"{name}-initial.pt"
    saved = torch.load(path, map_location="cpu", weights_only=False)
    architecture = STAGE2_EXPERIMENTS[name]
    if saved.get("experimentId") != name or saved.get("networkArchitecture") != architecture or \
            saved.get("encoderVersion") != ppo.ENCODER_VERSION:
        raise ValueError(f"{name} 初始模型身份不符")
    client = ppo.ArenaClient()
    try:
        encoder = ppo.Encoder(client.schema)
        if saved.get("buildFingerprint") != client.fingerprint or saved.get("network") != {
                "stateDim": encoder.state_dim, "candidateDim": encoder.candidate_dim}:
            raise ValueError(f"{name} 初始模型构建或编码维度不符")
        model = make_network(architecture, encoder)
        model.load_state_dict(saved["modelState"])
        if ppo.model_weights_sha256(model) != saved.get("weightsSha256"):
            raise ValueError(f"{name} 初始模型实际权重哈希不符")
    finally:
        client.close()
    return path, saved


def progress(root, name, initial):
    checkpoint = root / ".state" / name / "latest.pt"
    report = checkpoint.with_name("training-report.json")
    outputs = sorted((root / name).glob("第*轮")) if (root / name).exists() else []
    if not checkpoint.exists():
        if report.exists() or outputs:
            raise ValueError(f"{name} 已有成果而无检查点")
        return 0, 0
    saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
    if (saved.get("experimentId") != name or saved.get("mode") != "A" or
        saved.get("networkArchitecture") != STAGE2_EXPERIMENTS[name] or
        saved.get("initialWeightsSha256") != initial["weightsSha256"] or
        saved.get("encoderVersion") != ppo.ENCODER_VERSION or
        saved.get("rewardConfig") != ppo.REWARD_CONFIG or
        saved.get("optimizerConfig", {}).get("entropy") != ENTROPY or
        saved.get("trainingSeed") != TRAIN_SEED or
        saved.get("completedEpisodes") != 40 * saved.get("update", -1) or
        saved.get("nextSeed") != TRAIN_SEED + 40 * saved.get("update", -1)):
        raise ValueError(f"{name} 检查点配置或预算不一致")
    if not report.is_file():
        raise ValueError(f"{name} 检查点对应的报告缺失")
    content = json.loads(report.read_text(encoding="utf-8"))
    if (content.get("experimentId") != name or
        content.get("networkArchitecture") != STAGE2_EXPERIMENTS[name] or
        len(content.get("updates", ())) != saved["update"]):
        raise ValueError(f"{name} 训练报告与检查点不符")
    for number, output in enumerate(outputs, 1):
        if output.name != f"第{number:03d}轮" or not all(
                (output / filename).is_file() for filename in
                (rounds.WEIGHTS_NAME, rounds.RECORD_NAME, "评估.json")):
            raise ValueError(f"{name} 第{number}轮成果不完整")
    if not len(outputs) * 10 <= saved["update"] <= (len(outputs) + 1) * 10:
        raise ValueError(f"{name} 轮次成果与更新数不一致")
    return len(outputs), saved["update"]


def evaluate_round(checkpoint, name, initial_hash, source_weights, output):
    client = ppo.ArenaClient()
    try:
        encoder = ppo.Encoder(client.schema)
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        model = make_network(STAGE2_EXPERIMENTS[name], encoder).to(device)
        optimizer = torch.optim.Adam(model.parameters(), lr=ppo.OPTIMIZER_CONFIG["lr"])
        ppo.restore_checkpoint(checkpoint, model, optimizer, encoder, client, "A", random.Random(),
                               "events", training_seed=TRAIN_SEED, experiment_id=name,
                               entropy_coefficient=ENTROPY, initial_weights_sha256=initial_hash,
                               architecture=STAGE2_EXPERIMENTS[name])
        _, frozen = source_model(client, source_weights)
        frozen.to(device).eval()
        model.eval()
        opening = _opening_probabilities(client, encoder, model, device)
        fixed_probes = _fixed_probes(client, encoder, model, device)
        games = []
        for seed in EVAL_SEEDS:
            for learner_team in ("axis", "allies"):
                reference_team = "allies" if learner_team == "axis" else "axis"
                result = ppo.play_episode(client, encoder, model, device, "A", seed, 3000,
                    rng=random.Random(seed + 19), card_set="events", reference_model=frozen,
                    reference_team=reference_team, deterministic=False)
                end = result["outcome"]
                if end["termination"] != "natural":
                    raise RuntimeError(f"固定评估种子 {seed} 超限，不能静默替换")
                games.append({"seed": seed, "learnerTeam": learner_team,
                              "winner": end["winner"], "round": end["round"],
                              "decisions": result["decisions"], "countryTurns": result["countryTurns"],
                              "axisMinusAllies": end["allianceScores"]["axis"] -
                                  end["allianceScores"]["allies"],
                              "openingWhitePlan": result["openingWhitePlan"],
                              "whiteRecruit": result["whiteRecruit"],
                              "whiteFollowedArden": result["whiteFollowedArden"],
                              "passes": result["passes"],
                              "passRate": result["passes"] / result["decisions"],
                              "repeatedBasicBuilds": result["repeatedBasicBuilds"],
                              "wasteReasons": result["wasteReasons"],
                              "wastePenaltyTotal": result["wastePenaltyTotal"],
                              "remainingBySeat": result["remainingBySeat"],
                              "discardedBySeat": result["discardedBySeat"]})
        summary = {"format": "quartermaster-ppo-stage2-evaluation-v1", "experimentId": name,
                   "networkArchitecture": STAGE2_EXPERIMENTS[name], "seeds": list(EVAL_SEEDS),
                   "actionSampling": "policy-probability", "reference": "frozen-A1S1-round-003",
                   "referenceModelSha256": sha256(source_files()[0]), "referenceStrength":
                   "same-course trained model; not an external skill benchmark",
                   "openingProbabilities": opening, "fixedProbes": fixed_probes,
                   "parameterCount": sum(p.numel() for p in model.parameters()),
                   "evaluationNotTraining": True, "games": games,
                   "axisWhiteOpeningRate": sum(g["openingWhitePlan"] for g in games
                                               if g["learnerTeam"] == "axis") / len(EVAL_SEEDS),
                   "axisWhiteRecruitRate": sum(g["whiteRecruit"] for g in games
                                               if g["learnerTeam"] == "axis") / len(EVAL_SEEDS),
                   "axisWhiteArdenRate": sum(g["whiteFollowedArden"] for g in games
                                             if g["learnerTeam"] == "axis") / len(EVAL_SEEDS)}
        atomic_json(output, summary)
        return summary
    finally:
        client.close()


def complete_round(root, name, number, initial_path, initial, source_weights, dry_run):
    complete, update = progress(root, name, initial)
    if complete >= number:
        return
    target = number * 10
    output = root / name / f"第{number:03d}轮"
    if update > target:
        raise RuntimeError("检查点已越过目标轮次，但轮次成果缺失")
    print(f"{name}（资源A/熵0.01）：第{number}轮，更新 {update}→{target}，"
          f"{(target-update)*40}局；8环境；{STAGE2_EXPERIMENTS[name]}", flush=True)
    if dry_run:
        return
    checkpoint = root / ".state" / name / "latest.pt"
    report = checkpoint.with_name("training-report.json")
    if update < target:
        command = [sys.executable, "scripts/ppo_train.py", "--mode", "A",
                   "--experiment-id", name, "--architecture", STAGE2_EXPERIMENTS[name],
                   "--entropy-coefficient", str(ENTROPY), "--initial-weights", str(initial_path),
                   "--expected-initial-hash", initial["weightsSha256"], "--card-set", "events",
                   "--workers", str(WORKERS), "--updates", str(target-update),
                   "--seed", str(TRAIN_SEED), "--checkpoint", str(checkpoint),
                   "--report", str(report)]
        if update:
            command.append("--resume")
        subprocess.run(command, cwd=ppo.ROOT, check=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".stage-{name}-{number:03d}-",
                                     dir=output.parent) as temporary:
        stage = Path(temporary)
        digest = rounds.export_weights(checkpoint, stage / rounds.WEIGHTS_NAME,
                                       "A", number, TRAIN_SEED, experiment_id=name)
        rounds.record_game(checkpoint, stage / rounds.RECORD_NAME, "A", number,
            TRAIN_SEED, digest, experiment_id=name, entropy_coefficient=ENTROPY,
            initial_weights_sha256=initial["weightsSha256"],
            architecture=STAGE2_EXPERIMENTS[name])
        evaluate_round(checkpoint, name, initial["weightsSha256"], source_weights,
                       stage / "评估.json")
        os.replace(stage, output)


def train_pair(root=ROOT, rounds_to_add=None, continue_plan=False, dry_run=False):
    source_weights, source = verify_source(root)
    if not COMMON.is_file():
        if dry_run and rounds_to_add and rounds_to_add > 0:
            print(f"预览：源 A1S1 第003轮 {source['modelSha256']}；先生成32局示范、行为克隆、"
                  f"准备共同起点，再顺序训练 S2FLAT/S2MAP 各{rounds_to_add}轮；"
                  f"每组 {rounds_to_add*10*40}局。当前前置阶段尚未完成。")
            return
        raise FileNotFoundError("请先完成示范适应并核查共同起点")
    initial = {name: _initial(root, name) for name in STAGE2_EXPERIMENTS}
    common = torch.load(COMMON, map_location="cpu", weights_only=False)
    for name, (path, saved) in initial.items():
        if saved.get("sourceModelSha256") != source["modelSha256"] or \
                saved.get("commonWeightsSha256") != common["weightsSha256"]:
            raise ValueError(f"{name} 不源于共同示范适应起点")
    plan = json.loads(PLAN.read_text(encoding="utf-8")) if PLAN.exists() else None
    if plan and plan.get("status") == "pending":
        if rounds_to_add is not None or not continue_plan and not dry_run:
            raise ValueError("存在未完成计划；请使用 --continue-plan，不得重复增加第一组预算")
    else:
        if continue_plan:
            raise ValueError("没有未完成计划")
        if rounds_to_add is None or rounds_to_add < 1:
            raise ValueError("本次每组新增轮数必须为正整数")
        base = {name: progress(root, name, saved)[0] for name, (_, saved) in initial.items()}
        plan = {"format": "quartermaster-ppo-stage2-plan-v1", "status": "pending",
                "source": source, "commonWeightsSha256": common["weightsSha256"],
                "initialWeightsSha256": {name: saved["weightsSha256"]
                                         for name, (_, saved) in initial.items()},
                "initialFilesSha256": {name: sha256(path) for name, (path, _) in initial.items()},
                "baseRounds": base, "addedRounds": rounds_to_add,
                "targetRounds": {name: count + rounds_to_add for name, count in base.items()},
                "mode": "A", "entropy": ENTROPY, "workers": WORKERS,
                "trainingSeed": TRAIN_SEED, "rewardConfig": ppo.REWARD_CONFIG,
                "encoderVersion": ppo.ENCODER_VERSION,
                "architectures": STAGE2_EXPERIMENTS.copy(),
                "evaluationSeeds": list(EVAL_SEEDS)}
        if not dry_run:
            if not torch.cuda.is_available():
                raise RuntimeError("没有 CUDA GPU，未开始两组训练")
            atomic_json(PLAN, plan)
    if (plan["source"] != source or plan["commonWeightsSha256"] != common["weightsSha256"] or
        plan["rewardConfig"] != ppo.REWARD_CONFIG or plan["encoderVersion"] != ppo.ENCODER_VERSION or
        plan["architectures"] != STAGE2_EXPERIMENTS or plan["trainingSeed"] != TRAIN_SEED or
        plan["initialWeightsSha256"] != {name: saved["weightsSha256"]
                                         for name, (_, saved) in initial.items()} or
        plan["initialFilesSha256"] != {name: sha256(path)
                                       for name, (path, _) in initial.items()}):
        raise ValueError("第二阶段计划与当前起点或配置不一致")
    print("第二阶段：先 S2FLAT，再 S2MAP；每组新增 "
          f"{plan['addedRounds']}轮，每轮10次更新×40局；固定源 A1S1 第003轮；"
          f"共同权重 {common['weightsSha256']}。", flush=True)
    for name, (path, saved) in initial.items():
        for number in range(plan["baseRounds"][name] + 1, plan["targetRounds"][name] + 1):
            complete_round(root, name, number, path, saved, source_weights, dry_run)
    if not dry_run:
        plan["status"] = "completed"
        atomic_json(PLAN, plan)


def main():
    parser = argparse.ArgumentParser(description="A1S1 第003轮：显式生成示范、行为克隆、顺序对照")
    parser.add_argument("stage", choices=["verify", "generate", "adapt", "prepare", "train"])
    parser.add_argument("--rounds", type=int)
    parser.add_argument("--continue-plan", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.stage == "verify":
        print(json.dumps(verify_source()[1], ensure_ascii=False, indent=2))
    elif args.stage == "generate":
        if args.dry_run:
            print(f"预览：生成固定种子 {len(DEMO_SEEDS)} 局；只标记白色方案和可用时的阿登。")
        else:
            print(generate_demonstrations())
    elif args.stage == "adapt":
        if args.dry_run:
            print(f"预览：行为克隆 {BC_CONFIG}；不做 PPO 更新。")
        else:
            print(adapt_demonstrations())
    elif args.stage == "prepare":
        if args.dry_run:
            print("预览：从共同平面模型导出 S2FLAT/S2MAP 两个起点，新建优化器。")
        else:
            print(prepare_pair())
    else:
        if args.rounds is None and not args.continue_plan and not args.dry_run:
            raw = input("每组本次新增轮数（推荐先输入2）：").strip()
            if not raw.isdecimal() or int(raw) < 1:
                parser.error("轮数必须为正整数")
            args.rounds = int(raw)
        train_pair(rounds_to_add=args.rounds, continue_plan=args.continue_plan,
                   dry_run=args.dry_run)


if __name__ == "__main__":
    main()
