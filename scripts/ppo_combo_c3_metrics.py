"""A2S1C3 read-only, source-linked preparation and settlement diagnostics.

These counters never enter observations, rewards, action selection or PPO samples.
Unknown causality is reported as unknown rather than inferred from the final map.
"""
from __future__ import annotations

from collections import Counter

CARDS = {"special_136": "G1", "special_84": "U4", "special_199": "J1"}
VERSION = "a2s1c3-combo-detail-v1"


def _linked(parent: dict, child: dict) -> bool:
    return (parent.get("epoch") == child.get("epoch") and
            parent.get("serial", -1) < child.get("serial", -1) and
            parent.get("eventId") is not None and
            (child.get("parentEventId") == parent["eventId"] or
             parent["eventId"] in (child.get("ancestorIds") or [])))


def _added(op: dict, country: str, kind: str, region: str | None = None) -> bool:
    return any(unit.get("country") == country and unit.get("type") == kind and
               (region is None or unit.get("regionId") == region)
               for unit in op.get("added", []))


def _removed_enemy(op: dict, country: str, region: str) -> bool:
    return any(unit.get("country") != country and unit.get("regionId") == region
               for unit in op.get("removed", []))


def _occupation(op: dict, country: str) -> bool | None:
    units = op.get("afterRegionUnits")
    if units is None:
        return None
    axis = {"germany", "italy", "japan"}
    friendly = axis if country in axis else None
    return (_added(op, country, "army", op.get("region")) and
            all(unit.get("country") in friendly if friendly is not None else
                unit.get("country") not in axis for unit in units))


def linked_settlements(operations: list[dict]) -> dict[str, list[dict]]:
    """Count actual effect-child pairs, never unrelated later board changes."""
    result = {card: [] for card in CARDS}
    seen: set[tuple[str, object, object]] = set()
    for parent in operations:
        for child in operations:
            if not _linked(parent, child):
                continue
            region = parent.get("region")
            card = child.get("source")
            if card == "special_136":
                valid = (parent.get("action") == "land_battle" and
                         _removed_enemy(parent, "germany", region) and
                         child.get("action") == "build_army" and
                         child.get("region") == region and
                         _added(child, "germany", "army", region))
                course = region == "ukraine" and _occupation(child, "germany") is True
            elif card == "special_84":
                valid = (parent.get("action") == "build_navy" and
                         _added(parent, "united_states", "navy", region) and
                         child.get("action") == "build_navy" and
                         child.get("region") != region and
                         _added(child, "united_states", "navy", child.get("region")))
                course = (parent.get("round") == 2 and
                          region == "sea_north_atlantic" and
                          child.get("region") == "sea_north_sea")
            elif card == "special_199":
                valid = (parent.get("action") == "land_battle" and
                         region == "eastern_china" and
                         any(unit.get("country") == "china" for unit in
                             parent.get("removed", [])) and
                         child.get("action") == "build_army" and
                         child.get("region") == "eastern_china" and
                         _added(child, "japan", "army", "eastern_china"))
                course = valid and _occupation(child, "japan") is True
            else:
                continue
            if not valid:
                continue
            identity = (card, child.get("epoch"), child.get("eventId") or
                        (child.get("serial"), child.get("decisionId")))
            if identity in seen:
                continue
            seen.add(identity)
            result[card].append({"parentEventId": parent.get("eventId"),
                "childEventId": child.get("eventId"), "round": child.get("round"),
                "region": child.get("region"), "courseTarget": bool(course),
                "decisionId": child.get("decisionId"),
                "effectiveAttack": parent.get("action") == "land_battle" and
                    bool(parent.get("removed")),
                "removedUnits": len(parent.get("removed", [])),
                "newUnits": len(child.get("added", [])),
                "occupationConfirmed": _occupation(child,
                    "japan" if card == "special_199" else "germany")
                    if card != "special_84" else None})
    return result


