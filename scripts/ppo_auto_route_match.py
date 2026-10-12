"""Fail-closed semantic matching of engine-authorized PPO candidates.

The arena determines legality. This module only asks whether a *currently
legal* candidate has the same intent as an archived action. Never use labels,
array positions, or unstable unit/card/window instance numbers as identity.
"""
from __future__ import annotations

from scripts.ppo_auto_archive import digest


class UnknownIntent(ValueError):
    pass


CHOICE_KEYS = {"kind", "action", "nextAction", "country", "regionId", "unitType",
    "source", "target", "definitionId", "repeated", "intercept", "effects"}
EFFECT_KEYS = {"kind", "action", "country", "seat", "fee", "optional", "min",
    "max", "count", "amount", "regions", "targetIds", "targetFacts",
    "bindAs", "fromBinding", "selectedIds", "selectedFacts", "selectionRegion",
    "precommitTargets", "filter", "from", "to", "tag", "newOnly", "children"}
CANDIDATE_KEYS = {"id", "kind", "label", "cardId", "definitionId", "cardType",
    "optionId", "statusAction", "randomDiscardCount", "choiceIds", "targetIds",
    "effects", "potential", "choices"}
CHOICE_KINDS = {"action_plan", "build_order", "action_region", "defenderId",
    "attackerId", "empty_defender", "effect_choice", "extra_card", "reallocate",
    "cards", "force_hand", "pay_cost", "region_target", "country_target",
    "unit_target", "relocate", "trigger", "order_mandatory_triggers",
    "accept", "decline", "execute"}
CANDIDATE_KINDS = {"source", "pass", "choice", "targets"}


def _unit_fact(value, observation=None):
    if value is None:
        return None
    if not isinstance(value, dict) or not all(value.get(key) for key in
            ("country", "type", "regionId")):
        raise UnknownIntent("unit semantic identity unavailable")
    fact = {key: value[key] for key in ("country", "type", "regionId")}
    if observation is not None and sum(all(unit.get(key) == fact[key] for key in fact)
            for unit in observation.get("units", ())) > 1:
        raise UnknownIntent("unit semantic identity is not unique")
    return fact


def _targets(ids, facts, observation):
    facts = facts or []
    if facts and len(facts) == len(ids):
        result = [_unit_fact(fact, observation) for fact in facts]
        if len({digest(fact) for fact in result}) != len(result):
            raise UnknownIntent("several selected units have identical semantic identity")
        return result
    units = {unit["id"]: unit for unit in observation.get("units", ())}
    result = []
    for identifier in ids:
        if identifier in units:
            result.append(_unit_fact(units[identifier], observation))
        else:
            raise UnknownIntent("target instance lacks visible semantic identity")
    if len({digest(fact) for fact in result}) != len(result):
        raise UnknownIntent("several selected units have identical semantic identity")
    return result


def _effect(item, observation):
    if not isinstance(item, dict) or set(item) - EFFECT_KEYS:
        raise UnknownIntent("unsupported effect field")
    normalized = {key: item[key] for key in ("kind", "action", "country", "seat",
        "fee", "optional", "min", "max", "count", "amount", "regions",
        "bindAs", "fromBinding", "selectionRegion", "precommitTargets",
        "filter", "from", "to", "tag", "newOnly") if key in item}
    normalized["targetFacts"] = _targets(item.get("targetIds", ()),
        item.get("targetFacts"), observation)
    normalized["selectedFacts"] = _targets(item.get("selectedIds", ()),
        item.get("selectedFacts"), observation)
    normalized["children"] = [[_effect(child, observation) for child in branch]
        for branch in item.get("children", ())]
    return normalized


def _choice(item, observation):
    if not isinstance(item, dict) or set(item) - CHOICE_KEYS or \
            item.get("kind") not in CHOICE_KINDS:
        raise UnknownIntent("unsupported choice kind or field")
    normalized = {key: item[key] for key in ("kind", "action", "nextAction", "country",
        "regionId", "unitType", "definitionId", "repeated", "intercept") if key in item}
    normalized["source"] = _unit_fact(item.get("source"), observation)
    normalized["target"] = _unit_fact(item.get("target"), observation)
    normalized["effects"] = [_effect(child, observation)
        for child in item.get("effects", ())]
    return normalized


