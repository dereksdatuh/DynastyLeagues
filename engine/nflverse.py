"""Usage, depth charts, contracts and coaches from nflverse's public data releases.

Every table is boiled down to a small per-player summary keyed by gsis id, and that
summary is what gets cached, so the big raw files (the depth chart file runs past
50 MB) are downloaded at most a few times a day.

    usage(season)        -> {gsis: {snap shares, target and carry shares, aDOT, team}}
    depth(season)        -> {gsis: {"pos": "WR", "rank": 1, "team": "DET"}}
    contracts()          -> {gsis: {"years_left": 2, "apy": 30000000.0}}
    coach_changes(season)-> {"DET": True, ...} (head coach differs from last season's)
    byes(season)         -> {"DET": [6], ...} (regular-season weeks each team has no game)
    birthdays()          -> {gsis: "1999-07-24"}, plus pfr and otc id maps
"""

import csv
import gzip
import io
import json
import sys
from datetime import date

from . import fetch

BASE = "https://github.com/nflverse/nflverse-data/releases/download"
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
DAY = 24 * 3600
RECENT_GAMES = 4  # "recent" usage window


def _rows(url: str, gz: bool = False):
    resp = fetch.TRANSPORT(url, None)
    if gz:
        text = gzip.decompress(resp.content).decode("utf-8", "replace")
    else:
        text = resp.text
    return csv.DictReader(io.StringIO(text))


def _derived(key: str, ttl: int, build):
    """Cache only the small summary `build()` returns, never the raw download."""
    path = fetch._cache_file(f"keep_nflv_{key}", "json")
    cached = fetch._read_cache(path, ttl)
    if cached is not None:
        return json.loads(cached)
    data = build()
    fetch.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")))
    return data


