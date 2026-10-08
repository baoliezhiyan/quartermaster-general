"""One-time, exact-identity C3 migration for the merged-trigger candidate fix.

Only update 0 is eligible. Model weights, game states, seeds and the two-round
plan are preserved; the old initializer and evaluation remain archived.
"""

import gzip
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

import torch

from scripts import ppo_combo_course_v2 as course
from scripts import ppo_train as ppo
from scripts.ppo_network_factory import A2S1_ADAPTER, make_network

ROOT = ppo.ROOT / "PPO训练"
STATE = ROOT / ".state" / "A2S1C3"
INITIAL = STATE / "initial.pt"
OLD_POOL = ROOT / ".state" / "A2S1C2" / "course-pool-v8.json.gz"
NEW_POOL = STATE / "course-pool-merged-trigger-v1.json.gz"
ARCHIVE = STATE / "pre-merged-trigger-fix"
AUDIT = ARCHIVE / "migration.json"
OLD_INITIAL_SHA = "dad3c0390952d4ab9aa6332d786f892fa27d0ccfd29f1a56514724cb196e939f"
OLD_POOL_SHA = "97f6d3032c348bbb880d395ce213d1bc5dedb8c2032f50fdcb4b3bbfc4b4fc03"
WEIGHTS_SHA = "8af92d1a069eed3981ca013ebcaa924bf86737a2c9e9a12f00571914b7474234"
OLD_BUILD = "2bbac3d781b65eb6e29584fc037b20e476ef7167f23b7f07cd35c7da37c3c23b"
NEW_BUILD = "433a8ab044f124a68b29cef01e1a18475b9545d2b12ebf0bff0e28823447b252"
FIRST_MIGRATED_INITIAL_SHA = "12382c0b64eacb0a91841d750b71bfd20fb79e44ecce47d66dae6ddad2960965"
NEW_POOL_SHA = "13ae0b722bf03bd2e0fedd613a51fc4e8ff2578e303d98b6dff32f97275f5cd6"
OLD_PLAN_CONFIG_SHA = "e9d71d57d578d5cb4ef7501bb67fde36e6a4f0be9fdbd613aee3565c1cc317f8"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def weight_sha(state, encoder):
    model = make_network(A2S1_ADAPTER, encoder)
    model.load_state_dict(state, strict=True)
    return ppo.model_weights_sha256(model)


def finish_pool_pointer():
    """Complete the audited first migration's pool pointer without touching weights."""
    if (sha(INITIAL) != FIRST_MIGRATED_INITIAL_SHA or sha(NEW_POOL) != NEW_POOL_SHA or
            sha(ARCHIVE / "initial.pt") != OLD_INITIAL_SHA):
        raise ValueError("The already-migrated C3 files differ from the reviewed audit")
    audit = json.loads(AUDIT.read_text(encoding="utf-8"))
    if (audit["migratedInitializerSha256"] != FIRST_MIGRATED_INITIAL_SHA or
            audit["migratedCoursePoolSha256"] != NEW_POOL_SHA):
        raise ValueError("C3 migration audit differs")
    initial = torch.load(INITIAL, map_location="cpu", weights_only=False)
    if (initial["buildFingerprint"] != NEW_BUILD or
            initial["weightsSha256"] != WEIGHTS_SHA or
            initial["coursePoolSha256"] != OLD_POOL_SHA):
        raise ValueError("C3 initializer cannot be finalized")
    initial["coursePoolSha256"] = NEW_POOL_SHA
    initial["adapterFixMigration"]["migratedCoursePoolSha256"] = NEW_POOL_SHA
    with tempfile.NamedTemporaryFile(prefix=".c3-initial-final-", suffix=".pt",
                                     dir=STATE, delete=False) as stream:
        staged = Path(stream.name)
    try:
        torch.save(initial, staged)
        check = torch.load(staged, map_location="cpu", weights_only=False)
        if (check["coursePoolSha256"] != NEW_POOL_SHA or
                check["weightsSha256"] != WEIGHTS_SHA):
            raise ValueError("Finalized initializer failed to reload")
        os.replace(staged, INITIAL)
    finally:
        staged.unlink(missing_ok=True)
    audit["migratedInitializerSha256"] = sha(INITIAL)
    audit["poolPointerFinalized"] = True
    AUDIT.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(audit, ensure_ascii=False, indent=2))


