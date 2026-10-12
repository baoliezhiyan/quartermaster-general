"""Frozen v5 feature projection used only by the migrated opening gate.

Rows are copied from 21e3763, before the audited effect-scope corrections.
They are NOT the current rule description and cannot be used for legality,
rewards, or new semantic learning. The current v6 channel remains separate.
"""
from __future__ import annotations

import json
from pathlib import Path

ROWS = json.loads(Path(__file__).with_name(
    "ppo_legacy_potential_rows_v5.json").read_text(encoding="utf-8"))["rows"]


def vector(encoder, definition, potential):
    from scripts import ppo_train as ppo
    actions = [name for name in ppo.POTENTIAL_ACTIONS if name != "remove_supply_point"]
    targets = [name for name in ppo.POTENTIAL_TARGETS if name not in
               ("all_chinese_units", "new_enemy_army")]
    item = potential or {}
    row = ROWS.get(definition) if potential else None
    if item and not row:
        raise ValueError("Historical potential presence differs from v5 course")
    if row:
        raw_effects, raw_target, raw_fee, *tail = row
        defaults = ["none", "unknown", "unknown", "single", 0]
        defaults[:len(tail)] = tail
        limit, unit, alliance, branch, extra = defaults
        target_mode, _, region_list = raw_target.partition(":")
        fee_kind, *fee_parts = raw_fee.split(":", 2)
        fee_count = int(fee_parts[0]) if fee_parts else 0
        resources = fee_parts[1].split(",") if len(fee_parts) > 1 else []
        item = {"subscriptions": item.get("subscriptions") or [],
            "futureActions": raw_effects.split(","), "targetMode": target_mode,
            "targetRegions": region_list.split(",") if region_list else [],
            "feeKind": fee_kind, "feeCount": fee_count,
            "feeResourceActions": resources, "conditionalExtraFee": extra,
            "useLimit": limit, "unitConstraint": unit.split(","),
            "allianceConstraint": alliance, "branchMode": branch,
            "known": {"effects": True, "target": target_mode != "unknown",
                "fee": fee_kind != "unknown", "unit": unit != "unknown",
                "alliance": alliance != "unknown"},
            "potentialOnly": True}
    triggers = [entry.split(":", 1) for entry in item.get("subscriptions") or []]
    tags = [tag for _, tag in triggers]
    future = item.get("futureActions") or []
    if len(future) > 8 or any(name not in actions for name in future):
        raise ValueError("Historical potential action differs from v5")
    ordered = [number for name in future for number in ppo.onehot(name, actions)]
    ordered += [0.0] * ((8-len(future)) * len(actions))
    known = item.get("known") or {}
    unit = item.get("unitConstraint") or []
    result = ([float(any(side == name for side, _ in triggers))
               for name in ("Before", "After")] +
        [float("PHASE:" + name in tags) for name in ppo.PHASES] +
        [float("action:" + name in tags) for name in ppo.ACTIONS] +
        [float(name in tags) for name in ppo.POTENTIAL_MISC] + ordered +
        ppo.onehot(item.get("targetMode"), targets) +
        [float(region in (item.get("targetRegions") or [])) for region in encoder.regions] +
        ppo.onehot(item.get("feeKind"), ["none", "deck", "hand", "unknown"]) +
        [min(item.get("feeCount", 0), 10) / 10.0,
         min(item.get("conditionalExtraFee", 0), 10) / 10.0] +
        [float(action in (item.get("feeResourceActions") or [])) for action in ppo.ACTIONS] +
        ppo.onehot(item.get("useLimit"), ["turn", "round", "none", "unknown"]) +
        [float(name in unit) for name in ppo.UNIT_TYPES] +
        [float("unknown" in unit)] +
        ppo.onehot(item.get("allianceConstraint"),
                   ["owner", "ally", "enemy", "unknown"]) +
        ppo.onehot(item.get("branchMode"), ppo.POTENTIAL_BRANCHES) +
        [float(known.get(name, False)) for name in
         ("effects", "target", "fee", "unit", "alliance")] +
        [float(bool(item.get("potentialOnly"))), float(bool(row))])
    return result


def _definition(candidate):
    return candidate.get("definitionId") or (
        candidate["cardId"].split(":")[1] if candidate.get("cardId") else None)


def encoder_classes():
    """Keep v6's ordinary encoder unchanged for historical experiments."""
    from scripts import ppo_train as ppo

    class AuditedV5Encoder(ppo.Encoder):
        def encode_candidate(self, obs, candidate):
            self._historical_definition = _definition(candidate)
            return super().encode_candidate(obs, candidate)

        def _potential_vector(self, potential):
            return vector(self, getattr(self, "_historical_definition", None), potential)

    class HistoricalGateV7Encoder(ppo.Encoder):
        version = "ppo-vector-a2s1-v7-effect-scopes-historical-gate"

        def __init__(self, schema):
            super().__init__(schema)
            self.base_candidate_dim = self.historical_start

        def encode_candidate(self, obs, candidate):
            current = super().encode_candidate(obs, candidate)
            self.historical_start = len(current)
            projected = vector(self, _definition(candidate), candidate.get("potential"))
            return current + projected

    return AuditedV5Encoder, HistoricalGateV7Encoder
