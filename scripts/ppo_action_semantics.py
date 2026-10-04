"""Shared, visible rule facts for every training action entry point.

This layer describes the current decision. It never simulates a later effect or
guesses the outcome of a random cost. An unknown future target stays unknown.
"""
from __future__ import annotations


BUILD_ACTIONS = {"build_army", "build_navy", "recruit_army", "recruit_navy"}
ATTACK_ACTIONS = {"land_battle", "sea_battle", "destroy"}
MAX_ACTION_SLOTS = 8


def team(country):
    if country in ("germany", "italy", "japan"):
        return "axis"
    if country in ("united_kingdom", "soviet_union", "united_states", "france", "china"):
        return "allies"
    return None


def _flatten(effects):
    for effect in effects or ():
        if effect.get("kind") == "action":
            yield effect
        for branch in effect.get("children") or ():
            yield from _flatten(branch)


def action_facts(obs, candidate, regions, max_slots=MAX_ACTION_SLOTS):
    """Return ordered action facts without adding information unavailable to PPO."""
    known_regions = {r["id"]: r for r in regions}
    units = obs["units"]
    supplied = set(obs["suppliedUnitIds"])
    choices = candidate.get("choices") or ()
    explicit = [c for c in choices if c.get("action")]
    effects = list(_flatten(candidate.get("effects") or ()))
    # An action_plan is the selected basic/event option; the effect structure
    # still supplies its siblings and ordering, so only replace its first slot.
    actions = []
    for index, effect in enumerate(effects):
        chosen = explicit[index] if index < len(explicit) else {}
        actions.append((effect, chosen))
    if explicit and not effects:
        actions.extend(({}, c) for c in explicit)
    if candidate.get("kind") == "source" and not explicit and candidate.get("choices"):
        actions.extend(({}, c) for c in candidate["choices"] if c.get("action"))
    # The original ordered effect encoding retains the whole sequence (up to
    # its schema cap). This contextual block augments its first eight actions;
    # it must not reject a legal multi-effect candidate with more actions.
    if len(actions) > max_slots and obs.get("cardSet") == "signals":
        raise ValueError(f"A2S1 action sequence exceeds schema cap: {len(actions)} > {max_slots}")
    actions = actions[:max_slots]
    result = []
    for effect, chosen in actions:
        action = chosen.get("action") or effect.get("action")
        country = chosen.get("country") or effect.get("country")
        region_id = chosen.get("regionId") or effect.get("selectionRegion")
        fixed_regions = effect.get("regions") or ()
        if not region_id and len(fixed_regions) == 1:
            region_id = fixed_regions[0]
        if region_id is not None and region_id not in known_regions:
            raise ValueError(f"Unknown action region: {region_id}")
        unit_type = chosen.get("unitType")
        if not unit_type and action in BUILD_ACTIONS:
            unit_type = "army" if action.endswith("army") else "navy"
        occupants = [unit for unit in units if unit["regionId"] == region_id] if region_id else []
        same = [u for u in occupants if u["country"] == country]
        allied = [u for u in occupants if u["country"] != country and team(u["country"]) == team(country)]
        enemy = [u for u in occupants if team(u["country"]) != team(country)]
        duplicate = any(u["type"] == unit_type for u in same) if unit_type else False
        recycled = bool(chosen.get("source") and action in BUILD_ACTIONS and not duplicate)
        chosen_duplicate = chosen.get("repeated")
        if chosen_duplicate is not None and bool(chosen_duplicate) != duplicate:
            # Basic options already underwent the engine's legality check.
            # A disagreement is an encoding bug, not a feature to silently use.
            raise ValueError("Chosen placement repeat flag disagrees with visible units")
        if action in BUILD_ACTIONS and region_id:
            outcome = "repeated" if duplicate else "blocked" if enemy else "new"
        elif action in ATTACK_ACTIONS and region_id:
            outcome = "target" if enemy else "empty"
        else:
            outcome = "unknown"
        # Later effects may see a different board; only the chosen current
        # option can be asserted legal now. Fixed effects are current facts.
        result.append({"action": action, "country": country, "regionId": region_id,
                       "unitType": unit_type, "outcome": outcome,
                       "chosenLegal": bool(chosen), "recycled": recycled,
                       "same": len(same), "allied": len(allied), "enemy": len(enemy),
                       "suppliedHere": sum(u["id"] in supplied for u in occupants),
                       "supplyPoint": bool(known_regions[region_id]["supply"]) if region_id else None,
                       "homeCountry": known_regions[region_id].get("homeCountry") if region_id else None,
                       "futureTarget": region_id is None})
    return result


def opportunity_facts(candidate):
    effects = candidate.get("effects") or ()
    extra = sum(e.get("kind") == "extraPlay" for e in effects)
    # The frozen course has only verified this offset for special_150. The
    # extra card is a separate action and cannot rescue its parent recruitment.
    replacement = int(candidate.get("definitionId") == "special_150" and extra > 0)
    return {"extraPlayEffects": extra, "replacesSpentPlay": replacement,
            "trueExtraPlayKnown": candidate.get("definitionId") == "special_150"}
