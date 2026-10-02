"""League-specific production model.

1. Score every player's projected and recent stat lines under the league's exact
   scoring settings to get points per game (and the same under generic scoring,
   to measure how much this league's scoring helps or hurts each player).
2. Fill every team's starting lineup, slot by slot, flex slots last, to find the
   replacement level at each position for this league's roster construction.
3. Project points over replacement across a multi-year window with positional
   age curves and a time discount. That sum is the player's dynasty production score.
"""

from .league import LeagueFormat, baseline_scoring, fantasy_points, SLOT_ELIGIBILITY

GAMES = 17
HORIZON_YEARS = 5
DISCOUNT = 0.8

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


def _curve(group: str, age: float) -> float:
    start, end, growth, decline = AGE_CURVES.get(group, (24, 28, 0.05, 0.10))
    if age < start:
        return (1 - growth) ** (start - age)
    if age > end:
        return max(0.0, 1 - decline) ** (age - end)
    return 1.0


def age_multiplier(group: str, age: float | None, years_ahead: int) -> float:
    if not years_ahead:
        return 1.0
    if age is None:
        return 0.9 ** years_ahead
    return _curve(group, age + years_ahead) / _curve(group, age)


def _per_game(entry: dict | None, scoring: dict, group: str):
    if not entry:
        return None, 0
    stats = entry.get("stats") or {}
    gp = float(stats.get("gp") or stats.get("gms_active") or 0)
    if gp <= 0:
        return None, 0
    return fantasy_points(stats, scoring, group) / gp, gp


def estimate_ppg(pid: str, group: str, fmt: LeagueFormat, proj: dict, cur: dict, last: dict):
    """Blend season projection, this season's results, and last season's results."""
    base_scoring = baseline_scoring(fmt.ppr)
    league_num = base_num = weight = 0.0
    for src, w_fn in (
        (proj, lambda gp: 1.0),
        (cur, lambda gp: min(gp / 8, 1.0)),
        (last, lambda gp: 0.5 * min(gp, GAMES) / GAMES),
    ):
        ppg, gp = _per_game(src.get(pid), fmt.scoring, group)
        if ppg is None:
            continue
        w = w_fn(gp)
        base_ppg, _ = _per_game(src.get(pid), base_scoring, group)
        league_num += w * ppg
        base_num += w * (base_ppg or 0)
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


def dynasty_score(ppg: float, group: str, age: float | None, repl: float) -> float:
    total = 0.0
    for y in range(HORIZON_YEARS):
        surplus = ppg * age_multiplier(group, age, y) - repl
        if surplus > 0:
            total += ((DISCOUNT * STABILITY.get(group, 0.85)) ** y) * surplus * GAMES
    return total