def route_action_signature(candidate, observation):
    if not isinstance(candidate, dict) or set(candidate) - CANDIDATE_KEYS or \
            candidate.get("kind") not in CANDIDATE_KINDS:
        raise UnknownIntent("unsupported candidate kind or field")
    choices = candidate.get("choices") or []
    if candidate.get("kind") == "choice" and candidate.get("choiceIds") and \
            len(choices) != len(candidate["choiceIds"]):
        raise UnknownIntent("choice lacks a semantic fact for a selected option")
    if candidate.get("kind") == "source" and candidate.get("definitionId") is None:
        raise UnknownIntent("source card definition missing")
    return digest({"kind": candidate["kind"],
        "definitionId": candidate.get("definitionId"),
        "statusAction": candidate.get("statusAction"),
        "randomDiscardCount": candidate.get("randomDiscardCount"),
        "choices": [_choice(choice, observation) for choice in choices],
        "targets": _targets(candidate.get("targetIds") or [], [], observation),
        "effects": [_effect(effect, observation)
                    for effect in candidate.get("effects") or []],
        "potential": candidate.get("potential")})


def route_context(observation):
    """Round and causal source accompany the node; decision IDs may shift."""
    return digest({key: observation.get(key) for key in (
        "round", "activeSeat", "decisionSeat", "node", "phase", "choiceKind",
        "choiceField", "choiceMin", "choiceMax", "sourceSeat", "unitCountry",
        "currentSourceDefinition", "currentEffectIndex", "originAction",
        "selectedTargetFacts", "bindingFacts")})


def match_recorded_action(recorded, observation):
    before = recorded.get("observation") or {}
    if route_context(before) != route_context(observation):
        return None, "decision_context_changed"
    original = [item for item in before.get("candidates", ())
                if item.get("id") == recorded.get("actionId")]
    if len(original) != 1 or digest(before.get("candidates", ())) != \
            recorded.get("candidateHash"):
        return None, "recorded_action_or_candidates_invalid"
    try:
        wanted = route_action_signature(original[0], before)
        if sum(route_action_signature(item, before) == wanted
               for item in before.get("candidates", ())) != 1:
            return None, "recorded_action_semantically_ambiguous"
        matches = [index for index, item in enumerate(observation.get("candidates", ()))
                   if route_action_signature(item, observation) == wanted]
    except UnknownIntent:
        return None, "unsupported_or_incomplete_action_intent"
    if len(matches) == 1:
        return matches[0], None
    return None, "ambiguous_equivalent_action" if matches else \
        "required_action_illegal_or_missing"


def route_plan_with_ordinals(path, labels):
    """Count every original same-context window, including unlabelled ones."""
    occurrences = {}
    numbered = {}
    for step in path:
        context = route_context(step["observation"])
        occurrences[context] = occurrences.get(context, 0) + 1
        numbered[(step["decisionId"], step["actionId"])] = occurrences[context]
    result = []
    for label in labels:
        key = label["decisionId"], label["actionId"]
        if key in numbered:
            result.append({**label, "_routeOrdinal": numbered[key]})
    return result


def route_window_status(expected, current, seen_contexts):
    """A later lookalike window cannot replace a missed causal node."""
    prior = expected["observation"]
    context = route_context(current)
    wanted = route_context(prior)
    ordinal = expected.get("_routeOrdinal", 1)
    if current.get("round", 0) > prior.get("round", 0):
        return "expected_round_expired"
    if current.get("round") == prior.get("round") and \
            prior.get("node") != "SOURCE" and current.get("node") == "SOURCE" and \
            current.get("decisionSeat") == prior.get("decisionSeat"):
        return "expected_parent_resolution_closed"
    if context == wanted and seen_contexts[context] > ordinal:
        return "expected_window_ordinal_missed"
    return "match" if context == wanted and seen_contexts[context] == ordinal else "wait"
