"""Team builds: eight specific roster archetypes, deeper than contender/middle/rebuilding.

Each team is placed from five league-relative measures:
  now     rank in rest-of-season lineup points a week (ros_ppg), the win-now strength
  value   rank in total dynasty value (players + picks)
  age     value-weighted age of the team's top CORE players, as a z-score in the league
  youth   share of player value in players YOUNG or younger
  picks   share of total value held in draft picks
plus where the projected record lands against the playoff line.

The decision runs top to bottom; the first build that fits wins, so every team gets
exactly one. `reasons` are the numbers that put it there; `plan` is the playbook.
"""
from __future__ import annotations

from statistics import mean, pstdev

CORE = 12          # top players by value used for core age
YOUNG = 24         # "young" for the youth share
OLD_Z = 0.5        # core age z-score that counts as old
YOUNG_Z = -0.5     # ... and as young

BUILDS = {
    "juggernaut": {
        "name": "Dynasty Juggernaut",
        "tone": "contender",
        "about": "Strong now and strong later: top-third points and top-third dynasty value without an old core.",
        "plan": ["Win now without spending the future: trade depth and later picks for upgrades, not young starters.",
                 "Sell any starter about to age out a year early while he still has value.",
                 "Keep one or two firsts a year so the window never closes."],
    },
    "all_in": {
        "name": "All-In Veterans",
        "tone": "contender",
        "about": "Built to win this year on older starters; the window is one or two seasons.",
        "plan": ["Push every chip in: future picks are worth more to you as points now.",
                 "Buy proven vets that rebuilders are dumping at a discount.",
                 "Plan the exit: sell the oldest starters the offseason after the title run, before their value drops."],
    },
    "young_contender": {
        "name": "Young Contender",
        "tone": "contender",
        "about": "Already good with a young core, so the window is long and still opening.",
        "plan": ["Hold the young core; patience costs nothing here.",
                 "Add short-term vets cheaply for the playoff push instead of paying with young players.",
                 "Turn surplus picks into proven starters at the weakest room."],
    },
    "bubble": {
        "name": "Playoff Bubble",
        "tone": "middle",
        "about": "Middle of the pack on points but in or near a playoff spot.",
        "plan": ["Fix the one or two weakest starting spots; a small upgrade swings a bubble team.",
                 "Pay with depth and seconds, not firsts, unless the upgrade makes you a top-three team.",
                 "If the record slips below the line by midseason, flip to a retool and sell the vets."],
    },
    "stuck": {
        "name": "Stuck in the Middle",
        "tone": "middle",
        "about": "Not good enough to win, not young enough to wait, and the record is outside the playoff line.",
        "plan": ["Pick a direction now; the middle wins nothing and drafts mid-round.",
                 "Usually that means selling vets 26+ to contenders for firsts and young players.",
                 "Consolidate two good players into one great one if you'd rather push."],
    },
    "youth": {
        "name": "Youth Movement",
        "tone": "rebuilding",
        "about": "Losing now but the value is in young players, so the rebuild is already on track.",
        "plan": ["Hold the young core and let it grow; don't sell low on second-year players.",
                 "Sell any remaining vets for picks in next year's draft.",
                 "Buy young players at injury or slump lows from contenders."],
    },
    "pick_hoarder": {
        "name": "Pick Hoarder",
        "tone": "rebuilding",
        "about": "An outsized share of value sits in draft picks.",
        "plan": ["Picks lose value as the draft nears unless they're early; know which ones to use and which to flip.",
                 "Turn late firsts into young players who already produce.",
                 "Package several picks to move up for a top-three pick in a strong class."],
    },
    "teardown": {
        "name": "Full Teardown",
        "tone": "rebuilding",
        "about": "Bottom of the league with an older roster and little youth, so the fastest path is to sell everything.",
        "plan": ["Sell every vet now for picks; each loss improves your own pick.",
                 "Aim the tank at the 1.01 and stack firsts in the next two drafts.",
                 "Take young upside fliers as throw-ins in every deal."],
    },
}


