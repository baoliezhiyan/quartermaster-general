"""Read-only A2S1C1 settlement diagnostics. Nothing here enters PPO rewards."""
from __future__ import annotations

from collections import Counter
import hashlib
import json
import os
from pathlib import Path

VERSION = "combo-report-v5-all-linked-starts-j1-occupation"
PREPARATION_SCHEMA_VERSION = "combo-preparation-v1"
LEGACY_PREPARATION_REPORT_VERSIONS = {"combo-report-v4-linked-settlement"}
CARD_TYPES = {"状态": "status", "响应": "response"}
CARD_IDS = {
    "G1": ("special_136",), "G2": ("special_136", "special_137"),
    "G3": ("special_134", "special_136"), "U1": ("special_111",),
    "U2": ("special_78", "special_88"), "U3": ("special_88",),
    "J1": ("special_199",), "J2": ("special_190", "special_189"),
    "U4": ("special_84",),
}


def new_tracker(course_id: str | None, start: dict, preparation: dict | None = None,
                *, detail: bool = False) -> dict:
    if course_id:
        template, variant, layer = course_id.split(":")[:3]
        state = start["state"]
        pre = preparation or {}
        first = pre.get("firstUSWestEuropeLanding")
        had_us_west = any(unit["country"] == "united_states" and
            unit["type"] == "army" and unit["regionId"] == "western_europe"
            for unit in state["units"])
        if first is None and had_us_west:
            first = {"source": "unresolved", "sourceCardId": None, "unitId": None,
                     "round": None, "decisionId": None}
        result = {"template": template, "variant": variant, "layer": layer,
                "startRound": state["round"], "preparationSeed": start["header"]["seed"],
                "preparationDecisions": start["decisionCount"],
                "preparationInstalls": pre.get("installations", []),
                "firstUSWestEuropeLanding": {**first, "stage": "pre_takeover"} if first else None,
                "takeoverHadUSWestArmy": had_us_west} | _mutable()
        if detail:
            result["_detail"] = _detail_start(state)
        return result
    result = {"template": None, "variant": None, "layer": None,
            "startRound": start["round"], "preparationSeed": start.get("seed"),
            "preparationDecisions": 0, "preparationInstalls": [],
            "firstUSWestEuropeLanding": None, "takeoverHadUSWestArmy": False} | _mutable()
    if detail:
        result["_detail"] = _detail_start(None)
    return result


def _detail_start(state: dict | None) -> dict:
    cards = {"special_136", "special_84", "special_199"}
    installed = []
    if state:
        for seat, deck in state["decks"].items():
            for zone in ("active", "faceDown"):
                installed.extend({"seat": seat, "cardId": card["definitionId"], "zone": zone}
                    for card in deck[zone] if card["definitionId"] in cards)
    return {"installedAtTakeover": installed, "seenWindows": set(),
            "legalWindows": Counter(), "activatedWindows": Counter(),
            "declinedWindows": Counter(), "windowDecisions": [],
            "sourceChoices": [], "paymentChoices": [], "paidCards": Counter(),
            "unattributedFeeCards": 0, "unavailableReasons": Counter()}


def _mutable() -> dict:
    return {"pendingInstall": {}, "modelInstallSelections": Counter(),
            "modelInstallations": [], "statusActions": Counter(),
            "triggerOpportunities": Counter(), "triggerSelections": Counter(),
            "triggerDeclines": Counter(), "opponentTriggers": [], "cancellations": [],
            "operations": [], "rawUnitAdds": Counter(), "rawUnitRemovals": Counter(),
            "postTakeoverFirstUSWestEuropeLanding": None,
            "pattonAttacksStarted": 0, "pattonAttacksEffective": 0,
            "pattonAttacksCountered": 0, "telemetryMissing": False}


def _selected_trigger(telemetry: dict) -> str | None:
    cards = {choice.get("definitionId") for choice in
             (telemetry.get("selected") or {}).get("choices") or []
             if choice.get("kind") == "trigger" and choice.get("definitionId")}
    return next(iter(cards)) if len(cards) == 1 else None


