"""Future power rankings: each roster's best lineup one, two and three seasons out.

Every player's points a game are aged forward with the model's age curves
(model.age_multiplier). Young players who haven't produced yet (YOUNG or younger)
are credited with the points their value implies: the points of the established
player at the same value rank at their position, times IMPLIED_SHARE. Draft picks
become rookies: from its draft year on, a pick plays like a WR whose points are those
of the established player at the same overall value, times ROOKIE_SHARE in the first
season and IMPLIED_SHARE after.
"""
from __future__ import annotations

from .model import age_multiplier
from .team_value import _lineup_points

YEARS = 3
YOUNG = 24
IMPLIED_SHARE = 0.85
ROOKIE_SHARE = 0.6


def _implied_ppg(players: list) -> dict:
    """{id: ppg implied by value rank at position, from players who have produced}."""
    out = {}
    by_pos = {}
    for p in players:
        by_pos.setdefault(p["pos"], []).append(p)
    for pos, ps in by_pos.items():
        made = sorted(((p.get("ros_ppg") or p.get("ppg") or 0) for p in ps if (p.get("ros_ppg") or p.get("ppg") or 0) > 0), reverse=True)
        if not made:
            continue
        for i, p in enumerate(sorted(ps, key=lambda p: -p["value"])):
            out[p["id"]] = made[min(i, len(made) - 1)]
    return out


def _pick_ppg(players: list):
    vals = sorted(((p["value"], p.get("ros_ppg") or p.get("ppg") or 0) for p in players
                   if (p.get("ros_ppg") or p.get("ppg") or 0) > 0 and p["pos"] in ("RB", "WR", "TE")), reverse=True)
    made = sorted((v for _, v in vals), reverse=True)

    def ppg(value: float) -> float:
        above = sum(1 for v, _ in vals if v > value)
        return made[min(above, len(made) - 1)] if made else 0.0
    return ppg


def project(teams: list, players: list, slots: list, season: int, picks: list | None = None) -> dict:
    """{roster_id: {"years": [{"year", "ppg", "rank"}...], "best_year", "trend"}}"""
    by_id = {p["id"]: p for p in players}
    implied = _implied_ppg(players)
    pick_ppg = _pick_ppg(players)
    picks_of = {}
    for pk in picks or []:
        picks_of.setdefault(pk["roster_id"], []).append(pk)
    out = {t["roster_id"]: {"years": []} for t in teams}
    for y in range(1, YEARS + 1):
        pts = {}
        for t in teams:
            roster = []
            for pid in t["players"]:
                p = by_id.get(pid)
                if not p:
                    continue
                base = p.get("ros_ppg") or p.get("ppg") or 0
                if (p.get("age") or 99) <= YOUNG:
                    base = max(base, IMPLIED_SHARE * implied.get(pid, 0))
                roster.append({"id": pid, "pos": p["pos"], "ros_ppg": base * age_multiplier(p["pos"], p.get("age"), y)})
            for pk in picks_of.get(t["roster_id"], []):
                seasons_in = season + y - pk["year"] + 1  # 1 = rookie year
                if seasons_in >= 1:
                    share = ROOKIE_SHARE if seasons_in == 1 else IMPLIED_SHARE
                    roster.append({"id": pk["id"], "pos": "WR", "ros_ppg": share * pick_ppg(pk["value"])})
            pts[t["roster_id"]] = _lineup_points(roster, slots)
        for rank, rid in enumerate(sorted(pts, key=lambda r: -pts[r]), 1):
            out[rid]["years"].append({"year": season + y, "ppg": round(pts[rid], 1), "rank": rank})
    for t in teams:
        f = out[t["roster_id"]]
        now = {"year": season, "ppg": round(t.get("ros_ppg") or 0, 1),
               "rank": sorted(teams, key=lambda x: -(x.get("ros_ppg") or 0)).index(t) + 1}
        f["now"] = now
        best = min([now] + f["years"], key=lambda r: (r["rank"], r["year"]))
        f["best_year"] = best["year"]
        f["trend"] = f["years"][-1]["rank"] - now["rank"]  # negative = rising
    return out
