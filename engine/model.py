"""League-specific production model.

1. Score every player's projected and recent stat lines under the league's exact
   scoring settings to get points per game (and the same under generic scoring,
   to measure how much this league's scoring helps or hurts each player).
2. Fill every team's starting lineup, slot by slot, flex slots last, to find the
   replacement level at each position for this league's roster construction.
3. Project points over replacement across a multi-year window with positional
   age curves and a time discount. That sum is the player's dynasty production score.
"""

import json
from pathlib import Path

from .league import LeagueFormat, baseline_scoring, fantasy_points, SLOT_ELIGIBILITY

GAMES = 17
HORIZON_YEARS = 5
# Time preference only: how much a point next year is worth against one now. What
# used to hide in here, the chance a player doesn't hold his level, is now measured
# by the backtest (STABILITY below), so this sits closer to 1 than the old 0.8.
DISCOUNT = 0.9
TUNING_FILE = Path(__file__).resolve().parent.parent / "data" / "model_tuning.json"


def _load_tuning() -> dict:
    try:
        return json.loads(TUNING_FILE.read_text())
    except Exception:
        return {}


TUNING = _load_tuning()

# (peak_start, peak_end, yearly growth before peak, yearly decline after peak)
AGE_CURVES = {
    "QB": (25, 33, 0.06, 0.08),
    "RB": (22, 26, 0.08, 0.16),
    "WR": (23, 29, 0.08, 0.10),
    "TE": (25, 30, 0.10, 0.10),
    "K": (25, 37, 0.0, 0.03),
    "DEF": (0, 99, 0.0, 0.0),
    "DL": (24, 29, 0.06, 0.10),
    "LB": (23, 28, 0.06, 0.11),
    "DB": (23, 28, 0.06, 0.12),
}

# How much of this year's production carries into future years beyond aging
# (year-over-year predictability). IDP and DBs especially are volatile.
STABILITY = {"QB": 0.93, "RB": 0.86, "WR": 0.91, "TE": 0.9, "K": 0.8, "DEF": 0.7, "DL": 0.82, "LB": 0.84, "DB": 0.74}
# Backtested: the share of points over replacement a player actually kept the next
# season after aging, missed games included (engine/backtest.py). Offense only;
# IDP, K and DEF keep the hand-set numbers above.
_TUNED = {pos: v["stability"] for pos, v in (TUNING.get("stability") or {}).items() if v.get("stability")}
if _TUNED:
    # Positions the backtest can't see (no IDP or kicker history in it) move by the
    # same ratio offense did, so their order against offense holds.
    _ratio = sum(_TUNED.values()) / sum(STABILITY[p] for p in _TUNED)
    STABILITY = {p: _TUNED.get(p, round(v * _ratio, 3)) for p, v in STABILITY.items()}

# Fitted curves by player type that beat the hand-set ones on held-out seasons.
ARCHETYPE_CURVES = {k: tuple(v["curve"]) for k, v in (TUNING.get("age_curves") or {}).items() if v.get("use")}
AVAILABILITY = TUNING.get("availability") or {}
SEASON_WEIGHTS = TUNING.get("season_weights") or {"last": 1.0, "two_ago": 0.0}
IN_SEASON = TUNING.get("in_season") or {"recent_weight": 0.0, "role_trend": 0.0}


def curve_params(group: str, archetype: str | None = None) -> tuple:
    return ARCHETYPE_CURVES.get(archetype or "") or AGE_CURVES.get(group, (24, 28, 0.05, 0.10))


def _curve(group: str, age: float, archetype: str | None = None) -> float:
    start, end, growth, decline = curve_params(group, archetype)
    if age < start:
        return (1 - growth) ** (start - age)
    if age > end:
        return max(0.0, 1 - decline) ** (age - end)
    return 1.0


def age_multiplier(group: str, age: float | None, years_ahead: int, archetype: str | None = None) -> float:
    if not years_ahead:
        return 1.0
    if age is None:
        return 0.9 ** years_ahead
    return _curve(group, age + years_ahead, archetype) / _curve(group, age, archetype)


