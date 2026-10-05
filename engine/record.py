"""Projected season records from each team's best lineup and the league schedule.

A team's weekly score is its optimal lineup's rest-of-season points per game.
A game is won with probability Φ((μa − μb) / (σ·√2)), where σ is the spread of
one team's weekly score (a share of the league's average score). Projected
record = current record + expected wins over the remaining regular season.
Weeks without a scheduled opponent use the average against every other team.
The same math runs in the browser (site/app.js) to re-project after a trade.
"""

from math import erf, sqrt

# Spread of a team's weekly score as a share of the league average: about 0.18
# week to week, widened to cover the error in each lineup's projection itself.
SIGMA_SHARE = 0.21
# Rest-of-season availability for injury designations.
AVAILABILITY = {"IR": 0.35, "PUP": 0.35, "Sus": 0.35, "NFI": 0.35, "Out": 0.85, "Doubtful": 0.9}
DEFAULT_PLAYOFF_WEEK = 15


def ros_ppg(ppg, injury) -> float:
    return round((ppg or 0) * AVAILABILITY.get(injury or "", 1.0), 2)


def win_prob(mu_a: float, mu_b: float, sigma: float) -> float:
    if sigma <= 0:
        return 0.5 if mu_a == mu_b else float(mu_a > mu_b)
    return 0.5 * (1 + erf((mu_a - mu_b) / (sigma * 2)))  # Φ(d / (σ√2)) = ½(1 + erf(d / 2σ))


def vs_field(rid, ppg: dict, sigma: float) -> float:
    others = [v for k, v in ppg.items() if k != rid]
    return sum(win_prob(ppg[rid], v, sigma) for v in others) / len(others) if others else 0.5


def vs_median(rid, ppg: dict, sigma: float) -> float:
    """Chance of finishing above the league median score that week."""
    others = sorted(v for k, v in ppg.items() if k != rid)
    if not others:
        return 0.5
    mid = others[len(others) // 2] if len(others) % 2 else (others[len(others) // 2 - 1] + others[len(others) // 2]) / 2
    return 0.5 * (1 + erf((ppg[rid] - mid) / (sigma * sqrt(2))))


def schedule_pairs(matchups: list) -> list[list]:
    """Sleeper's matchup rows for one week -> [[roster_a, roster_b], ...]."""
    by_id: dict = {}
    for m in matchups or []:
        if m.get("matchup_id") is not None:
            by_id.setdefault(m["matchup_id"], []).append(m["roster_id"])
    return [sorted(v) for v in by_id.values() if len(v) == 2]


def sigma_for(ppg: dict) -> float:
    vals = [v for v in ppg.values() if v > 0]
    return SIGMA_SHARE * (sum(vals) / len(vals)) if vals else 1.0


def project(ppg: dict, current: dict, schedule: dict, median_game: bool = False, sigma: float | None = None) -> dict:
    """ppg {rid: points/week}; current {rid: {"wins","losses","ties"}}; schedule {week: [[a, b], ...]}."""
    sigma = sigma or sigma_for(ppg)
    out = {}
    for rid in ppg:
        cur = current.get(rid) or {}
        exp_w = games = 0.0
        for pairs in schedule.values():
            opp = next((b if a == rid else a for a, b in pairs if rid in (a, b)), None)
            exp_w += win_prob(ppg[rid], ppg[opp], sigma) if opp in ppg else vs_field(rid, ppg, sigma)
            games += 1
            if median_game:
                exp_w += vs_median(rid, ppg, sigma)
                games += 1
        wins = cur.get("wins", 0) + exp_w
        losses = cur.get("losses", 0) + games - exp_w
        # Max PF to date plus the best lineup's projected points for each week left.
        max_pf = (cur.get("max_pf") or 0) + ppg[rid] * len(schedule)
        out[rid] = {"ppg": round(ppg[rid], 2), "wins": round(wins, 2), "losses": round(losses, 2),
                    "ties": cur.get("ties", 0), "remaining_wins": round(exp_w, 2), "remaining_games": int(games),
                    "max_pf": round(max_pf, 1)}
    order = sorted(out, key=lambda r: (-out[r]["wins"], -out[r]["ppg"]))
    for i, rid in enumerate(order, 1):
        out[rid]["rank"] = i
    for i, rid in enumerate(sorted(out, key=lambda r: -out[r]["max_pf"]), 1):
        out[rid]["max_pf_rank"] = i
    return out


def remaining_weeks(league: dict, state: dict) -> list[int]:
    """Regular-season weeks still to play for this league."""
    last = int((league.get("settings") or {}).get("playoff_week_start") or DEFAULT_PLAYOFF_WEEK) - 1
    status = league.get("status")
    if status == "complete":
        return []
    same_season = str(league.get("season")) == str(state.get("league_season") or state.get("season"))
    if status == "in_season" and same_season and state.get("season_type") in ("regular", "post"):
        start = max(int(state.get("week") or 1), int((league.get("settings") or {}).get("start_week") or 1))
        return list(range(start, last + 1))
    return list(range(int((league.get("settings") or {}).get("start_week") or 1), last + 1))