def _fallback_action(telemetry: dict, commit: dict) -> tuple[str | None, str | None]:
    """An action may finish as its resolution closes, losing its event history."""
    context = commit.get("context") or {}
    effect = context.get("effect") or {}
    selected = telemetry.get("selected") or {}
    selected_source = _selected_trigger(telemetry) or (
        selected.get("definitionId") if selected.get("kind") == "source" else None)
    if effect.get("kind") == "action" and effect.get("action"):
        return context.get("sourceDefinitionId") or selected_source, effect["action"]
    source = selected_source
    plans = [choice for choice in selected.get("choices") or []
             if choice.get("kind") == "action_plan" and choice.get("action")]
    if selected.get("kind") == "source" and len(plans) == 1:
        return source, plans[0]["action"]
    effects = [effect for choice in selected.get("choices") or []
               for effect in choice.get("effects") or [] if effect.get("kind") == "action"]
    if len(effects) == 1:
        return source, effects[0].get("action")
    return None, None


def _ops_for_commit(telemetry: dict, commit: dict) -> list[dict]:
    actions = [event for event in commit["events"] if event.get("kind") == "action"]
    if not actions and (commit["added"] or commit["removed"]):
        source, action = _fallback_action(telemetry, commit)
        context = commit.get("context") or {}
        if action:
            actions = [{"id": None, "frameId": context.get("frameId"),
                "parentEventId": context.get("parentEventId"),
                "ancestorIds": context.get("ancestorIds") or [],
                "sourceDefinitionId": source, "outcome": "observed_board_change",
                "action": action, "country": context.get("owner"),
                "regionId": None, "attackerId": None, "defenderId": None,
                "resultUnitId": None}]
    result = []
    for event in actions:
        added = [unit for unit in commit["added"] if unit["id"] == event.get("resultUnitId")]
        removed = [unit for unit in commit["removed"] if unit["id"] == event.get("defenderId")]
        # The engine can finish a single mandatory child and discard its
        # resolution history within one command. Match the one action's board
        # delta, but never distribute it across several sibling actions.
        if len(actions) == 1:
            added = added or commit["added"]
            removed = removed or commit["removed"]
        region = event.get("regionId") or (
            (added or removed)[0]["regionId"] if added or removed else None)
        result.append({"epoch": commit["epoch"], "serial": commit["serial"],
            "eventId": event.get("id"), "frameId": event.get("frameId"),
            "parentEventId": event.get("parentEventId"),
            "ancestorIds": event.get("ancestorIds") or [],
            "source": event.get("sourceDefinitionId"), "outcome": event.get("outcome"),
            "action": event.get("action"), "country": event.get("country") or commit["activeSeat"],
            "region": region, "attackerId": event.get("attackerId"),
            "defenderId": event.get("defenderId"),
            "addedIds": [unit["id"] for unit in added],
            "removedIds": [unit["id"] for unit in removed],
            "added": added, "removed": removed,
            "afterRegionUnits": (commit.get("afterRegionUnits") or {}).get(region),
            "round": commit["round"], "phase": commit["phase"],
            "activeSeat": commit["activeSeat"]})
    return result


def _landing_source(source: str | None) -> str:
    return {"build_army": "basic_build", "special_111": "patton",
            "special_88": "landing_operation"}.get(source,
            f"other:{source}" if source else "unresolved")


