"""Course diagnostics from post-takeover observations, never reward shaping."""
from __future__ import annotations

from collections import Counter

CARD_IDS = {
    "G1": ("special_136",), "G2": ("special_136", "special_137"),
    "G3": ("special_134", "special_136"), "U1": ("special_111",),
    "U2": ("special_78", "special_88"), "U3": ("special_88",),
    "J1": ("special_199",), "J2": ("special_190", "special_189"),
}
REGIONS = {
    "G1": ("eastern_europe", "ukraine"),
    "G2": ("eastern_europe", "ukraine", "moscow"),
    "G3": ("western_europe",),
    "U1": ("western_europe", "germany", "italy"),
    "U2": ("sea_east_pacific", "hawaii"),
    "U3": ("sea_north_sea", "western_europe"),
    "J1": ("sea_east_china", "eastern_china"),
    "J2": ("eastern_china",),
}


def new_tracker(course_id: str, snapshot: dict) -> dict:
    template, variant, layer = course_id.split(":")
    state = snapshot["state"]
    return {"template": template, "variant": variant, "layer": layer,
            "startRound": state["round"], "preparationDecisions": snapshot["decisionCount"],
            "preparationSeed": snapshot["header"]["seed"],
            "preparationZonesBySeat": {seat: {
                zone: len(deck[zone]) for zone in ("discardPile", "active", "faceDown", "removed")}
                for seat, deck in state["decks"].items()},
            "cards": CARD_IDS[template], "sourceSelections": Counter(),
            "installSelections": Counter(), "triggerSelections": Counter(),
            "installRounds": [], "opponentInterventions": Counter(),
            "placements": Counter(), "removals": Counter(), "attacks": Counter(),
            "westEuropeLandingSources": Counter(), "westEuropeSourceUnresolved": 0,
            "pattonFollowupBattles": 0, "navyAtStart": any(u["country"] == "united_states"
                and u["type"] == "navy" and u["regionId"] == "sea_north_sea"
                for u in state["units"])}


def record_selection(tracker: dict, observation: dict, chosen: dict) -> None:
    card = chosen.get("definitionId")
    if chosen["kind"] == "source" and card in tracker["cards"]:
        tracker["sourceSelections"][card] += 1
        if observation["node"] == "SOURCE" and chosen.get("cardType") in ("status", "response"):
            tracker["installSelections"][card] += 1
            tracker["installRounds"].append({"cardId": card, "round": observation["round"]})
    if observation.get("choiceKind") == "TRIGGER" and chosen.get("choiceIds"):
        for feature in chosen.get("choices") or ():
            card = feature.get("definitionId")
            if feature.get("kind") == "trigger" and card in tracker["cards"]:
                tracker["triggerSelections"][card] += 1
            if feature.get("kind") == "trigger" and feature.get("country") != observation["activeSeat"]:
                origin = observation.get("originAction") or {}
                if origin.get("regionId") in REGIONS[tracker["template"]]:
                    tracker["opponentInterventions"][card or "unknown"] += 1


def record_step(tracker: dict, before: dict, chosen: dict, after: dict | None,
                full_record: dict | None) -> None:
    """Use stable unit IDs; classify source only when a frame/source identifies it."""
    if not after:
        after = (full_record or {}).get("after")
    if not after:
        return
    old = {unit["id"]: unit for unit in before["units"]}
    new = {unit["id"]: unit for unit in after["units"]}
    source = before.get("currentSourceDefinition")
    if before["node"] == "SOURCE" and chosen["kind"] == "source":
        source = chosen.get("definitionId")
    if not source and before.get("choiceKind") == "TRIGGER" and chosen.get("choiceIds"):
        triggered = {feature.get("definitionId") for feature in chosen.get("choices") or ()
                     if feature.get("kind") == "trigger" and feature.get("definitionId")}
        if len(triggered) == 1:
            source = next(iter(triggered))
    for unit_id, unit in new.items():
        if unit_id not in old:
            key = f"{unit['country']}:{unit['type']}:{unit['regionId']}"
            tracker["placements"][key] += 1
            if key == "united_states:army:western_europe":
                mapping = {"build_army": "basic_build", "special_111": "patton",
                           "special_88": "landing_operation"}
                if source in mapping:
                    tracker["westEuropeLandingSources"][mapping[source]] += 1
                elif source:
                    tracker["westEuropeLandingSources"][f"other:{source}"] += 1
                else:
                    tracker["westEuropeSourceUnresolved"] += 1
    for unit_id, unit in old.items():
        if unit_id not in new:
            tracker["removals"][f"{unit['country']}:{unit['type']}:{unit['regionId']}"] += 1
            if source == "special_111" and unit["regionId"] in ("germany", "italy") and (
                    unit["country"] in ("germany", "italy")):
                tracker["pattonFollowupBattles"] += 1
    for event in (full_record or {}).get("events") or ():
        if event.get("type") == "TRAINING_BOARD_APPLIED" and event.get("action") in (
                "land_battle", "sea_battle"):
            tracker["attacks"][f"{event['country']}:{event['regionId']}"] += 1
            if source == "special_111" and event["country"] == "united_states":
                tracker["pattonFollowupBattles"] += 1