def migrate_saved_plan():
    """Keep the user's 2-round budget while binding it to the migrated pool."""
    from scripts import ppo_combo_c3_rounds as rounds

    plan_path = STATE / "plan.json"
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    audit = json.loads(AUDIT.read_text(encoding="utf-8"))
    if (sha(INITIAL) != audit["migratedInitializerSha256"] or
            sha(NEW_POOL) != NEW_POOL_SHA or
            plan.get("fromRound") != 1 or plan.get("targetRound") != 2 or
            plan.get("initialWeightsSha256") != WEIGHTS_SHA or
            plan.get("trainingSeed") != 20261009):
        raise ValueError("C3 migration plan or files differ")
    initial, _, config = rounds.identity()
    if initial["weightsSha256"] != WEIGHTS_SHA:
        raise ValueError("C3 migrated initial weights differ")
    current_hash = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    if plan["courseConfigSha256"] == current_hash:
        print("C3 two-round plan is already migrated")
        return
    if plan["courseConfigSha256"] != OLD_PLAN_CONFIG_SHA:
        raise ValueError("C3 saved plan has an unreviewed course identity")
    shutil.copy2(plan_path, ARCHIVE / "plan.json")
    plan["courseConfigSha256"] = current_hash
    with tempfile.NamedTemporaryFile(prefix=".c3-plan-", suffix=".json", dir=STATE,
                                     mode="w", encoding="utf-8", delete=False) as stream:
        staged = Path(stream.name)
        json.dump(plan, stream, ensure_ascii=False, indent=2)
    try:
        os.replace(staged, plan_path)
    finally:
        staged.unlink(missing_ok=True)
    audit["sourcePlanCourseConfigSha256"] = OLD_PLAN_CONFIG_SHA
    audit["migratedPlanCourseConfigSha256"] = current_hash
    AUDIT.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"fromUpdate": 0, "targetUpdate": 20,
                      "remainingEpisodes": 800, "courseConfigSha256": current_hash},
                     ensure_ascii=False, indent=2))