def record_step(tracker: dict, telemetry: dict | None, decision_id: int,
                *, preparation: bool = False, fee_cards_spent: int = 0) -> None:
    if not telemetry or telemetry.get("version") != "combo-settlement-v1":
        tracker["telemetryMissing"] = True
        return
    selected = telemetry.get("selected") or {}
    card_id = selected.get("cardId")
    card_type = CARD_TYPES.get(selected.get("cardType"))
    if (selected.get("kind") == "source" and card_type and not selected.get("statusAction")
            and (selected.get("fromZone") or {}).get("zone") == "hand"):
        tracker["pendingInstall"][card_id] = {"cardId": card_id,
            "definitionId": selected.get("definitionId"), "type": card_type,
            "decisionId": decision_id, "round": telemetry["round"],
            "decisionSeat": telemetry.get("decisionSeat"),
            "actionSource": "source_play_from_hand",
            "stage": "pre_takeover" if preparation else "post_takeover"}
        if not preparation:
            tracker["modelInstallSelections"][card_type] += 1
    elif selected.get("kind") == "source" and selected.get("statusAction"):
        tracker["statusActions"][selected.get("definitionId") or "unknown"] += 1
    offered = set(telemetry.get("offeredTriggers") or [])
    detail = tracker.get("_detail")
    if detail is not None and not preparation:
        from scripts.ppo_combo_c3_metrics import CARDS as detail_cards
        eligible = offered & set(detail_cards)
        selected_trigger = _selected_trigger(telemetry)
        for definition_id in eligible:
            key = (decision_id, definition_id)
            if key in detail["seenWindows"]:
                continue
            detail["seenWindows"].add(key)
            detail["legalWindows"][definition_id] += 1
            if selected_trigger == definition_id:
                detail["activatedWindows"][definition_id] += 1
                outcome = "activated"
            elif telemetry.get("choiceKind") == "TRIGGER" and not selected.get("choiceIds"):
                detail["declinedWindows"][definition_id] += 1
                outcome = "declined"
            else:
                outcome = "unresolved"
            detail["windowDecisions"].append({"decisionId": decision_id,
                "cardId": definition_id, "outcome": outcome,
                "round": telemetry.get("round"), "seat": telemetry.get("decisionSeat")})
        if selected.get("kind") == "source" and selected.get("definitionId") in detail_cards:
            detail["sourceChoices"].append({"decisionId": decision_id,
                "cardId": selected["definitionId"], "round": telemetry.get("round"),
                "seat": telemetry.get("decisionSeat"),
                "statusAction": bool(selected.get("statusAction"))})
        if telemetry.get("choiceKind") == "PAYMENT":
            detail["paymentChoices"].append({"decisionId": decision_id,
                "selected": bool(selected.get("choiceIds")),
                "round": telemetry.get("round")})
        if fee_cards_spent:
            sources = {source for source in (
                selected_trigger,
                *((commit.get("context") or {}).get("sourceDefinitionId")
                  for commit in telemetry["commits"])) if source in detail_cards}
            if len(sources) == 1:
                detail["paidCards"][next(iter(sources))] += fee_cards_spent
            else:
                detail["unattributedFeeCards"] += fee_cards_spent
    if not preparation:
        for card in offered & set(CARD_IDS.get(tracker["template"], ())):
            tracker["triggerOpportunities"][card] += 1
        chosen_trigger = _selected_trigger(telemetry)
        if chosen_trigger in CARD_IDS.get(tracker["template"], ()):
            tracker["triggerSelections"][chosen_trigger] += 1
        if telemetry.get("choiceKind") == "TRIGGER" and not selected.get("choiceIds"):
            for card in offered & set(CARD_IDS.get(tracker["template"], ())):
                tracker["triggerDeclines"][card] += 1
        if (telemetry.get("choiceKind") == "TRIGGER" and chosen_trigger and
                telemetry.get("decisionSeat") != telemetry.get("activeSeat")):
            tracker["opponentTriggers"].append({"cardId": chosen_trigger,
                "round": telemetry["round"], "activeSeat": telemetry["activeSeat"],
                "parents": [(commit["epoch"], event.get("parentEventId"))
                    for commit in telemetry["commits"] for event in commit["events"]
                    if event.get("sourceDefinitionId") == chosen_trigger]})
    for commit in telemetry["commits"]:
        tracker["cancellations"].extend({"epoch": commit["epoch"],
            "source": event.get("sourceDefinitionId"), "eventId": event.get("id"),
            "parentEventId": event.get("parentEventId"),
            "ancestorIds": event.get("ancestorIds") or [], "round": commit["round"]}
            for event in commit["events"] if event.get("outcome") == "cancelled")
        for installation in commit["installs"]:
            pending = tracker["pendingInstall"].get(installation["cardId"])
            if not pending or installation["zone"] != (
                    "active" if pending["type"] == "status" else "faceDown"):
                continue
            item = {**pending, "completedRound": commit["round"],
                    "zone": installation["zone"]}
            tracker["modelInstallations"].append(item)
            del tracker["pendingInstall"][installation["cardId"]]
        for unit in commit["added"]:
            tracker["rawUnitAdds"][f"{unit['country']}:{unit['type']}:{unit['regionId']}"] += 1
        for unit in commit["removed"]:
            tracker["rawUnitRemovals"][f"{unit['country']}:{unit['type']}:{unit['regionId']}"] += 1
        ops = _ops_for_commit(telemetry, commit)
        for op in ops:
            op["decisionId"] = decision_id
        tracker["operations"].extend(ops)
        for event in commit["events"]:
            if event.get("kind") != "remove" or not event.get("removedUnit"):
                continue
            unit = event["removedUnit"]
            for parent in reversed(tracker["operations"]):
                if (parent["epoch"] == commit["epoch"] and parent["eventId"] and
                        parent["eventId"] in event.get("ancestorIds", [])):
                    if unit["id"] not in parent["removedIds"]:
                        parent["removedIds"].append(unit["id"])
                        parent["removed"].append(unit)
                    break
        for unit in commit["added"]:
            if (unit["country"], unit["type"], unit["regionId"]) != (
                    "united_states", "army", "western_europe"):
                continue
            source = next((op["source"] for op in ops if unit["id"] in op["addedIds"]), None)
            landing = {"source": _landing_source(source), "sourceCardId": source,
                       "unitId": unit["id"], "round": commit["round"],
                       "decisionId": decision_id,
                       "stage": "pre_takeover" if preparation else "post_takeover"}
            if tracker["firstUSWestEuropeLanding"] is None:
                tracker["firstUSWestEuropeLanding"] = landing
            if not preparation and tracker["postTakeoverFirstUSWestEuropeLanding"] is None:
                tracker["postTakeoverFirstUSWestEuropeLanding"] = landing


