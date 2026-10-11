"""Deterministic, independently rotating A2S1C4 course quotas.

The completed update number is the sampler cursor. Recomputing the short
prefix on resume avoids a second mutable state that could disagree with the
checkpoint, while each individual course identity has its own start cursor.
"""
from __future__ import annotations

from collections import Counter, defaultdict

VERSION = "combo-quota-20-9-3-6-2-v1"
PRIORITY = ("G1", "U4", "J1")
BUCKETS = (("positive", "preparation", 9),
           ("control", "preparation", 3),
           ("positive", "payoff", 6),
           ("control", "payoff", 2))


def _groups(entries: dict) -> dict:
    groups = defaultdict(list)
    for key, entry in entries.items():
        if entry.get("split") != "train":
            continue
        prefix = ":".join(key.split(":")[:3])
        if prefix != ":".join((entry["template"], entry["variant"], entry["layer"])):
            raise ValueError(f"Course key disagrees with metadata: {key}")
        groups[(entry["variant"], entry["layer"], entry["template"])].append(key)
    for keys in groups.values():
        keys.sort()
    return groups


def plan(entries: dict, update: int) -> dict:
    if update < 1:
        raise ValueError("Update index must start at one")
    groups = _groups(entries)
    missing = [f"{template}:{variant}:{layer}" for variant, layer, _ in BUCKETS
               for template in sorted({entry["template"] for entry in entries.values()})
               if (variant, layer, template) not in groups]
    for template in PRIORITY:
        if ("positive", "preparation", template) not in groups:
            raise ValueError(f"Required positive preparation pool is missing: {template}")
    visits = Counter()
    selected = []
    for number in range(1, update + 1):
        current = []
        for variant, layer, quota in BUCKETS:
            templates = sorted(template for v, l, template in groups if (v, l) == (variant, layer))
            if not templates:
                raise ValueError(f"Empty course quota: {variant}:{layer}")
            if (variant, layer) == ("positive", "preparation"):
                choices = [template for template in PRIORITY for _ in range(2)]
                others = [template for template in templates if template not in PRIORITY]
                if not others:
                    raise ValueError("No remaining preparation templates to rotate")
                choices += [others[((number - 1) * 3 + offset) % len(others)] for offset in range(3)]
            else:
                choices = [templates[((number - 1) * quota + offset) % len(templates)]
                           for offset in range(quota)]
            if len(choices) != quota:
                raise ValueError("Course quota and selection disagree")
            for template in choices:
                key = (variant, layer, template)
                starts = groups[key]
                current.append(starts[visits[key] % len(starts)])
                visits[key] += 1
        selected = current
    if len(selected) != 20:
        raise ValueError("Expected twenty course episodes")
    return {"version": VERSION, "update": update, "courseIds": selected,
            "plannedCounts": dict(Counter(":".join(key.split(":")[:3]) for key in selected)),
            "missingCombinations": missing,
            "cursor": {":".join(key): value for key, value in sorted(visits.items())}}


def outcome_summary(episodes: list[dict]) -> dict:
    """Keep normal and each curriculum stratum on distinct denominators."""
    groups = {}
    for episode in episodes:
        course_id = episode.get("courseId")
        template, variant, layer = course_id.split(":")[:3] if course_id else (None, None, None)
        group = "normal" if course_id is None else f"{variant}:{layer}"
        row = groups.setdefault(group, {"episodes": 0, "templates": {}})
        row["episodes"] += 1
        templates = (template,) if template else ("G1", "U4", "J1")
        for observed_template in templates:
            target = row["templates"].setdefault(observed_template, {"episodes": 0,
            "preparationOffers": 0, "autonomousPreparations": 0,
            "effectiveLinkedSettlements": 0, "courseTargetEpisodes": 0,
            "preparedThenEffectiveEpisodes": 0, "notPrepared": 0})
            target["episodes"] += 1
            card = {"G1": "special_136", "U4": "special_84",
                    "J1": "special_199"}.get(observed_template)
            if card:
                detail = (episode.get("comboDetail") or {}).get("cards", {}).get(card, {})
                target["preparationOffers"] += detail.get("legalPreparationChoices", 0)
                target["autonomousPreparations"] += detail.get("autonomousInstallations", 0)
                target["effectiveLinkedSettlements"] += detail.get("linkedEffectiveSettlements", 0)
                target["courseTargetEpisodes"] += bool(detail.get("courseTargetSettlements"))
                target["preparedThenEffectiveEpisodes"] += bool(
                    detail.get("autonomousPreparationToEffectiveUse"))
                target["notPrepared"] += detail.get("unrealizedReason") == "not_prepared"
    for row in groups.values():
        for target in row["templates"].values():
            count = target["preparationOffers"]
            target["preparationRate"] = target["autonomousPreparations"] / count if count else None
    return {"version": VERSION, "groups": groups}
