"""Audit a partial C2 pool without treating it as training-ready."""
from __future__ import annotations

import gzip
import json
from collections import Counter
import torch

from scripts import ppo_combo_bc as bc
from scripts import ppo_combo_v2_prepare as prepare
from scripts import ppo_train as ppo


def main():
    torch.set_num_threads(2)
    with gzip.open(prepare.POOL, "rt", encoding="utf-8") as stream:
        pool = json.load(stream)
    client = ppo.ArenaClient(card_set="signals")
    try:
        encoder = ppo.Encoder(client.schema)
        _, model = prepare.verify_parent(prepare.PARENT, client, encoder)
        labels, controls, evidence = bc.extract(client, encoder, model, pool["entries"])
        counts = Counter((row["metadata"]["courseId"].split(":", 1)[0],
                          row["metadata"]["cardId"]) for row in labels)
        summary = {"poolComplete": pool["complete"],
            "poolVersion": pool["identity"]["version"],
            "trainingLabels": {template: {"target": target,
                "count": counts[(template, target)]} for template, target in
                bc.TEACHING_TARGETS.items()},
            "retentionScenes": len(controls), "evidence": evidence}
        output = prepare.ROOT / "partial-evidence-v8.json"
        if output.exists():
            raise FileExistsError(output)
        output.write_text(json.dumps(summary, ensure_ascii=False, indent=2),
                          encoding="utf-8")
        print(json.dumps({"poolComplete": summary["poolComplete"],
            "trainingLabels": summary["trainingLabels"],
            "retentionScenes": len(controls), "report": str(output)},
            ensure_ascii=False))
    finally:
        client.close()


if __name__ == "__main__":
    main()