def _linked(parent: dict, child: dict) -> bool:
    return (parent["serial"] < child["serial"] and parent["epoch"] == child["epoch"] and
            bool(parent["eventId"]) and (child["parentEventId"] == parent["eventId"] or
            parent["eventId"] in child["ancestorIds"]))


def _removed(op: dict, country: str, region: str) -> bool:
    return any(unit["country"] == country and unit["regionId"] == region
               for unit in op["removed"])


def _added(op: dict, country: str, region: str) -> bool:
    return any(unit["country"] == country and unit["regionId"] == region
               for unit in op["added"])


def _chain(tracker: dict) -> tuple[bool, int, int, str]:
    template = tracker["template"]
    if not template:
        return False, 0, 0, "not_a_course"
    ops = tracker["operations"]
    # Each row is a required, observed settlement action. The parent rule is
    # checked below rather than inferring a chain from whole-game board totals.
    patterns = {
        "G1": [("land_battle", "ukraine", "land_battle", "soviet_union", None),
               ("special_136", "ukraine", "build_army", None, "germany")],
        "G2": [("land_battle", "ukraine", "land_battle", "soviet_union", None),
               ("special_136", "ukraine", "build_army", None, "germany"),
               ("special_137", "moscow", "land_battle", "soviet_union", None)],
        "G3": [("land_battle", "western_europe", "land_battle", None, None),
               ("special_134", "western_europe", "land_battle", None, None),
               ("special_136", "western_europe", "build_army", None, "germany")],
        "U1": [("special_111", "western_europe", "build_army", None, "united_states"),
               ("special_111", None, "land_battle", None, None)],
        "U2": [("build_navy", "sea_east_pacific", "build_navy", None, "united_states"),
               ("special_78", "hawaii", "land_battle", "japan", None),
               ("special_88", "hawaii", "build_army", None, "united_states")],
        "U3": [("land_battle", "western_europe", "land_battle", None, None),
               ("special_88", "western_europe", "build_army", None, "united_states")],
        "J1": [("land_battle", "eastern_china", "land_battle", "china", None),
               ("special_199", "eastern_china", "build_army", None, "japan")],
        "J2": [("special_190", "eastern_china", "destroy", "china", None),
               ("special_189", "eastern_china", "recruit_army", None, "japan")],
        "U4": [("build_navy", "sea_north_atlantic", "build_navy", None, "united_states"),
               ("special_84", "sea_north_sea", "build_navy", None, "united_states")],
    }[template]
    # One representative path per end operation is enough: every later
    # condition depends on the immediate predecessor, not on the whole path.
    # This keeps matching polynomial in the number of settlement operations,
    # even when many attacks in one game fit the same first pattern.
    frontier: dict[int, list[dict]] = {}
    best: list[dict] = []
    for position, (source, region, action, removed_country, added_country) in enumerate(patterns):
        next_frontier: dict[int, list[dict]] = {}
        for index, op in enumerate(ops):
            if not (op["source"] == source and op["action"] == action and
                    (region is None or op["region"] == region) and
                    (not removed_country or _removed(op, removed_country, region)) and
                    (not added_country or _added(op, added_country, region))):
                continue
            if template == "G3" and position in (0, 1) and not any(
                    unit["country"] in ("united_kingdom", "united_states") and
                    unit["regionId"] == "western_europe" for unit in op["removed"]):
                continue
            if template in ("U1", "U3") and position == len(patterns) - 1 and action == "land_battle" and not op["removed"]:
                continue
            if template == "U3" and position == 0 and not op["removed"]:
                continue
            if position == 0:
                next_frontier[index] = [op]
                continue
            for path in frontier.values():
                parent = path[-1]
                if template == "G3" and position == 1:
                    previous_countries = {unit["country"] for unit in parent["removed"]}
                    if not any(unit["country"] not in previous_countries
                               for unit in op["removed"]):
                        continue
                if template == "U1":
                    related = (bool(parent["frameId"]) and
                        op["frameId"] == parent["frameId"] and
                        op["epoch"] == parent["epoch"] and
                        op["serial"] > parent["serial"])
                elif template == "J2":
                    related = (op["round"] == parent["round"] and
                        op["activeSeat"] == parent["activeSeat"] == "japan" and
                        op["phase"] == parent["phase"] == "PLAY" and
                        op["epoch"] == parent["epoch"] and
                        bool(parent["parentEventId"]) and
                        op["parentEventId"] == parent["parentEventId"] and
                        op["serial"] > parent["serial"])
                else:
                    related = _linked(parent, op)
                if related:
                    next_frontier[index] = [*path, op]
                    break
        if not next_frontier:
            break
        frontier = next_frontier
        # Operation order is chronological across epochs; serial may restart.
        best = frontier[max(frontier)]
    if len(best) == len(patterns):
        return True, len(best), len(patterns), "complete"
    if tracker["telemetryMissing"]:
        return False, len(best), len(patterns), "source_unresolved"
    relevant_cancel = any(cancel["epoch"] == op["epoch"] and
        (op["eventId"] == cancel["parentEventId"] or
         op["eventId"] in cancel["ancestorIds"]) for cancel in tracker["cancellations"]
        for op in best if op["eventId"])
    if relevant_cancel and any((cancel["epoch"], cancel["eventId"]) in trigger["parents"] or
        any((cancel["epoch"], ancestor) in trigger["parents"] for ancestor in
            cancel["ancestorIds"]) for trigger in tracker["opponentTriggers"]
        for cancel in tracker["cancellations"]):
        return False, len(best), len(patterns), "opponent_countered"
    if tracker["triggerDeclines"] and best:
        return False, len(best), len(patterns), "voluntary_decline_after_partial"
    if best:
        return False, len(best), len(patterns), "partial"
    if tracker["variant"] == "control":
        return False, 0, len(patterns), "control_conditions_or_decline"
    offered = sum(tracker["triggerOpportunities"].values())
    selected = sum(tracker["triggerSelections"].values())
    return False, 0, len(patterns), "voluntary_decline" if offered and not selected else "not_attempted"


