"""One complete deterministic demonstration using the accepted A1S2 derivative.

No training updates or scripted actions are made in this game.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import tempfile
from pathlib import Path

import torch

from scripts import ppo_rounds as rounds
from scripts import ppo_train as ppo
from scripts.ppo_a1s2_train import INITIAL, RESULTS, read_initial
from scripts.ppo_auxiliary import sha256
from scripts.ppo_network_factory import ADAPTED_MAP, make_network

DEFAULT_SEED = 20600000
DEFAULT_ROOT = RESULTS.parent / "白色方案示范适应"


def create_demo(seed=DEFAULT_SEED, output_root=DEFAULT_ROOT):
    initial, _ = read_initial()
    target = Path(output_root) / f"示范对局-种子{seed}"
    if target.exists():
        raise FileExistsError(f"已存在演示对局，拒绝覆盖：{target}")
    client = None
    Path(output_root).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".demo-{seed}-", dir=output_root) as temporary:
        stage = Path(temporary)
        raw = stage / "AI训练记录.jsonl"
        replay = stage / "可导入回放.jsonl"
        metadata = {"round": 2, "policyVersion": 20,
                    "adaptationStep": 144,
                    "experimentId": "A1S2", "historicalExperimentId": "S2MAP",
                    "resourceMode": "A", "entropyCoefficient": 0.01,
                    "recordSeed": seed, "initialFileSha256": sha256(INITIAL),
                    "modelWeightsSha256": initial["weightsSha256"],
                    "networkArchitecture": ADAPTED_MAP,
                    "controller": "same-policy-self-play-both-teams",
                    "actionSampling": "deterministic-greedy-argmax",
                    "scriptedChoicesInThisGame": 0,
                    "recordScope": "full-training-scene-replay-v1"}
        client = ppo.ArenaClient(log_path=raw, log_snapshots=True)
        try:
            encoder = ppo.Encoder(client.schema)
            if initial["buildFingerprint"] != client.fingerprint:
                raise ValueError("演示环境与模型的训练规则指纹不一致")
            model = make_network(ADAPTED_MAP, encoder)
            model.load_state_dict(initial["modelState"])
            model.eval()
            with torch.inference_mode():
                result = ppo.play_episode(client, encoder, model, torch.device("cpu"),
                    "A", seed, 3000, trace="full", rng=random.Random(seed + 19),
                    card_set="events", record_metadata=metadata, deterministic=True)
        finally:
            client.close()
        if result["outcome"]["termination"] != "natural":
            raise RuntimeError("演示对局未自然结束，不输出不完整回放")
        digest = rounds.validate_record(raw, result["decisions"], seed)
        summary = {"recordType": "trainingSummary", "seed": seed,
                   "controller": "same-policy-self-play-both-teams",
                   "actionSampling": "deterministic-greedy-argmax",
                   "decisions": result["decisions"],
                   "countryTurns": result["countryTurns"],
                   "winner": result["outcome"]["winner"],
                   "allianceScores": result["outcome"]["allianceScores"],
                   "openingWhitePlan": result["openingWhitePlan"],
                   "whiteRecruit": result["whiteRecruit"],
                   "whiteFollowedArden": result["whiteFollowedArden"],
                   "sha256OfPriorLines": digest}
        with raw.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(summary, ensure_ascii=False, separators=(",", ":")) + "\n")
        subprocess.run(["node", "scripts/ppo-export-training-replay.mjs", str(raw),
                        str(replay)], cwd=ppo.ROOT, check=True)
        if not replay.is_file() or replay.stat().st_size == 0:
            raise RuntimeError("可导入回放导出为空")
        (stage / "对局摘要.json").write_text(json.dumps({"model": metadata,
            "summary": summary, "rawSha256": sha256(raw),
            "replaySha256": sha256(replay)}, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(stage, target)
    return target, summary


def main():
    parser = argparse.ArgumentParser(description="A1S2 latest accepted model: one demo game")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args()
    target, result = create_demo(args.seed, args.output_root)
    print(json.dumps({"directory": str(target), "summary": result}, ensure_ascii=False))


if __name__ == "__main__":
    main()
