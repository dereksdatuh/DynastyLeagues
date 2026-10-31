"""Each player's situation beyond his stat line: role, type, depth chart, contract, health.

Built once per run from nflverse (engine/nflverse.py) and Sleeper's player records,
then read by the valuation for every league:

* `role`      - scales this season's line by how his share of the team's targets and
                carries moved over the last four games. The backtest found recent
                role changes mostly fade (engine/backtest.py `in_season.role_trend`),
                so a spike is trusted less, not more.
* `archetype` - rushing vs pocket QB, receiving vs early-down RB, deep vs short WR,
                which picks the age curve (only where the fitted curve beat the old
                one on held-out seasons).
* `later`     - scales the years after this one: games played (backtested), the last
                year of a contract once he's past his peak, and a QB who isn't first
                on his team's depth chart. Clamped to a narrow band.

Coaching changes are shown but not priced: nothing in the backtest supports a number.
"""

from . import model, nflverse

ROLE_CLAMP = (0.85, 1.15)
LATER_CLAMP = (0.85, 1.02)
EXPIRING = 0.96        # last contract year, past his position's peak
SECURE = 1.02          # three or more years left
QB_BACKUP = 0.9        # not first on the depth chart
NFLVERSE_TEAM = {"LAR": "LA"}  # Sleeper's team codes that nflverse spells differently


def gsis_map(sleeper_players: dict, crosswalk: list[dict]) -> dict:
    """sleeper id -> gsis id."""
    out = {}
    for row in crosswalk or []:
        sid, g = (row.get("sleeper_id") or "").strip(), (row.get("gsis_id") or "").strip()
        if sid and g and sid != "NA" and g != "NA":
            out[sid] = g
    for pid, p in sleeper_players.items():
        g = (p.get("gsis_id") or "").strip()
        if g and pid not in out:
            out[pid] = g
    return out


def _archetype(group: str, u: dict | None) -> str | None:
    if not u or u.get("games", 0) < 3:
        return None
    if group == "QB":
        return "QB_rush" if u.get("rush_share_pts", 0) >= 0.22 else "QB_pocket"
    if group == "RB":
        return "RB_rec" if u.get("rec_share_pts", 0) >= 0.33 else "RB_early"
    if group == "WR":
        return "WR_deep" if (u.get("adot") or 0) >= 12.5 else "WR_short"
    return None


def _trend(u: dict | None, group: str) -> float | None:
    if not u or u.get("games", 0) < 6 or group not in ("RB", "WR", "TE"):
        return None
    now = (u.get("tgt_share_recent") or 0) + (u.get("car_share_recent") or 0)
    before = (u.get("tgt_share") or 0) + (u.get("car_share") or 0)
    if before < 0.05:
        return None
    return min(max(now / before, 0.5), 1.5)


class Situations:
    """Per-run lookups; every piece is optional and a missing one just means no adjustment."""

    def __init__(self, season: int, sleeper_players: dict, crosswalk: list[dict], optional):
        self.season = season
        self.gsis = gsis_map(sleeper_players, crosswalk)
        self.usage = optional(lambda: nflverse.usage(season)) or {}
        self.usage_last = optional(lambda: nflverse.usage(season - 1)) or {}
        dc = optional(lambda: nflverse.depth(season)) or {}
        self.depth = dc.get("players") or {}
        self.depth_as_of = dc.get("as_of")
        self.contracts = optional(lambda: nflverse.contracts(season)) or {}
        self.coach_change = optional(lambda: nflverse.coach_changes(season)) or {}
        self.status = {
            "usage": len(self.usage), "usage_last": len(self.usage_last), "depth": len(self.depth),
            "depth_as_of": self.depth_as_of, "contracts": len(self.contracts), "coach_teams": len(self.coach_change),
            "mapped": len(self.gsis),
        }

    def team_games(self, cur: dict) -> dict:
        """Games each NFL team has played this season, from the most any of its players has."""
        out: dict[str, float] = {}
        for row in cur.values():
            t = row.get("team")
            gp = float((row.get("stats") or {}).get("gp") or 0)
            if t and gp > out.get(t, 0):
                out[t] = gp
        return out

    def of(self, pid: str, group: str, info: dict, cur: dict, last: dict, team_games: dict) -> dict:
        g = self.gsis.get(pid)
        u = self.usage.get(g) if g else None
        ul = self.usage_last.get(g) if g else None
        arche = _archetype(group, u if u and u.get("games", 0) >= 6 else ul or u)
        trend = _trend(u, group)
        k = float(model.IN_SEASON.get("role_trend") or 0)
        role = 1.0 if trend is None else min(max(1 + k * (trend - 1), ROLE_CLAMP[0]), ROLE_CLAMP[1])

        # Games played over this season and last, against games his team played.
        gp_cur = float(((cur.get(pid) or {}).get("stats") or {}).get("gp") or 0)
        gp_last = float(((last.get(pid) or {}).get("stats") or {}).get("gp") or 0)
        possible = team_games.get(info.get("team") or "", 0) + (model.GAMES if gp_last else 0)
        avail = model.availability_factor(group, gp_cur + gp_last, possible) if possible >= 8 else 1.0

        later, notes = avail, []
        if avail < 0.98:
            notes.append(f"missed games: next-year availability x{avail}")
        c = self.contracts.get(g) if g else None
        age = info.get("age")
        peak_end = model.curve_params(group, arche)[1]
        if c and group in ("QB", "RB", "WR", "TE"):
            if c["years_left"] <= 0 and age and age > peak_end:
                later *= EXPIRING
                notes.append("contract ends this season, past his peak")
            elif c["years_left"] >= 3:
                later *= SECURE
        d = self.depth.get(g) if g else None
        if group == "QB" and d and d.get("pos") == "QB" and d.get("rank", 1) > 1:
            later *= QB_BACKUP
            notes.append(f"QB{d['rank']} on the depth chart")
        later = round(min(max(later, LATER_CLAMP[0]), LATER_CLAMP[1]), 3)
        team = info.get("team")
        team = NFLVERSE_TEAM.get(team, team)
        return {
            "archetype": arche, "role": round(role, 3), "role_trend": round(trend, 2) if trend else None,
            "later": later, "availability": avail,
            "snap": (u or {}).get("snap_recent") if u else None,
            "tgt_share": (u or {}).get("tgt_share") if u else None,
            "car_share": (u or {}).get("car_share") if u else None,
            "depth": f"{d['pos']}{d['rank']}" if d else None,
            "contract_years_left": c["years_left"] if c else None,
            "new_coach": bool(self.coach_change.get(team)) if team else False,
            "notes": notes,
        }