def summarize(tracker: dict, outcome: dict, final_state: dict | None = None) -> dict:
    if tracker["template"] is None:
        return landing_summary(tracker)
    adds, removals = tracker["rawUnitAdds"], tracker["rawUnitRemovals"]
    template = tracker["template"]
    if template == "U1":
        attacks = [op for op in tracker["operations"] if op["source"] == "special_111"
                   and op["action"] == "land_battle"]
        tracker["pattonAttacksStarted"] = len(attacks)
        tracker["pattonAttacksEffective"] = sum(bool(op["removed"]) for op in attacks)
        tracker["pattonAttacksCountered"] = sum(op["outcome"] == "cancelled" for op in attacks)
    # Board result has no claim of card provenance and is deliberately kept
    # separate from the linked-settlement chain result.
    tactical = {
        "G1": bool(removals["soviet_union:army:ukraine"] and adds["germany:army:ukraine"]),
        "G2": bool(removals["soviet_union:army:ukraine"] and adds["germany:army:ukraine"]
                   and removals["soviet_union:army:moscow"]),
        "G3": bool(removals["united_kingdom:army:western_europe"] and
                   removals["united_states:army:western_europe"] and
                   adds["germany:army:western_europe"]),
        "U1": bool(adds["united_states:army:western_europe"] and
                   (removals["germany:army:germany"] or removals["italy:army:italy"])),
        "U2": bool(removals["japan:army:hawaii"] and adds["united_states:army:hawaii"]),
        "U3": bool(adds["united_states:army:western_europe"]),
        "J1": bool(removals["china:army:eastern_china"] and
                   adds["japan:army:eastern_china"]),
        "J2": bool(removals["china:army:eastern_china"] and
                   adds["japan:army:eastern_china"]),
        "U4": bool(adds["united_states:navy:sea_north_atlantic"] and
                   adds["united_states:navy:sea_north_sea"]),
    }[template]
    complete, matched, required, status = _chain(tracker)
    if tactical and not complete and any(op["source"] is None for op in
        tracker["operations"] if op["action"] in ("build_army", "land_battle")):
        status = "source_unresolved"
    scores = outcome["allianceScores"]
    result = {key: value for key, value in tracker.items() if key not in
              ("pendingInstall", "operations", "rawUnitAdds", "rawUnitRemovals",
               "cancellations", "opponentTriggers", "_detail")}
    for key in ("modelInstallSelections", "statusActions", "triggerOpportunities",
                "triggerSelections", "triggerDeclines"):
        result[key] = dict(tracker[key])
    result.update({"metricsVersion": VERSION, "tacticalResultAchieved": tactical,
        "specifiedComboAchieved": complete, "comboMatchedSteps": matched,
        "comboRequiredSteps": required, "comboStatus": status,
        "firstUSWestEuropeLanding": tracker["firstUSWestEuropeLanding"],
        "postTakeoverFirstUSWestEuropeLanding": tracker["postTakeoverFirstUSWestEuropeLanding"],
        "usNeverLandedWestEurope": tracker["firstUSWestEuropeLanding"] is None,
        "winner": outcome["winner"],
        "scoreDifferenceAxisMinusAllies": scores["axis"] - scores["allies"]})
    if final_state is not None:
        result["finalUnitsInRelevantRegions"] = [unit for unit in final_state["units"]
            if unit["regionId"] in {"western_europe", "ukraine", "moscow", "hawaii",
                                    "eastern_china"}]
    return result


