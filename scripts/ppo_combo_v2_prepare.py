"""Explicit A2S1C1 update-30 -> A2S1C2 small-BC migration.

Pool generation is a separate command.  This script never runs PPO and never
overwrites the parent checkpoint, an existing migration, or old experiments.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path

import torch

from scripts import ppo_train as ppo
from scripts import ppo_combo_bc as bc
from scripts import ppo_combo_v2_opening_check as opening
from scripts import ppo_combo_course_v2 as course
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network

ROOT = ppo.ROOT / "PPO训练" / ".state" / "A2S1C2"
PARENT = ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" / "latest.pt"
GENERATOR = ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" / "initial.pt"
POOL = ROOT / "course-pool-v8.json.gz"
REVIEWED_PARENT_SHA256 = "fc759177a2a0bdb3ad02196831c6662f3c9da7704b277d63067d64ca392c0b38"
REVIEWED_PARENT_BUILD = "3a1ad8fd30fc54ceeace54302232d13d2e83a9a64bcedcb83a11a663db4654cd"
REVIEWED_CURRENT_BUILD = "2bbac3d781b65eb6e29584fc037b20e476ef7167f23b7f07cd35c7da37c3c23b"


def reviewed_build_migration(parent_path, saved, client):
    """One exact C1->1.8.2 migration, backed by fixed-seed arena differential."""
    if (sha(parent_path) != REVIEWED_PARENT_SHA256 or
            saved.get("buildFingerprint") != REVIEWED_PARENT_BUILD or
            client.fingerprint != REVIEWED_CURRENT_BUILD):
        raise ValueError("Unreviewed C1-to-current build migration")
    return {"parentCheckpointSha256": REVIEWED_PARENT_SHA256,
        "parentBuildFingerprint": REVIEWED_PARENT_BUILD,
        "currentBuildFingerprint": REVIEWED_CURRENT_BUILD,
        "differentialSeeds": [2026100500, 2026100504, 2026102406, 2026103400,
                              2026104406],
        "differentialDecisionCounts": [138, 58, 101, 148, 197]}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_parent(path: Path, client, encoder):
    saved = torch.load(path, map_location="cpu", weights_only=False)
    migration = reviewed_build_migration(path, saved, client)
    report = ppo.ROOT / "PPO训练" / ".state" / "A2S1C1" / "training-report.json"
    if (saved.get("experimentId") != "A2S1C1" or saved.get("update") != 30 or
            saved.get("completedEpisodes") != 1200 or
            saved.get("networkArchitecture") != A2S1_ADAPTER or
            saved.get("mode") != "A" or saved.get("cardSet") != "signals" or
            saved.get("optimizerConfig", {}).get("entropy") != .01 or
            saved.get("policyVersion") != 30 or
            saved.get("rewardConfig") != ppo.reward_config("signals") or
            saved.get("network") != {"stateDim": encoder.state_dim,
                                     "candidateDim": encoder.candidate_dim}):
        raise ValueError("A2S1C1 parent is not the completed update-30 compatible model")
    data = json.loads(report.read_text(encoding="utf-8"))
    if (data.get("experimentId") != "A2S1C1" or not data.get("updates") or
            data["updates"][-1]["number"] != 30):
        raise ValueError("A2S1C1 report does not document the same complete update")
    exported_path = ppo.ROOT / "PPO训练" / "A2S1C1" / "第003轮" / "模型.pt"
    exported = torch.load(exported_path, map_location="cpu", weights_only=False)
    if (exported.get("experimentId") != "A2S1C1" or exported.get("round") != 3 or
        exported.get("policyVersion") != 30 or
        exported.get("buildFingerprint") != saved["buildFingerprint"] or
        any(name not in exported["modelState"] or
            not torch.equal(tensor, exported["modelState"][name])
            for name, tensor in saved["modelState"].items())):
        raise ValueError("Round-three exported weights do not match the completed checkpoint")
    model = make_network(A2S1_ADAPTER, encoder)
    model.load_state_dict(saved["modelState"], strict=True)
    return saved, model


def _save_new(path: Path, payload):
    if path.exists():
        raise FileExistsError(path)
    temporary = path.with_suffix(".tmp")
    try:
        torch.save(payload, temporary)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_json_new(path: Path, payload):
    if path.exists():
        raise FileExistsError(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                             encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def independent_acceptance(adaptation, holdout, autonomous, positive_overlap,
                           preparation_valid, normal_opening):
    """Existing hard gates; tactical successes remain diagnostics, not gates."""
    reasons = []
    if not adaptation["accepted"]:
        reasons.append("adaptation_not_accepted")
    if not holdout["accepted"]:
        reasons.append("nine_teaching_targets_not_covered")
    if positive_overlap:
        reasons.append("heldout_duplicates_training_encoding")
    if {item["template"] for item in autonomous} != set(bc.TEACHING_TARGETS):
        reasons.append("autonomous_evaluation_missing_template")
    if not preparation_valid:
        reasons.append("preparation_validation_failed")
    if not normal_opening["allSixSeatsCovered"]:
        reasons.append("normal_opening_coverage_incomplete")
    return {"accepted": not reasons, "reasons": reasons,
            "autonomousTacticalResultsAreDiagnosticOnly": True,
            "normalOpeningProbabilityIsDiagnosticOnly": True}


def _save_accepted_initial(state: Path, payload, acceptance):
    if not acceptance["accepted"]:
        raise ValueError("Rejected independent acceptance cannot publish initial.pt")
    _save_new(state / "initial.pt", payload)


def prepare(parent: Path = PARENT, pool: Path = POOL, state: Path = ROOT,
            dry_run=False):
    for name in ("initial.pt", "pre-demonstration.pt", "post-demonstration.pt"):
        if (state / name).exists():
            raise FileExistsError(f"A2S1C2 already has {name}; old results are protected")
    lock = None
    if not dry_run:
        state.mkdir(parents=True, exist_ok=True)
        lock = state / ".prepare.lock"
        with lock.open("x", encoding="utf-8") as stream:
            stream.write(f"pid={os.getpid()}\n")
    client = None
    try:
        client = ppo.ArenaClient(card_set="signals")
        encoder = ppo.Encoder(client.schema)
        source, model = verify_parent(parent, client, encoder)
        migration = reviewed_build_migration(parent, source, client)
        parent_hash, parent_weight = sha(parent), ppo.model_weights_sha256(model)
        pool_hash = sha(pool)
        frozen = torch.load(GENERATOR, map_location="cpu", weights_only=False)
        if (frozen.get("experimentId") != "A2S1C1" or frozen.get("sourceExperimentId") != "A2S1" or
                frozen.get("sourceUpdate") != 20 or frozen.get("buildFingerprint") != source["buildFingerprint"] or
                frozen.get("network") != source["network"] or
                frozen.get("networkArchitecture") != A2S1_ADAPTER):
            raise ValueError("Frozen preparation policy is not the reviewed A2S1 update-20 model")
        frozen_model = make_network(A2S1_ADAPTER, encoder)
        frozen_model.load_state_dict(frozen["modelState"], strict=True)
        generator_weight = ppo.model_weights_sha256(frozen_model)
        if generator_weight != frozen.get("weightsSha256"):
            raise ValueError("Frozen preparation policy weight hash differs")
        identity = course.pool_identity(client, parent_hash, generator_weight)
        data = course.read_pool(pool, identity)
        required = {f"{t.key}:{v}:{layer}" for t in course.TEMPLATES
                    for v in ("positive", "control") for layer in ("payoff", "preparation")}
        actual = {f"{e['template']}:{e['variant']}:{e['layer']}"
                  for e in data["entries"]}
        if not required <= actual:
            raise ValueError(f"C2 pool incomplete: {sorted(required - actual)}")
        preparation_coverage = []
        scene_splits = {}
        positive_scene_splits = {}
        for entry in data["entries"]:
            if entry["layer"] != "preparation":
                continue
            observation = course.validate_preparation(client, entry)
            key = course.encoded_scene_key(encoder, observation)
            scene_splits.setdefault(key, set()).add(entry["split"])
            if entry["variant"] == "positive":
                positive_scene_splits.setdefault(key, set()).add(entry["split"])
            preparation_coverage.append({"courseId": course.course_id(entry),
                "target": entry["preparationTarget"], "missing": entry["preparationMissing"],
                "decisionsToPayoff": entry["distanceDecisionsToPayoff"],
                "roundsToPayoff": entry["distanceRoundsToPayoff"],
                "controlRole": entry.get("controlRole"), "encodedSceneSha256": key})
        cross_split = sum(len(splits) > 1 for splits in scene_splits.values())
        positive_cross_split = sum(len(splits) > 1 for splits in
                                   positive_scene_splits.values())
        labels, controls, evidence = bc.extract(client, encoder, model, data["entries"])
        label_targets = {(item["metadata"]["courseId"].split(":", 1)[0],
                          item["metadata"]["cardId"]) for item in labels}
        missing_lessons = {key: card for key, card in bc.TEACHING_TARGETS.items()
                           if (key, card) not in label_targets}
        if dry_run:
            return {"parentFileSha256": parent_hash, "parentWeightsSha256": parent_weight,
                    "poolFileSha256": sha(pool), "demonstrations": evidence,
                "configuration": bc.CONFIG, "explicitBuildMigration": migration,
                "preparationCoverage": preparation_coverage,
                "crossSplitIdenticalEncodedScenes": cross_split,
                "positiveCrossSplitIdenticalEncodedScenes": positive_cross_split,
                "missingDirectTeachingTargets": missing_lessons}
        if missing_lessons or not labels or not controls:
            raise ValueError(f"Missing verified lessons or independent retention scenes: "
                             f"targets={missing_lessons}, controls={len(controls)}")
        baseline = copy.deepcopy(model.state_dict())
        result = bc.adapt(model, labels, controls)
        original = make_network(A2S1_ADAPTER, encoder)
        original.load_state_dict(baseline, strict=True)
        # The candidate is fixed before any held-out or autonomous evaluation.
        selected_weight = ppo.model_weights_sha256(model)
        if (result["after"]["maxControlKl"] > bc.CONFIG["maxControlKl"] or
                result["after"]["maxControlValueShift"] >
                bc.CONFIG["maxControlValueShift"]):
            raise ValueError("Restored candidate violates a retention constraint")
        preparation_valid = True
        for entry in data["entries"]:
            if entry["layer"] == "preparation":
                course.validate_preparation(client, entry)
        if sha(parent) != parent_hash or sha(pool) != pool_hash:
            raise ValueError("Parent or pool changed during the bounded adaptation")
        holdout = bc.assess_holdout(client, encoder, original, model, data["entries"], labels)
        autonomous = bc.assess_autonomous(client, encoder, model, data["entries"])
        normal_opening = opening.compare_models(client, encoder, original, model)
        acceptance = independent_acceptance(result, holdout, autonomous,
            positive_cross_split, preparation_valid, normal_opening)
        source_commit = subprocess.check_output(["git", "rev-parse", "HEAD"],
            cwd=ppo.ROOT, text=True).strip()
        audit = {"format": bc.FORMAT, "experimentId": "A2S1C2",
                 "sourceCommit": source_commit, "buildFingerprint": client.fingerprint,
                 "explicitBuildMigration": migration,
                 "parentCheckpointSha256": parent_hash,
                 "parentWeightsSha256": parent_weight,
                 "selectedWeightsSha256": selected_weight,
                 "poolFileSha256": sha(pool), "demonstrations": evidence,
                 "adaptation": result, "heldout": holdout,
                 "autonomousHoldout": autonomous,
                 "normalOpening": normal_opening,
                 "independentAcceptance": acceptance,
                 "preparationCoverage": preparation_coverage,
                 "crossSplitIdenticalEncodedScenes": cross_split}
        audit["positiveCrossSplitIdenticalEncodedScenes"] = positive_cross_split
        if not acceptance["accepted"]:
            failures = state / "failed-demonstrations"
            failures.mkdir(parents=True, exist_ok=True)
            attempt = time.time_ns()
            _write_json_new(failures / f"attempt-{attempt}.json", audit)
            _save_new(failures / f"attempt-{attempt}.pt", {"format": bc.FORMAT,
                "experimentId": "A2S1C2", "stage": "rejected-short-adaptation",
                "parentCheckpointSha256": parent_hash,
                "weightsSha256": selected_weight,
                "modelState": model.state_dict()})
            raise RuntimeError(f"Independent acceptance failed {acceptance['reasons']}; parent preserved")
        state.mkdir(parents=True, exist_ok=True)
        _save_new(state / "pre-demonstration.pt", {"format": bc.FORMAT,
            "experimentId": "A2S1C2", "stage": "before", "parentCheckpointSha256": parent_hash,
            "weightsSha256": parent_weight, "modelState": baseline})
        _write_json_new(state / "demonstration-audit.json", audit)
        post_weight = ppo.model_weights_sha256(model)
        _save_new(state / "post-demonstration.pt", {"format": bc.FORMAT,
            "experimentId": "A2S1C2", "stage": "after", "parentCheckpointSha256": parent_hash,
            "weightsSha256": post_weight, "modelState": model.state_dict(),
            "configuration": bc.CONFIG, "auditFileSha256": sha(state / "demonstration-audit.json")})
        saved_post = torch.load(state / "post-demonstration.pt", map_location="cpu",
                                weights_only=False)
        reloaded_post = make_network(A2S1_ADAPTER, encoder)
        reloaded_post.load_state_dict(saved_post["modelState"], strict=True)
        if (ppo.model_weights_sha256(reloaded_post) != post_weight or
                saved_post["auditFileSha256"] != sha(state / "demonstration-audit.json") or
                sha(parent) != parent_hash):
            raise ValueError("Post-demonstration reload or parent preservation failed")
        initial = {"format": "quartermaster-ppo-comparison-initial-v1",
            "experimentId": "A2S1C2", "networkArchitecture": A2S1_ADAPTER,
            "network": source["network"], "encoderVersion": ppo.A2S1_ENCODER_VERSION,
            "buildFingerprint": client.fingerprint,
            "explicitBuildMigration": migration,
            "sourceCheckpointSha256": parent_hash,
            "sourceExperimentId": "A2S1C1", "sourceUpdate": 30,
            "sourceCompletedEpisodes": 1200,
            "sourceRewardVersion": ppo.reward_config("signals")["actionWasteVersion"],
            "rewardConfig": ppo.reward_config("signals"),
            "optimizerMigration": "new-Adam-no-old-momentum",
            "generatorWeightsSha256": generator_weight,
            "demonstrationConfig": bc.CONFIG,
            "demonstrationAuditSha256": sha(state / "demonstration-audit.json"),
            "postDemonstrationFileSha256": sha(state / "post-demonstration.pt"),
            "weightsSha256": post_weight, "modelState": model.state_dict()}
        _save_accepted_initial(state, initial, acceptance)
        restored = torch.load(state / "initial.pt", map_location="cpu", weights_only=False)
        check = make_network(A2S1_ADAPTER, encoder)
        check.load_state_dict(restored["modelState"], strict=True)
        if ppo.model_weights_sha256(check) != post_weight or sha(parent) != parent_hash:
            raise ValueError("A2S1C2 reload or parent preservation failed")
        return {"parentFileSha256": parent_hash, "parentWeightsSha256": parent_weight,
                "postWeightsSha256": post_weight, "initialFileSha256": sha(state / "initial.pt"),
                "poolFileSha256": sha(pool), "demonstrations": evidence,
                "adaptation": result}
    finally:
        if client is not None:
            client.close()
        if lock is not None:
            lock.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description="Bounded A2S1C2 BC; no PPO training")
    parser.add_argument("--parent", type=Path, default=PARENT)
    parser.add_argument("--pool", type=Path, default=POOL)
    parser.add_argument("--state", type=Path, default=ROOT)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    torch.set_num_threads(2)
    result = prepare(args.parent, args.pool, args.state, args.dry_run)
    if args.dry_run:
        summary = {k: v for k, v in result.items() if k != "demonstrations"}
        summary["demonstrations"] = {k: v for k, v in result["demonstrations"].items()
            if k not in ("verifiedPayoffs", "excluded")}
    else:
        adaptation = result["adaptation"]
        summary = {k: v for k, v in result.items() if k not in
                   ("adaptation", "demonstrations")}
        summary["demonstrations"] = {k: v for k, v in result["demonstrations"].items()
            if k not in ("verifiedPayoffs", "excluded")}
        summary["adaptation"] = {"accepted": adaptation["accepted"],
            "reason": adaptation["reason"], "seconds": adaptation["seconds"],
            "steps": len(adaptation["history"]),
            "beforeMeanProbability": adaptation["before"]["meanPositiveProbability"],
            "afterMeanProbability": adaptation["after"]["meanPositiveProbability"],
            "audit": str(args.state / "demonstration-audit.json")}
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