def summarize(tracker: dict, outcome: dict, final_state: dict | None = None) -> dict:
    placed, removed = tracker["placements"], tracker["removals"]
    template = tracker["template"]
    tactical = {
        "G1": bool(removed["soviet_union:army:ukraine"] and placed["germany:army:ukraine"]),
        "G2": bool(removed["soviet_union:army:ukraine"] and placed["germany:army:ukraine"]
                   and removed["soviet_union:army:moscow"]),
        "G3": bool(removed["united_kingdom:army:western_europe"] and
                   removed["united_states:army:western_europe"] and
                   placed["germany:army:western_europe"]),
        "U1": bool(tracker["westEuropeLandingSources"]["patton"] and
                   tracker["pattonFollowupBattles"]),
        "U2": bool(removed["japan:army:hawaii"] and placed["united_states:army:hawaii"]),
        "U3": bool(placed["united_states:army:western_europe"] and
                   tracker["westEuropeLandingSources"]["landing_operation"]),
        "J1": bool(removed["china:army:eastern_china"] and
                   placed["japan:army:eastern_china"]),
        "J2": bool(removed["china:army:eastern_china"] and
                   placed["japan:army:eastern_china"]),
    }[template]
    scores = outcome["allianceScores"]
    result = {key: value for key, value in tracker.items() if key not in ("cards",)}
    for key in ("sourceSelections", "installSelections", "triggerSelections", "placements",
                "removals", "attacks", "westEuropeLandingSources"):
        result[key] = dict(tracker[key])
    result["tacticalResultAchieved"] = tactical
    result["winner"] = outcome["winner"]
    result["scoreDifferenceAxisMinusAllies"] = scores["axis"] - scores["allies"]
    result["usNeverLandedWestEurope"] = (template == "U1" and
                                         not sum(tracker["westEuropeLandingSources"].values()) and
                                         tracker["westEuropeSourceUnresolved"] == 0)
    result["opponentInterventions"] = dict(tracker["opponentInterventions"])
    result["failedWithObservedOpponentIntervention"] = (not tactical and
                                                         bool(tracker["opponentInterventions"]))
    if final_state is not None:
        result["finalUnitsInRelevantRegions"] = [
            {"country": unit["country"], "type": unit["type"], "regionId": unit["regionId"]}
            for unit in final_state["units"] if unit["regionId"] in REGIONS[template]]
    return result


def aggregate(episodes: list[dict]) -> dict:
    """Separate normal-start outcomes from course-start diagnostics."""
    normal = [item for item in episodes if item["startType"] == "normal"]
    courses: dict[str, dict] = {}
    for episode in episodes:
        course = episode.get("comboCourse")
        if course is None:
            continue
        key = episode["courseId"]
        row = courses.setdefault(key, {"episodes": 0, "decisions": 0,
            "tacticalResults": 0, "axisWins": 0, "alliesWins": 0,
            "scoreDifferenceAxisMinusAllies": [], "starts": [],
            "triggerOpportunities": Counter(), "triggerActivations": Counter(),
            "sourceSelections": Counter(), "installationSelections": Counter(),
            "placements": Counter(), "removals": Counter(),
            "westEuropeLandingSources": Counter(), "unresolvedLandingSources": 0,
            "observedOpponentInterventions": Counter(),
            "failedWithObservedOpponentIntervention": 0,
            "feeCardsSpent": 0, "wastePenaltyTotal": 0.0,
            "wastePenaltyByCard": Counter()})
        row["episodes"] += 1
        row["decisions"] += episode["decisions"]
        row["tacticalResults"] += int(course["tacticalResultAchieved"])
        row["axisWins"] += int(episode["winner"] == "axis")
        row["alliesWins"] += int(episode["winner"] == "allies")
        row["scoreDifferenceAxisMinusAllies"].append(course["scoreDifferenceAxisMinusAllies"])
        row["starts"].append({"round": course["startRound"],
                              "preparationDecisions": course["preparationDecisions"],
                              "preparationSeed": course["preparationSeed"],
                              "preparationZonesBySeat": course["preparationZonesBySeat"]})
        for destination, source in (("triggerOpportunities", episode["triggerOpportunities"]),
                                    ("triggerActivations", episode["triggerActivations"]),
                                    ("sourceSelections", course["sourceSelections"]),
                                    ("installationSelections", course["installSelections"]),
                                    ("placements", course["placements"]),
                                    ("removals", course["removals"]),
                                    ("westEuropeLandingSources", course["westEuropeLandingSources"]),
                                    ("wastePenaltyByCard", episode["wastePenaltiesByCard"])):
            row[destination].update(source)
        row["unresolvedLandingSources"] += course["westEuropeSourceUnresolved"]
        row["observedOpponentInterventions"].update(course["opponentInterventions"])
        row["failedWithObservedOpponentIntervention"] += int(
            course["failedWithObservedOpponentIntervention"])
        row["feeCardsSpent"] += episode["feeCardsSpent"]
        row["wastePenaltyTotal"] += episode["wastePenaltyTotal"]
    for row in courses.values():
        row["scoreDifferenceAxisMinusAlliesMean"] = (sum(row["scoreDifferenceAxisMinusAllies"])
            / len(row["scoreDifferenceAxisMinusAllies"]))
        for field in ("triggerOpportunities", "triggerActivations", "sourceSelections",
                      "installationSelections", "placements", "removals",
                      "westEuropeLandingSources", "wastePenaltyByCard"):
            row[field] = dict(row[field])
        row["observedOpponentInterventions"] = dict(row["observedOpponentInterventions"])
    return {"normal": {"episodes": len(normal),
                       "decisions": sum(item["decisions"] for item in normal),
                       "axisWins": sum(item["winner"] == "axis" for item in normal),
                       "alliesWins": sum(item["winner"] == "allies" for item in normal)},
            "course": courses,
            "sampleWeighting": "Every post-takeover valid decision has the existing equal sample weight;"
                               " longer continuations contribute more samples."}