def availability_factor(group: str, games: float | None, possible: float | None) -> float:
    """Next year's expected games against a player who missed none, from his own history.

    The backtest found how much two seasons of games played carry into the next
    (k: about 0.7 for QBs, 0.25-0.4 elsewhere), so a player who missed time is marked
    down by only that much of the gap. A healthy player stays at 1: the average
    missed time is already inside STABILITY.
    """
    a = AVAILABILITY.get(group)
    if not a or not possible or games is None:
        return 1.0
    own = min(games / possible, 1.0)
    expect = lambda x: a["mean"] + a["k"] * (x - a["mean"])
    return round(min(max(expect(own) / expect(1.0), 0.8), 1.0), 3)


def _per_game(entry: dict | None, scoring: dict, group: str):
    if not entry:
        return None, 0
    stats = entry.get("stats") or {}
    gp = float(stats.get("gp") or stats.get("gms_active") or 0)
    if gp <= 0:
        return None, 0
    return fantasy_points(stats, scoring, group) / gp, gp


def estimate_ppg(pid: str, group: str, fmt: LeagueFormat, proj: dict, cur: dict, last: dict,
                 two_ago: dict | None = None, role: float = 1.0):
    """Blend season projection, this season's results, and the last two seasons' results.

    Two seasons ago counts `two_ago` as much as last season (backtested), and
    `role` scales this season's line when the player's share of his team's targets
    and carries has moved lately (also backtested, and it mostly fades).
    """
    base_scoring = baseline_scoring(fmt.ppr)
    league_num = base_num = weight = 0.0
    w2 = 0.5 * float(SEASON_WEIGHTS.get("two_ago") or 0)
    for src, w_fn, scale in (
        (proj, lambda gp: 1.0, 1.0),
        (cur, lambda gp: min(gp / 8, 1.0), role),
        (last, lambda gp: 0.5 * min(gp, GAMES) / GAMES, 1.0),
        (two_ago or {}, lambda gp: w2 * min(gp, GAMES) / GAMES, 1.0),
    ):
        ppg, gp = _per_game(src.get(pid), fmt.scoring, group)
        if ppg is None:
            continue
        w = w_fn(gp)
        if w <= 0:
            continue
        base_ppg, _ = _per_game(src.get(pid), base_scoring, group)
        league_num += w * ppg * scale
        base_num += w * (base_ppg or 0) * scale
        weight += w
    if not weight:
        return None
    ppg = league_num / weight
    base = base_num / weight
    offense = group in ("QB", "RB", "WR", "TE")
    premium = (ppg / base) if offense and base > 1 else 1.0
    return {"ppg": round(ppg, 2), "base_ppg": round(base, 2), "premium": round(premium, 3)}


def replacement_levels(ppg_by_group: dict[str, list[float]], fmt: LeagueFormat):
    """Fill every lineup in the league; replacement = best players left at each position."""
    pools = {g: sorted(v, reverse=True) for g, v in ppg_by_group.items()}
    taken = {g: 0 for g in pools}
    slot_counts: dict[str, int] = {}
    for s in fmt.slots:
        slot_counts[s] = slot_counts.get(s, 0) + 1
    # Most restrictive slots first, so flex slots take whoever is left.
    order = sorted(slot_counts, key=lambda s: len(SLOT_ELIGIBILITY[s]))
    for slot in order:
        eligible = [g for g in SLOT_ELIGIBILITY[slot] if g in pools]
        for _ in range(slot_counts[slot] * fmt.num_teams):
            best = None
            for g in eligible:
                i = taken[g]
                if i < len(pools[g]) and (best is None or pools[g][i] > pools[best][taken[best]]):
                    best = g
            if best is None:
                break
            taken[best] += 1
    repl = {}
    for g, pool in pools.items():
        nxt = pool[taken[g]: taken[g] + 3]
        repl[g] = round(sum(nxt) / len(nxt), 2) if nxt else 0.0
    return repl, taken


def dynasty_score(ppg: float, group: str, age: float | None, repl: float, archetype: str | None = None,
                  later: float = 1.0) -> float:
    """Points over replacement over the horizon. `later` scales the years after this
    one for what's known about the player beyond age: availability, contract, depth chart."""
    total = 0.0
    for y in range(HORIZON_YEARS):
        surplus = ppg * age_multiplier(group, age, y, archetype) * (later if y else 1.0) - repl
        if surplus > 0:
            total += ((DISCOUNT * STABILITY.get(group, 0.85)) ** y) * surplus * GAMES
    return total