def landing_summary(tracker: dict) -> dict:
    first = tracker["firstUSWestEuropeLanding"]
    return {"metricsVersion": VERSION, "firstUSWestEuropeLanding": first,
            "postTakeoverFirstUSWestEuropeLanding": tracker["postTakeoverFirstUSWestEuropeLanding"],
            "usNeverLandedWestEurope": first is None,
            "source": first["source"] if first else "never_landed"}


def aggregate(episodes: list[dict], *, group_by_template: bool = False) -> dict:
    normal = [item for item in episodes if item["startType"] == "normal"]
    course = [item for item in episodes if item["startType"] == "course"]
    def landings(items):
        counts = Counter(item["landing"]["source"] for item in items)
        return {"episodes": len(items), "firstLandingSources": dict(counts),
                "preTakeoverLandings": sum((item["landing"]["firstUSWestEuropeLanding"] or {})
                    .get("stage") == "pre_takeover" for item in items)}
    by_template: dict[str, dict] = {}
    for item in course:
        summary = item["comboCourse"]
        row = by_template.setdefault(summary["template"] if group_by_template else
                                     item["courseId"], {"episodes": 0,
            "boardResults": 0, "specifiedCombos": 0,
            "comboStatuses": Counter(), "installSelections": Counter(),
            "installations": Counter(), "preparationInstallations": Counter(),
            "triggerOpportunities": Counter(),
            "triggerSelections": Counter(), "pattonAttacksStarted": 0,
            "pattonAttacksEffective": 0, "pattonAttacksCountered": 0,
            "winners": Counter(), "scoreDifferences": [], "decisions": 0,
            "startRounds": [], "preparationDecisions": [],
            "feeCardsSpent": 0, "wastePenaltyTotal": 0.0,
            "wastePenaltyByCard": Counter()})
        row["episodes"] += 1
        row["decisions"] += item["decisions"]
        row["startRounds"].append(summary["startRound"])
        row["preparationDecisions"].append(summary["preparationDecisions"])
        row["feeCardsSpent"] += item.get("feeCardsSpent", 0)
        row["wastePenaltyTotal"] += item.get("wastePenaltyTotal", 0.0)
        row["wastePenaltyByCard"].update(item.get("wastePenaltiesByCard", {}))
        row["boardResults"] += int(summary["tacticalResultAchieved"])
        row["specifiedCombos"] += int(summary["specifiedComboAchieved"])
        row["comboStatuses"][summary["comboStatus"]] += 1
        row["installSelections"].update(summary["modelInstallSelections"])
        row["installations"].update(installation["type"] for installation in
                                    summary["modelInstallations"])
        row["preparationInstallations"].update(installation["type"] for installation in
                                               summary["preparationInstalls"])
        row["triggerOpportunities"].update(summary["triggerOpportunities"])
        row["triggerSelections"].update(summary["triggerSelections"])
        for metric in ("pattonAttacksStarted", "pattonAttacksEffective", "pattonAttacksCountered"):
            row[metric] += summary[metric]
        row["winners"][summary["winner"]] += 1
        row["scoreDifferences"].append(summary["scoreDifferenceAxisMinusAllies"])
    for row in by_template.values():
        for key in ("comboStatuses", "installSelections", "installations",
                    "preparationInstallations",
                    "triggerOpportunities", "triggerSelections", "winners",
                    "wastePenaltyByCard"):
            row[key] = dict(row[key])
    normal_result = landings(normal)
    normal_result.update({"decisions": sum(item["decisions"] for item in normal),
        "axisWins": sum(item["winner"] == "axis" for item in normal),
        "alliesWins": sum(item["winner"] == "allies" for item in normal)})
    return {"metricsVersion": VERSION, "normal": normal_result,
            "course": {"landing": landings(course), "templates": by_template},
            "sampleWeighting": "Existing equal weight per post-takeover valid decision; no telemetry enters reward."}


