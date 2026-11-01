"""Projected season records from each team's best lineup and the league schedule.

Each week a team scores around that week's best lineup (engine/weeks.py: byes and
injuries out, Sleeper's projections where it has them) with that lineup's own spread.
A game is won with probability Φ((μa − μb) / √(σa² + σb²)), where each σ also carries
the season-long projection error (weeks.BIAS_SHARE). Projected record = current
record + expected wins over the remaining regular season. Weeks without a scheduled
opponent use the average against every other team. Without weekly lineups (older
data) every week is the rest-of-season lineup points with the league's one spread.
The same math runs in the browser (site/app.js) to re-project after a trade.
"""

from math import erf, sqrt

from . import weeks as weeks_mod
from .league import fantasy_points

# Spread of a team's weekly score as a share of the league average: about 0.18
# week to week, widened to cover the error in each lineup's projection itself.
SIGMA_SHARE = 0.21
# Rest-of-season availability for injury designations.
AVAILABILITY = {"IR": 0.35, "PUP": 0.35, "Sus": 0.35, "NFI": 0.35, "Out": 0.85, "Doubtful": 0.9}
DEFAULT_PLAYOFF_WEEK = 15


# Sleeper's projections for the next few weeks see depth-chart and injury news
# (a backup taking over a starter's job) that season-long numbers miss, so they
# carry most of the rest-of-season estimate whenever Sleeper has them.
UPCOMING_WEEKS = 3
UPCOMING_WEIGHT = 0.7
LAST_REGULAR_WEEK = 18


def upcoming_ppg(pid, group, weeks: list, scoring: dict):
    """Average projected points over the upcoming weeks he's projected to play (byes skipped)."""
    pts = [fantasy_points(w[pid].get("stats"), scoring, group) for w in weeks if w.get(pid)]
    pts = [x for x in pts if x > 0]
    return round(sum(pts) / len(pts), 2) if pts else None


def blend_ppg(ppg, upcoming):
    if upcoming is None:
        return ppg
    return UPCOMING_WEIGHT * upcoming + (1 - UPCOMING_WEIGHT) * (ppg or 0)


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


class Weeks:
    """(mean, spread) of every team's score in a given week."""

    def __init__(self, ppg: dict, sigma: float, weekly: dict | None = None):
        self.ppg, self.sigma, self.weekly = ppg, sigma, weekly or {}
        self.bias = {rid: weeks_mod.bias_sd(self.weekly[rid]) for rid in self.weekly if self.weekly[rid]}

    def get(self, rid, week) -> tuple[float, float]:
        """Mean and the week's own spread (no season-long error)."""
        w = (self.weekly.get(rid) or {}).get(int(week))
        if w is None:
            return self.ppg[rid], self.sigma
        return w["mean"], w["sd"]

    def total(self, rid, week) -> tuple[float, float]:
        """Mean and the full spread a single game sees (weekly swing plus projection error)."""
        mu, sd = self.get(rid, week)
        b = self.bias.get(rid, 0.0)
        return mu, sqrt(sd * sd + b * b)

    def game(self, a, b, week) -> float:
        ma, sa = self.total(a, week)
        mb, sb = self.total(b, week)
        s = sqrt(sa * sa + sb * sb)
        if s <= 0:
            return 0.5 if ma == mb else float(ma > mb)
        return 0.5 * (1 + erf((ma - mb) / (s * sqrt(2))))

    def field(self, rid, week) -> float:
        others = [r for r in self.ppg if r != rid]
        return sum(self.game(rid, o, week) for o in others) / len(others) if others else 0.5

    def median(self, rid, week) -> float:
        others = sorted(self.total(r, week)[0] for r in self.ppg if r != rid)
        if not others:
            return 0.5
        h = len(others) // 2
        mid = others[h] if len(others) % 2 else (others[h - 1] + others[h]) / 2
        mu, sd = self.total(rid, week)
        return 0.5 * (1 + erf((mu - mid) / (sd * sqrt(2)))) if sd > 0 else float(mu > mid)


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


def seed(stats: dict, playoff_teams: int, divisions: dict | None = None) -> list:
    """Roster ids in standings order, playoff seeds first.

    stats {rid: {"wins", "ties", "pf"}}; divisions {rid: division}. With divisions,
    each division's best record wins it and takes a top seed; the playoff spots left
    go to wildcards by record. Every tie is broken by most points for.
    """
    key = lambda r: (-((stats[r].get("wins") or 0) + 0.5 * (stats[r].get("ties") or 0)), -(stats[r].get("pf") or 0))
    ranked = sorted(stats, key=key)
    divs = {(divisions or {}).get(r) for r in stats}
    if None in divs or not 2 <= len(divs) <= playoff_teams:
        return ranked
    champs = sorted((next(r for r in ranked if divisions[r] == d) for d in divs), key=key)
    return champs + [r for r in ranked if r not in champs]