def _rank(teams: list, key, reverse=True) -> dict:
    order = sorted(teams, key=key, reverse=reverse)
    return {t["roster_id"]: i for i, t in enumerate(order, 1)}


def _ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def core_age(team: dict, by_id: dict) -> float | None:
    core = sorted((by_id[i] for i in team["players"] if i in by_id and by_id[i].get("age")),
                  key=lambda p: -p["value"])[:CORE]
    w = sum(p["value"] for p in core)
    return round(sum(p["age"] * p["value"] for p in core) / w, 1) if w else None


def assign(teams: list, by_id: dict, playoff_teams: int) -> dict:
    """{roster_id: {"key", "name", "tone", "about", "plan", "reasons", "metrics"}}"""
    n = len(teams)
    if not n:
        return {}
    pct = lambda r: (r - 1) / (n - 1) if n > 1 else 0.0  # 0 = best
    now = _rank(teams, lambda t: t.get("ros_ppg") or 0)
    val = _rank(teams, lambda t: t["total_value"])
    ages = {t["roster_id"]: core_age(t, by_id) for t in teams}
    known = [a for a in ages.values() if a is not None]
    mu, sd = (mean(known), pstdev(known) or 1.0) if known else (26.0, 1.0)
    youth = {t["roster_id"]: sum(by_id[i]["value"] for i in t["players"]
                                 if i in by_id and (by_id[i].get("age") or 99) <= YOUNG) / max(t["player_value"], 1)
             for t in teams}
    ysort = _rank(teams, lambda t: youth[t["roster_id"]])
    pshare = {t["roster_id"]: t["pick_value"] / max(t["total_value"], 1) for t in teams}
    psort = _rank(teams, lambda t: pshare[t["roster_id"]])
    oldest = _rank(teams, lambda t: ages[t["roster_id"]] or mu)
    med_pick = sorted(pshare.values())[n // 2]

    out = {}
    for t in teams:
        rid = t["roster_id"]
        P, V = pct(now[rid]), pct(val[rid])
        z = ((ages[rid] or mu) - mu) / sd
        old, young = z >= OLD_Z, z <= YOUNG_Z
        Y = pct(ysort[rid])
        proj = (t.get("projection") or {}).get("rank") or n
        in_line = proj <= playoff_teams
        hoard = psort[rid] <= max(2, n // 6) and pshare[rid] >= max(1.5 * med_pick, 0.15)

        if P <= 1 / 3 and V <= 1 / 3 and not old:
            key = "juggernaut"
        elif P <= 1 / 3 and (z <= 0.25 or (youth[rid] >= 0.35 and not old)):
            key = "young_contender"
        elif P <= 1 / 3:
            key = "all_in"
        elif hoard:
            key = "pick_hoarder"
        elif P < 2 / 3 and in_line:
            key = "bubble"
        elif young or Y <= 1 / 3:
            key = "youth"
        elif P >= 2 / 3:
            key = "teardown"
        else:
            key = "stuck"

        reasons = [
            f"{_ordinal(now[rid])} of {n} in points a week the rest of the way ({t.get('ros_ppg') or 0:.1f})",
            f"{_ordinal(val[rid])} in total dynasty value",
            f"core age {ages[rid] if ages[rid] is not None else '?'}, {_ordinal(oldest[rid])} oldest",
            f"{round(youth[rid] * 100)}% of player value is {YOUNG} or younger ({_ordinal(ysort[rid])} most)",
            f"picks are {round(pshare[rid] * 100)}% of value ({_ordinal(psort[rid])} most)",
            f"projected {_ordinal(proj)}, playoff line is {playoff_teams}",
        ]
        out[rid] = {"key": key, **BUILDS[key], "reasons": reasons,
                    "metrics": {"now_rank": now[rid], "value_rank": val[rid], "core_age": ages[rid],
                                "age_z": round(z, 2), "youth_share": round(youth[rid], 3),
                                "pick_share": round(pshare[rid], 3), "proj_rank": proj}}
    return out