def preparation_metadata(pool_path: Path, entries: list[dict], client,
                         cache_path: Path | None = None) -> dict:
    """Replay the existing legal-action pool once; never alter its snapshots."""
    cache_path = cache_path or pool_path.with_name("course-telemetry-v3.json")
    identity = {"cacheSchemaVersion": PREPARATION_SCHEMA_VERSION, "poolSha256": hashlib.sha256(
        pool_path.read_bytes()).hexdigest(), "buildFingerprint": client.fingerprint}
    expected_keys = {entry.get("courseId") or ":".join(entry[key] for key in
                     ("template", "variant", "layer"))
                     for entry in entries}
    if cache_path.exists():
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        previous = cached.get("identity") or {}
        same_source = all(previous.get(key) == identity[key] for key in
                          ("poolSha256", "buildFingerprint"))
        known_schema = (previous.get("cacheSchemaVersion") == PREPARATION_SCHEMA_VERSION or
                        previous.get("metricsVersion") in LEGACY_PREPARATION_REPORT_VERSIONS)
        cached_entries = cached.get("entries") or {}
        complete = (set(cached_entries) == expected_keys and all(
            isinstance(item, dict) and isinstance(item.get("installations"), list) and
            "firstUSWestEuropeLanding" in item and isinstance(item.get("decisionCount"), int)
            for item in cached_entries.values()))
        if same_source and known_schema and complete:
            return cached["entries"]
        raise ValueError("Existing preparation telemetry belongs to a different pool or schema")
    result = {}
    for entry in entries:
        course_id = entry.get("courseId") or ":".join(entry[key] for key in
            ("template", "variant", "layer"))
        response = client.request(op="reset", seed=entry["seed"], mode="A",
                                  cardSet="signals", comboTelemetry=True)
        observation = response["observation"]
        tracker = new_tracker(None, observation)
        for item in entry["trace"]:
            if item["actionId"] not in {candidate["id"] for candidate in
                                        observation["candidates"]}:
                raise ValueError(f"Preparation replay has an illegal action: {course_id}")
            response = client.request(op="step", action={**observation["decision"],
                                      "actionId": item["actionId"]}, comboTelemetry=True)
            record_step(tracker, response.get("comboTelemetry"),
                        observation["decision"]["decisionId"], preparation=True)
            observation = response["observation"]
        actual = client.request(op="snapshot")["snapshot"]
        if actual["state"] != entry["snapshot"]["state"]:
            raise ValueError(f"Preparation telemetry replay changed scene: {course_id}")
        result[course_id] = {"installations": tracker["modelInstallations"],
            "firstUSWestEuropeLanding": tracker["firstUSWestEuropeLanding"],
            "decisionCount": len(entry["trace"])}
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache_path.with_suffix(".tmp")
    try:
        temporary.write_text(json.dumps({"identity": identity, "entries": result},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, cache_path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return result
