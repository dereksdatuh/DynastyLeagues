"""Each team's best lineup for every week left, with byes and injuries taken out.

The season sims (engine/record.py, engine/landing.py and the browser's Playoff Odds
tab) used to play every remaining week from one number per team: its best lineup's
rest-of-season points a week. That number ignores that a team with three starters on
bye in week 11 scores far less that week, and that a player on IR this week may be
back for the playoffs. Here every player gets expected points for each week:

* a week his NFL team has no game: 0;
* a week Sleeper projects (this week and the next two): Sleeper's projection, which
  already sees depth-chart and injury news;
* any other week: his rest-of-season points a game (the same blend `ros_ppg` uses),
  times how likely his injury designation lets him play that many weeks out
  (`RETURN`: Out this week means likely back next week, IR means gone a while).

Each week's team mean is then the best lineup on those points (the bench covers a
bye), and its spread comes from the starters' own game-to-game swings (their game
logs), so a team leaning on boom-or-bust players swings more. On top of the weekly
swing, the sims draw one error per team per season (`BIAS_SHARE`), because a team the
projections overrate is overrated every week, not at random.

The browser recomputes the same thing for rosters after a trade from the per-player
weekly points shipped in `players[].wk` and `players[].cv` (site/app.js `teamWeeks`).
"""

from math import sqrt

from .league import SLOT_ELIGIBILITY, fantasy_points

LAST_WEEK = 17            # the last fantasy week the sims need (playoffs included)
DEFAULT_CV = 0.55         # weekly swing / points for a player with no game log
CV_CLAMP = (0.35, 0.9)
SD_SCALE = 1.15           # teammates' scores move together (game script, shootouts)
BIAS_SHARE = 0.08         # one team's season-long projection error, as a share of its points
MIN_SHARE = 0.12          # floor on a team's weekly spread as a share of its points
NFLVERSE_TEAM = {"LAR": "LA"}

# Chance a player with this designation plays, by weeks from now (last entry repeats).
RETURN = {
    "Questionable": [0.85, 1.0],
    "Doubtful": [0.15, 0.85, 1.0],
    "Out": [0.0, 0.7, 0.95],
    "Sus": [0.0, 0.0, 1.0],
    "IR": [0.0, 0.0, 0.0, 0.0, 0.6, 0.75],
    "PUP": [0.0, 0.0, 0.0, 0.0, 0.6, 0.75],
    "NFI": [0.0, 0.0, 0.0, 0.0, 0.5, 0.65],
}
LONG = ("IR", "PUP", "NFI", "Sus")


def plays(injury: str | None, ahead: int) -> float:
    curve = RETURN.get(injury or "")
    if not curve:
        return 1.0
    return curve[min(ahead, len(curve) - 1)]


def bye_set(byes: dict, team: str | None) -> set:
    if not team:
        return set()
    return set((byes or {}).get(NFLVERSE_TEAM.get(team, team)) or [])


def player_weeks(p: dict, weeks: list[int], now: int, base: float, upcoming: dict, scoring: dict, byes: dict) -> dict:
    """{week: expected points}. `upcoming` {week: Sleeper projection table}; `base`
    his rest-of-season points a game before any injury discount."""
    off = bye_set(byes, p.get("team"))
    out = {}
    for w in weeks:
        if w in off:
            out[w] = 0.0
            continue
        ahead = max(w - now, 0)
        avail = plays(p.get("injury"), ahead)
        table = upcoming.get(w)
        row = table.get(p["id"]) if table else None
        if row is not None:
            pts = fantasy_points(row.get("stats"), scoring, p["pos"])
            # Sleeper's projection already prices a questionable or doubtful tag;
            # a player ruled out, or out for weeks, still comes off.
            if (p.get("injury") or "") in LONG or avail == 0:
                pts *= avail
        else:
            pts = (base or 0) * avail
        out[w] = round(max(pts, 0.0), 2)
    return out


def cv_of(p: dict) -> float:
    """Weekly swing as a share of his points, from his game log."""
    g = p.get("games") or {}
    sd, ppg = g.get("sd"), g.get("ppg") or g.get("ppg_last")
    n = (g.get("games") or 0) + (g.get("games_last") or 0)
    if sd is None or not ppg or ppg <= 0 or n < 4:
        return DEFAULT_CV
    return round(min(max(sd / ppg, CV_CLAMP[0]), CV_CLAMP[1]), 3)


def best_lineup(pool: list[tuple], slots: list[str]) -> list[tuple]:
    """Greedy best lineup over (id, pos, pts, cv) tuples, most restrictive slots first."""
    pool = sorted((x for x in pool if x[2] > 0), key=lambda x: -x[2])
    used, lineup = set(), []
    for slot in sorted(slots, key=lambda s: len(SLOT_ELIGIBILITY[s])):
        for x in pool:
            if x[0] not in used and x[1] in SLOT_ELIGIBILITY[slot]:
                used.add(x[0])
                lineup.append(x)
                break
    return lineup


def team_weeks(players: list[dict], slots: list[str], weeks: list[int]) -> dict:
    """{week: {"mean", "sd", "out"}}: best lineup that week, its spread, and the
    starters of the team's usual lineup who are out that week (bye or injury)."""
    usual = {x[0] for x in best_lineup([(p["id"], p["pos"], p.get("ros_ppg") or 0, 0) for p in players], slots)}
    out = {}
    for w in weeks:
        pool = [(p["id"], p["pos"], (p.get("wk") or {}).get(w, p.get("ros_ppg") or 0), p.get("cv") or DEFAULT_CV)
                for p in players]
        lineup = best_lineup(pool, slots)
        mean = sum(x[2] for x in lineup)
        sd = SD_SCALE * sqrt(sum((x[2] * x[3]) ** 2 for x in lineup))
        missing = [x[0] for x in pool if x[0] in usual and x[2] <= 0]
        out[w] = {"mean": round(mean, 2), "sd": round(max(sd, MIN_SHARE * mean, 1.0), 2), "out": missing}
    return out


def bias_sd(weekly: dict) -> float:
    means = [v["mean"] for v in weekly.values()]
    return BIAS_SHARE * (sum(means) / len(means)) if means else 0.0


def sim_weeks(now: int | None, regular: list[int], playoff_start: int, playoff_rounds: int) -> list[int]:
    """Every week the sims play: what's left of the regular season, then the playoffs."""
    if not regular:
        return []
    po = range(playoff_start, min(playoff_start + playoff_rounds, LAST_WEEK + 1))
    return sorted(set(regular) | {w for w in po if now is None or w >= now})
