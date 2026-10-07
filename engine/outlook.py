"""The draft after next: next season's team strength, and what its picks are worth.

The coming draft is ordered from this season's projected finish. The one after it
is decided by next season, so each team is projected a year ahead:

1. Every player a year older. This season's points per game move along the
   positional age curve (an aging back fades, a young receiver grows into his
   prime), then regress toward an ordinary starter by how predictable the
   position is year to year.
2. The rookies each team will add. Every coming-draft pick a team holds brings
   the prospect projected to go at that slot, at the points a veteran of his
   position and value scores, discounted for a rookie year.
3. Strength is the best lineup from that roster. The league's own draft rule
   orders the teams by it (lowest max PF first, or worst record; playoff teams
   by finish or their fixed slots).

A year out, rosters churn, so a pick is not priced at one slot. Each team's
strength is drawn many times with a wide spread, the league's order is rebuilt
each draw, and the pick is worth the average value of the slots it lands at.
A clear tanker's pick stays near the top; a middling team's spreads out.
"""

import random
from statistics import median

from . import draft
from .model import STABILITY, age_multiplier

ROOKIE_YEAR = 0.75   # a rookie's first season, against a veteran priced the same
SPREAD = 0.15        # one-season-ahead uncertainty in a team's strength, as a share of it
DRAWS = 4000
NEAREST = 5          # veterans used to turn a prospect's value into points per game


def next_ppg(p: dict, starter_ppg: dict) -> float:
    """A player's points per game next season."""
    ppg = p.get("ppg") or 0.0
    if ppg <= 0:
        return 0.0
    aged = ppg * age_multiplier(p["pos"], p.get("age"), 1)
    stab = STABILITY.get(p["pos"], 0.85)
    mean = starter_ppg.get(p["pos"], aged)
    return round(mean + stab * (aged - mean) if aged > mean else aged, 2)


def starter_levels(players: list, slots: list, teams: int) -> dict:
    """Median points per game of a starting-calibre player at each position."""
    out = {}
    for pos in {p["pos"] for p in players}:
        need = max(1, sum(1 for s in slots if s == pos)) * teams
        top = sorted((p["ppg"] for p in players if p["pos"] == pos and p.get("ppg")), reverse=True)[:need]
        if top:
            out[pos] = median(top)
    return out


def rookie_ppg(prospect: dict, players: list) -> float:
    """Points a prospect scores as a rookie: veterans of his position and value, discounted."""
    vets = [p for p in players if p["pos"] == prospect["pos"] and p.get("ppg") and p.get("value")]
    if not vets:
        return 0.0
    near = sorted(vets, key=lambda p: abs(p["value"] - prospect["value"]))[:NEAREST]
    return round(median(p["ppg"] for p in near) * ROOKIE_YEAR, 2)


def team_strength(teams: list, by_id: dict, picks: list, class_rows: list, slots: list) -> dict:
    """Next season's best-lineup points per game for every team, with what went into it."""
    from .build import best_lineup  # build imports this module
    starter_ppg = starter_levels(list(by_id.values()), slots, len(teams))
    prospects = sorted(class_rows, key=lambda p: -p["value"])
    rookies = {}
    for pk in picks:
        o = pk.get("overall")
        if o and o <= len(prospects):
            pr = prospects[o - 1]
            rookies.setdefault(pk["roster_id"], []).append({
                "id": f"rookie:{pk['id']}", "name": pr.get("name"), "pos": pr["pos"], "pick": pk["label"],
                "next_ppg": rookie_ppg(pr, list(by_id.values())),
            })
    out = {}
    for t in teams:
        roster = [{"id": p["id"], "name": p["name"], "pos": p["pos"], "next_ppg": next_ppg(p, starter_ppg)}
                  for p in (by_id[pid] for pid in t["players"] if pid in by_id)]
        roster += rookies.get(t["roster_id"], [])
        lineup = best_lineup(roster, slots, "next_ppg")
        starting = {x["id"] for x in lineup}
        out[t["roster_id"]] = {
            "ppg": round(sum(x["next_ppg"] for x in lineup), 2),
            "now_ppg": t.get("ros_ppg"),
            "rookies": [f"{r['name']} ({r['pick']})" for r in rookies.get(t["roster_id"], []) if r["id"] in starting],
        }
    return out


def _order(strength: dict, rule: str, playoff_teams: int, playoff_slots) -> list:
    rows = [{"roster_id": r, "projection": {"wins": s, "ppg": s, "max_pf": s}} for r, s in strength.items()]
    return draft.project_order(rows, rule, playoff_teams, playoff_slots)


def expected_slots(strength: dict, rule: str, playoff_teams: int, playoff_slots, snake: bool,
                   rounds: int, value_of, seed: int = 7) -> dict:
    """For every (round, original team): average slot and average value over many seasons."""
    rng = random.Random(seed)
    n = len(strength)
    acc = {}
    for _ in range(DRAWS):
        drawn = {r: s * (1 + rng.gauss(0, SPREAD)) for r, s in strength.items()}
        order = _order(drawn, rule, playoff_teams, playoff_slots)
        for rnd in range(1, rounds + 1):
            for orig in order:
                slot = draft.slot_in_round(order, rnd, orig, snake)
                a = acc.setdefault((rnd, orig), [0.0, 0.0])
                a[0] += slot
                a[1] += value_of((rnd - 1) * n + slot)
    return {k: {"slot": round(s / DRAWS, 2), "value": v / DRAWS} for k, (s, v) in acc.items()}


def slot_curve(pick_values, near_fn, near_year: int, year: int, n: int, class_rows: list,
               weight: float = draft.CLASS_MARKET_WEIGHT):
    """Value of the overall-th pick of `year`.

    The market quotes years past the coming draft only as round-wide prices, so the
    slot shape is borrowed from the coming draft (whose picks the market prices by
    slot) and scaled to the later year's round price; the class then lifts or
    lowers it the same way it does the coming draft.
    """
    vals = sorted((p["value"] for p in class_rows), reverse=True)

    def fn(overall: int) -> float:
        rnd = (overall - 1) // n + 1
        near_round = pick_values.value(near_year, rnd)
        base = draft.slot_value(pick_values, near_year, overall, n)
        market = base * pick_values.value(year, rnd) / near_round if near_round else base
        if overall <= len(vals):
            return weight * market + (1 - weight) * vals[overall - 1]
        return market
    return fn