def summarize_detail(tracker: dict, task: dict, fee_cards_spent: int) -> dict:
    detail = tracker["_detail"]
    chains = linked_settlements(tracker["operations"])
    installed = [item for item in tracker["modelInstallations"]
                 if item.get("definitionId") in CARDS and
                 item.get("stage") == "post_takeover"]
    start = detail["installedAtTakeover"]
    cards = {}
    for card, template in CARDS.items():
        own_installs = [item for item in installed if item["definitionId"] == card]
        uses = chains[card]
        cancelled = [item for item in tracker["cancellations"]
                     if item.get("source") == card]
        opponent_countered = sum(any((item.get("epoch"), ancestor) in
            trigger.get("parents", []) for trigger in tracker["opponentTriggers"]
            for ancestor in [item.get("parentEventId"),
                             *(item.get("ancestorIds") or [])]) for item in cancelled)
        legal = detail["legalWindows"][card]
        activated = detail["activatedWindows"][card]
        declined = detail["declinedWindows"][card]
        installed_at_takeover = any(item["cardId"] == card for item in start)
        if uses:
            reason = None
        elif not own_installs and not installed_at_takeover:
            reason = "not_prepared"
        elif legal == 0:
            reason = "no_legal_trigger_observed_cause_unresolved"
        elif activated == 0 and declined:
            reason = "voluntary_decline"
        elif activated:
            reason = "activated_without_confirmed_linked_benefit"
        else:
            reason = "unresolved"
        cards[card] = {"template": template,
            "installedAtTakeover": installed_at_takeover,
            "autonomousInstallations": len(own_installs),
            "autonomousInstallationDecisions": [item["decisionId"] for item in own_installs],
            "installationEvents": [{"decisionId": item["decisionId"],
                "round": item["completedRound"], "seat": item.get("decisionSeat"),
                "source": item.get("actionSource", "unknown")}
                for item in own_installs],
            "firstPreparationRound": min((item["completedRound"] for item in own_installs),
                                         default=None),
            "sourceSelections": sum(item["cardId"] == card and not item["statusAction"]
                                    for item in detail["sourceChoices"]),
            "legalTriggerWindows": legal, "activatedWindows": activated,
            "declinedWindows": declined,
            "unresolvedWindows": max(0, legal - activated - declined),
            "activationRate": activated / legal if legal else None,
            "linkedEffectiveSettlements": len(uses),
            "effectiveAttacks": sum(item["effectiveAttack"] for item in uses),
            "removedUnits": sum(item["removedUnits"] for item in uses),
            "newUnits": sum(item["newUnits"] for item in uses),
            "confirmedOccupations": sum(item["occupationConfirmed"] is True
                                        for item in uses),
            "cancelledEffects": len(cancelled),
            "opponentCounterConfirmed": opponent_countered,
            "paidResourceCardsAttributed": detail["paidCards"][card],
            "unattributedFeeCardsInEpisode": detail["unattributedFeeCards"],
            "courseTargetSettlements": sum(item["courseTarget"] for item in uses),
            "autonomousPreparationToEffectiveUse": bool(own_installs and any(
                use["round"] >= item["completedRound"]
                for use in uses for item in own_installs)),
            "unrealizedReason": reason,
            "linkedEvents": uses}
    return {"version": VERSION, "startType": "normal" if not task.get("courseId")
            else "preparation" if ":preparation" in task["courseId"] else "payoff",
            "courseId": task.get("courseId"), "cards": cards,
            "totalFeeCardsSpent": fee_cards_spent,
            "paymentAttribution": "episode_total_only",
            "telemetryMissing": tracker["telemetryMissing"]}