def _f(x, default=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def ids() -> dict:
    """gsis -> {"pfr", "otc", "birth"} from nflverse's player table."""
    def build():
        out = {}
        for r in _rows(f"{BASE}/players/players.csv"):
            g = r.get("gsis_id")
            if g:
                out[g] = {"pfr": r.get("pfr_id") or None, "otc": r.get("otc_id") or None,
                          "birth": r.get("birth_date") or None, "pos": r.get("position") or None}
        return out
    return _derived("ids", 7 * DAY, build)


def usage(season: int) -> dict:
    """Share of the team's snaps, targets and carries, season to date and over the last few games."""
    def build():
        weekly: dict[str, list] = {}
        team_tot: dict[tuple, list] = {}
        for r in _rows(f"{BASE}/stats_player/stats_player_week_{season}.csv"):
            if r.get("season_type") not in ("REG", None, ""):
                continue
            g = r.get("player_id")
            if not g:
                continue
            wk = int(_f(r.get("week")))
            row = {"wk": wk, "team": r.get("team"), "tgt": _f(r.get("targets")), "car": _f(r.get("carries")),
                   "att": _f(r.get("attempts")), "ry": _f(r.get("rushing_yards")),
                   "air": _f(r.get("receiving_air_yards")), "ts": _f(r.get("target_share")),
                   "rec_pts": _f(r.get("receptions")) + 0.1 * _f(r.get("receiving_yards")) + 6 * _f(r.get("receiving_tds")),
                   "rush_pts": 0.1 * _f(r.get("rushing_yards")) + 6 * _f(r.get("rushing_tds")),
                   "pass_pts": 0.04 * _f(r.get("passing_yards")) + 4 * _f(r.get("passing_tds")) - _f(r.get("passing_interceptions"))}
            weekly.setdefault(g, []).append(row)
            t = team_tot.setdefault((r.get("team"), wk), [0.0, 0.0])
            t[0] += row["tgt"]
            t[1] += row["car"]
        snaps: dict[str, list] = {}
        try:
            for r in _rows(f"{BASE}/snap_counts/snap_counts_{season}.csv"):
                if r.get("game_type") != "REG":
                    continue
                pct = max(_f(r.get("offense_pct")), _f(r.get("defense_pct")))
                snaps.setdefault(r.get("pfr_player_id"), []).append((int(_f(r.get("week"))), pct))
        except Exception as exc:  # usage still works from targets and carries
            print(f"warning: nflverse snap counts {season} failed: {exc}"[:300], file=sys.stderr)
        id_map = ids()
        pfr_to_gsis = {v["pfr"]: g for g, v in id_map.items() if v.get("pfr")}
        snap_by_gsis = {pfr_to_gsis[p]: v for p, v in snaps.items() if p in pfr_to_gsis}
        out = {}
        for g, rows in weekly.items():
            rows.sort(key=lambda x: x["wk"])
            recent = rows[-RECENT_GAMES:]

            def share(rs, k, i):
                num = sum(x[k] for x in rs)
                den = sum(team_tot.get((x["team"], x["wk"]), [0, 0])[i] for x in rs)
                return round(num / den, 3) if den else 0.0
            pts = {k: sum(x[k] for x in rows) for k in ("rec_pts", "rush_pts", "pass_pts")}
            tot = sum(pts.values()) or 1.0
            tgt = sum(x["tgt"] for x in rows)
            sn = sorted(snap_by_gsis.get(g, []))
            out[g] = {
                "team": rows[-1]["team"], "games": len(rows),
                "tgt_share": share(rows, "tgt", 0), "tgt_share_recent": share(recent, "tgt", 0),
                "car_share": share(rows, "car", 1), "car_share_recent": share(recent, "car", 1),
                "snap": round(sum(p for _, p in sn) / len(sn), 3) if sn else None,
                "snap_recent": round(sum(p for _, p in sn[-RECENT_GAMES:]) / len(sn[-RECENT_GAMES:]), 3) if sn else None,
                "adot": round(sum(x["air"] for x in rows) / tgt, 1) if tgt >= 10 else None,
                "rush_share_pts": round(pts["rush_pts"] / tot, 3),
                "rec_share_pts": round(pts["rec_pts"] / tot, 3),
                "pass_att_pg": round(sum(x["att"] for x in rows) / len(rows), 1),
            }
        return out
    return _derived(f"usage_{season}", 12 * 3600, build)


def depth(season: int) -> dict:
    """Each player's spot on the latest published depth chart (offense skill spots and IDP)."""
    def build():
        latest, rows = "", []
        for r in _rows(f"{BASE}/depth_charts/depth_charts_{season}.csv"):
            dt = r.get("dt") or ""
            if dt > latest:
                latest, rows = dt, []
            if dt == latest:
                rows.append(r)
        out = {}
        for r in rows:
            g = r.get("gsis_id")
            if not g:
                continue
            rank = int(_f(r.get("pos_rank"), 9))
            pos = r.get("pos_abb") or ""
            if g not in out or rank < out[g]["rank"]:
                out[g] = {"pos": pos, "rank": rank, "team": r.get("team")}
        return {"as_of": latest, "players": out}
    return _derived(f"depth_{season}", 12 * 3600, build)


def contracts(season: int) -> dict:
    """Years left on each active player's current deal (OverTheCap via nflverse)."""
    def build():
        otc_to_gsis = {v["otc"]: g for g, v in ids().items() if v.get("otc")}
        out = {}
        for r in _rows(f"{BASE}/contracts/historical_contracts.csv.gz", gz=True):
            if (r.get("is_active") or "").upper() != "TRUE":
                continue
            g = otc_to_gsis.get(r.get("otc_id"))
            if not g:
                continue
            signed, years = int(_f(r.get("year_signed"))), int(_f(r.get("years")))
            if not signed or not years:
                continue
            left = signed + years - season
            if g not in out or signed > out[g]["signed"]:
                out[g] = {"signed": signed, "years_left": max(left, 0), "apy": _f(r.get("apy"))}
        return out
    return _derived(f"contracts_{season}", 2 * DAY, build)


def coach_changes(season: int) -> dict:
    """Team -> True when its head coach this season isn't the one who finished last season."""
    def build():
        coach: dict[tuple, tuple] = {}
        for r in _rows(GAMES_URL):
            s = int(_f(r.get("season")))
            if s not in (season - 1, season) or r.get("game_type") != "REG":
                continue
            wk = int(_f(r.get("week")))
            for side in ("home", "away"):
                key = (s, r.get(f"{side}_team"))
                c = r.get(f"{side}_coach")
                if c and (key not in coach or wk > coach[key][0]):
                    coach[key] = (wk, c)
        out = {}
        for (s, team), (_, c) in coach.items():
            if s == season and (season - 1, team) in coach:
                out[team] = coach[(season - 1, team)][1] != c
        return out
    return _derived(f"coaches_{season}", DAY, build)


def byes(season: int, last_week: int = 18) -> dict:
    """Team -> the regular-season weeks it doesn't play, from the published NFL schedule."""
    def build():
        played: dict[str, set] = {}
        for r in _rows(GAMES_URL):
            if int(_f(r.get("season"))) != season or r.get("game_type") != "REG":
                continue
            wk = int(_f(r.get("week")))
            for side in ("home_team", "away_team"):
                if r.get(side):
                    played.setdefault(r[side], set()).add(wk)
        if not played:
            return {}
        weeks = set(range(1, max(max(w) for w in played.values()) + 1))
        return {t: sorted(weeks - w) for t, w in sorted(played.items())}
    return _derived(f"byes_{season}", DAY, build)


def age_on(birth: str | None, when: date) -> float | None:
    if not birth:
        return None
    try:
        y, m, d = (int(x) for x in birth[:10].split("-"))
        return round((when - date(y, m, d)).days / 365.25, 2)
    except ValueError:
        return None