def main():
    if AUDIT.exists() and NEW_POOL.exists() and ARCHIVE.exists():
        if sha(INITIAL) == FIRST_MIGRATED_INITIAL_SHA:
            finish_pool_pointer()
        else:
            migrate_saved_plan()
        return
    if any((STATE / name).exists() for name in ("latest.pt", "training-report.json")):
        raise ValueError("C3 has a complete update; this update-0 migration is not applicable")
    if AUDIT.exists() or NEW_POOL.exists() or ARCHIVE.exists():
        raise FileExistsError("A C3 migration output already exists; inspect it before retrying")
    plan = json.loads((STATE / "plan.json").read_text(encoding="utf-8"))
    if plan.get("fromRound") != 1 or plan.get("targetRound") != 2:
        raise ValueError("The saved two-round C3 plan differs")
    if sha(INITIAL) != OLD_INITIAL_SHA or sha(OLD_POOL) != OLD_POOL_SHA:
        raise ValueError("C3 initializer or C2 course pool differs from reviewed source")
    original = torch.load(INITIAL, map_location="cpu", weights_only=False)
    if (original.get("experimentId") != "A2S1C3" or
            original.get("weightsSha256") != WEIGHTS_SHA or
            original.get("buildFingerprint") != OLD_BUILD or
            original.get("resourceMode") != "A"):
        raise ValueError("C3 initializer identity differs")
    with gzip.open(OLD_POOL, "rt", encoding="utf-8") as stream:
        pool = json.load(stream)
    if not pool.get("complete") or pool["identity"].get("buildFingerprint") != OLD_BUILD:
        raise ValueError("Original course pool identity differs")
    if any(entry["snapshot"]["header"].get("buildFingerprint") != OLD_BUILD
           for entry in pool["entries"]):
        raise ValueError("Original course snapshots have mixed build identities")
    client = ppo.ArenaClient(card_set="signals")
    try:
        if client.fingerprint != NEW_BUILD:
            raise ValueError("The corrected arena bundle differs from the reviewed fix")
        encoder = ppo.Encoder(client.schema)
        expected = course.pool_identity(client, original["sourceCheckpointSha256"],
                                        original["generatorWeightsSha256"])
        old_except_build = {key: value for key, value in pool["identity"].items()
                            if key not in ("buildFingerprint", "identitySha256")}
        new_except_build = {key: value for key, value in expected.items()
                            if key not in ("buildFingerprint", "identitySha256")}
        if old_except_build != new_except_build:
            raise ValueError("Course identity changed beyond the arena bundle")
        pool["identity"] = expected
        for entry in pool["entries"]:
            entry["snapshot"]["header"]["buildFingerprint"] = NEW_BUILD
            observation = client.request(op="restore", snapshot=entry["snapshot"])["observation"]
            if observation is None:
                raise ValueError(f"Migrated course start has no decision: {entry['courseId']}")
        migrated = dict(original)
        migrated["buildFingerprint"] = NEW_BUILD
        migrated["adapterFixMigration"] = {
            "kind": "merged-trigger-target-action-v1", "sourceInitializerSha256": OLD_INITIAL_SHA,
            "sourceBuildFingerprint": OLD_BUILD, "sourceCoursePoolSha256": OLD_POOL_SHA}
        if weight_sha(migrated["modelState"], encoder) != WEIGHTS_SHA:
            raise ValueError("Model weights changed while preparing migration")
        with tempfile.TemporaryDirectory(prefix=".c3-migrate-", dir=STATE) as folder:
            staged_pool = Path(folder) / "pool.json.gz"
            with staged_pool.open("wb") as output:
                with gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as stream:
                    stream.write(json.dumps(pool, ensure_ascii=False,
                                            separators=(",", ":")).encode("utf-8"))
            course.read_pool(staged_pool, expected)
            migrated["coursePoolSha256"] = sha(staged_pool)
            migrated["adapterFixMigration"]["migratedCoursePoolSha256"] = sha(staged_pool)
            staged_initial = Path(folder) / "initial.pt"
            torch.save(migrated, staged_initial)
            check = torch.load(staged_initial, map_location="cpu", weights_only=False)
            if (check["buildFingerprint"] != NEW_BUILD or
                    weight_sha(check["modelState"], encoder) != WEIGHTS_SHA):
                raise ValueError("Migrated initializer did not reload exactly")
            ARCHIVE.mkdir()
            shutil.copy2(INITIAL, ARCHIVE / "initial.pt")
            old_baseline = ROOT / "A2S1C3" / "第000轮"
            if old_baseline.exists():
                destination = ROOT / "A2S1C3" / "第000轮-旧构建归档"
                if destination.exists():
                    raise FileExistsError("Archived baseline already exists")
                old_baseline.rename(destination)
            os.replace(staged_pool, NEW_POOL)
            os.replace(staged_initial, INITIAL)
        audit = {"sourceInitializerSha256": OLD_INITIAL_SHA,
                 "migratedInitializerSha256": sha(INITIAL),
                 "sourceCoursePoolSha256": OLD_POOL_SHA,
                 "migratedCoursePoolSha256": sha(NEW_POOL),
                 "weightsSha256": WEIGHTS_SHA, "oldBuildFingerprint": OLD_BUILD,
                 "newBuildFingerprint": NEW_BUILD, "courseStarts": len(pool["entries"]),
                 "completedUpdates": 0, "planTargetUpdates": 20}
        AUDIT.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(audit, ensure_ascii=False, indent=2))
    finally:
        client.close()


if __name__ == "__main__":
    main()