def aggregate_detail(episodes: list[dict]) -> dict:
    result: dict[str, dict] = {}
    for episode in episodes:
        detail = episode["comboDetail"]
        group = detail["startType"]
        row = result.setdefault(group, {"episodes": 0, "cards": {}})
        row["episodes"] += 1
        for card, value in detail["cards"].items():
            target = row["cards"].setdefault(card, {"autonomousPreparations": 0,
                "autonomousPreparationEpisodes": 0, "legalTriggerWindows": 0,
                "activatedWindows": 0, "declinedWindows": 0,
                "linkedEffectiveSettlements": 0, "linkedEffectiveEpisodes": 0,
                "effectiveAttacks": 0, "removedUnits": 0, "newUnits": 0,
                "confirmedOccupations": 0, "cancelledEffects": 0,
                "opponentCounterConfirmed": 0, "paidResourceCardsAttributed": 0,
                "courseTargetSettlements": 0, "courseTargetEpisodes": 0,
                "preparedAndUsedEpisodes": 0, "installedAtTakeoverEpisodes": 0,
                "firstPreparationRounds": [], "unrealizedReasons": Counter()})
            target["autonomousPreparations"] += value["autonomousInstallations"]
            target["autonomousPreparationEpisodes"] += bool(value["autonomousInstallations"])
            target["legalTriggerWindows"] += value["legalTriggerWindows"]
            target["activatedWindows"] += value["activatedWindows"]
            target["declinedWindows"] += value["declinedWindows"]
            target["linkedEffectiveSettlements"] += value["linkedEffectiveSettlements"]
            for name in ("effectiveAttacks", "removedUnits", "newUnits",
                         "confirmedOccupations", "cancelledEffects",
                         "opponentCounterConfirmed", "paidResourceCardsAttributed"):
                target[name] += value[name]
            target["linkedEffectiveEpisodes"] += bool(value["linkedEffectiveSettlements"])
            target["courseTargetSettlements"] += value["courseTargetSettlements"]
            target["courseTargetEpisodes"] += bool(value["courseTargetSettlements"])
            target["preparedAndUsedEpisodes"] += value["autonomousPreparationToEffectiveUse"]
            target["installedAtTakeoverEpisodes"] += value["installedAtTakeover"]
            if value["firstPreparationRound"] is not None:
                target["firstPreparationRounds"].append(value["firstPreparationRound"])
            if value["unrealizedReason"]:
                target["unrealizedReasons"][value["unrealizedReason"]] += 1
    for row in result.values():
        for target in row["cards"].values():
            opportunities = target["legalTriggerWindows"]
            target["activationRate"] = (target["activatedWindows"] / opportunities
                                        if opportunities else None)
            target["unrealizedReasons"] = dict(target["unrealizedReasons"])
    return {"version": VERSION, "groups": result,
        "note": "Only source-linked settled effects count. Missing causes stay unresolved; "
                "course starts and normal games use separate denominators."}


def merge_update_summaries(summaries: list[dict]) -> dict:
    """Round-level totals preserve the three separate episode denominators."""
    combined: dict[str, dict] = {}
    numeric = ("autonomousPreparations", "autonomousPreparationEpisodes",
        "legalTriggerWindows", "activatedWindows", "declinedWindows",
        "linkedEffectiveSettlements", "linkedEffectiveEpisodes",
        "effectiveAttacks", "removedUnits", "newUnits", "confirmedOccupations",
        "cancelledEffects", "opponentCounterConfirmed", "paidResourceCardsAttributed",
        "courseTargetSettlements", "courseTargetEpisodes", "preparedAndUsedEpisodes",
        "installedAtTakeoverEpisodes")
    for summary in summaries:
        if summary.get("version") != VERSION:
            raise ValueError("Cannot combine reports with different C3 metrics versions")
        for group, row in summary["groups"].items():
            target_group = combined.setdefault(group, {"episodes": 0, "cards": {}})
            target_group["episodes"] += row["episodes"]
            for card, value in row["cards"].items():
                target = target_group["cards"].setdefault(card, {
                    **{key: 0 for key in numeric}, "firstPreparationRounds": [],
                    "unrealizedReasons": Counter()})
                for key in numeric:
                    target[key] += value[key]
                target["firstPreparationRounds"].extend(value["firstPreparationRounds"])
                target["unrealizedReasons"].update(value["unrealizedReasons"])
    for row in combined.values():
        for value in row["cards"].values():
            legal = value["legalTriggerWindows"]
            value["activationRate"] = value["activatedWindows"] / legal if legal else None
            value["unrealizedReasons"] = dict(value["unrealizedReasons"])
    return {"version": VERSION, "groups": combined,
            "updates": len(summaries)}