def project(ppg: dict, current: dict, schedule: dict, median_game: bool = False, sigma: float | None = None,
            playoff_teams: int | None = None, divisions: dict | None = None, weekly: dict | None = None) -> dict:
    """ppg {rid: points/week}; current {rid: {"wins","losses","ties","fpts","max_pf"}}; schedule {week: [[a, b], ...]};
    weekly {rid: {week: {"mean", "sd"}}} (engine/weeks.py team_weeks), when known."""
    sigma = sigma or sigma_for(ppg)
    wk = Weeks(ppg, sigma, weekly)
    out = {}
    for rid in ppg:
        cur = current.get(rid) or {}
        exp_w = games = left = 0.0
        for week, pairs in schedule.items():
            opp = next((b if a == rid else a for a, b in pairs if rid in (a, b)), None)
            exp_w += wk.game(rid, opp, week) if opp in ppg else wk.field(rid, week)
            games += 1
            if median_game:
                exp_w += wk.median(rid, week)
                games += 1
            left += wk.get(rid, week)[0]
        wins = cur.get("wins", 0) + exp_w
        losses = cur.get("losses", 0) + games - exp_w
        # Max PF to date plus the best lineup's projected points for each week left.
        max_pf = (cur.get("max_pf") or 0) + left
        # Points for (the playoff tiebreaker): to date plus the projected points left.
        pf = (cur.get("fpts") or 0) + left
        out[rid] = {"ppg": round(ppg[rid], 2), "wins": round(wins, 2), "losses": round(losses, 2), "pf": round(pf, 1),
                    "ties": cur.get("ties", 0), "remaining_wins": round(exp_w, 2), "remaining_games": int(games),
                    "max_pf": round(max_pf, 1)}
    order = seed(out, playoff_teams or len(out), divisions)
    for i, rid in enumerate(order, 1):
        out[rid]["rank"] = i
    for i, rid in enumerate(sorted(out, key=lambda r: -out[r]["max_pf"]), 1):
        out[rid]["max_pf_rank"] = i
    return out


def strength_of_schedule(ppg: dict, schedule: dict, median_game: bool = False, sigma: float | None = None,
                         weekly: dict | None = None) -> dict:
    """How hard each team's remaining regular season is.

    For each week left: the opponent, that opponent's projected points per game and the
    team's chance to win. Difficulty is the average opponent's points per game (rank 1 =
    hardest); "vs_average" is the head-to-head wins this schedule is worth minus the wins
    the same team would expect against an average schedule (every week vs the field), so
    negative means a tougher draw. Median games don't depend on the schedule and are
    reported apart.
    """
    sigma = sigma or sigma_for(ppg)
    wk = Weeks(ppg, sigma, weekly)
    out = {}
    for rid in ppg:
        weeks, opp_pts, exp_w, avg_w, med_w = [], [], 0.0, 0.0, 0.0
        for week in sorted(schedule, key=int):
            opp = next((b if a == rid else a for a, b in schedule[week] if rid in (a, b)), None)
            field = wk.field(rid, week)
            p = wk.game(rid, opp, week) if opp in ppg else field
            mine = (weekly or {}).get(rid, {}).get(int(week)) or {}
            theirs = (weekly or {}).get(opp, {}).get(int(week)) or {} if opp in ppg else {}
            weeks.append({"week": int(week), "opp": opp if opp in ppg else None,
                          "ppg": round(wk.get(rid, week)[0], 1),
                          "opp_ppg": round(wk.get(opp, week)[0], 1) if opp in ppg else None, "win": round(p, 3),
                          "out": mine.get("out") or [], "opp_out": theirs.get("out") or []})
            if opp in ppg:
                opp_pts.append(wk.get(opp, week)[0])
            exp_w += p
            avg_w += field
            if median_game:
                med_w += wk.median(rid, week)
        out[rid] = {"weeks": weeks, "opp_ppg": round(sum(opp_pts) / len(opp_pts), 1) if opp_pts else None,
                    "exp_wins": round(exp_w, 2), "avg_wins": round(avg_w, 2), "vs_average": round(exp_w - avg_w, 2),
                    "median_wins": round(med_w, 2) if median_game else None}
    rated = sorted((r for r in out if out[r]["opp_ppg"] is not None), key=lambda r: -out[r]["opp_ppg"])
    for i, rid in enumerate(rated, 1):
        out[rid]["rank"] = i
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
