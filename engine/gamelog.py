"""Every game a player has played this season and last, scored under one league's rules.

Sleeper's weekly stat lines use the same keys as league scoring settings, so each
game is scored exactly (TE premium, first-down points, 6-point passing TDs, IDP,
yardage bonuses per game). The season-total model already scored totals exactly;
the game logs add what totals can't show: how steady a player is (floor, ceiling,
spread), how he has played lately, and how many games he actually played.

Finished weeks don't change after stat corrections settle, so they are cached for
days (last season's for a month).
"""

from statistics import pstdev

from . import sleeper
from .league import fantasy_points

LAST_SEASON_TTL = 30 * 24 * 3600
THIS_SEASON_TTL = 2 * 24 * 3600
RECENT = 4


def collect(season: int, last_complete_week: int, idp: bool, optional) -> dict:
    """{player id: [(season, week, stats), ...]} oldest first, for weeks that were played."""
    out: dict[str, list] = {}
    plan = [(season - 1, w, LAST_SEASON_TTL) for w in range(1, 19)] + \
           [(season, w, THIS_SEASON_TTL) for w in range(1, last_complete_week + 1)]
    for s, w, ttl in plan:
        rows = optional(lambda s=s, w=w, ttl=ttl: sleeper.week_stats(s, w, idp, ttl, keep=True)) or {}
        for pid, row in rows.items():
            st = row.get("stats") or {}
            if float(st.get("gp") or 0) > 0:
                out.setdefault(pid, []).append((s, w, st))
    return out


def _pct(xs: list[float], q: float) -> float:
    xs = sorted(xs)
    i = (len(xs) - 1) * q
    lo, hi = int(i), min(int(i) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)


def summarize(logs: dict, pid: str, group: str, scoring: dict, season: int) -> dict | None:
    games = logs.get(pid)
    if not games:
        return None
    pts = [(s, fantasy_points(st, scoring, group)) for s, _, st in games]
    now = [p for s, p in pts if s == season]
    last = [p for s, p in pts if s == season - 1]
    allp = [p for _, p in pts]
    out = {
        "games": len(now), "games_last": len(last),
        "ppg": round(sum(now) / len(now), 2) if now else None,
        "ppg_last": round(sum(last) / len(last), 2) if last else None,
        "recent": round(sum(allp[-RECENT:]) / len(allp[-RECENT:]), 2),
    }
    if len(allp) >= 4:
        out.update({"floor": round(_pct(allp, 0.25), 1), "ceiling": round(_pct(allp, 0.75), 1),
                    "sd": round(pstdev(allp), 1)})
    return out
