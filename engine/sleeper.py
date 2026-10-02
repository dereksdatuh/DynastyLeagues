"""Sleeper API client: league settings, rosters, picks, players, projections, stats."""

from .fetch import get_json

V1 = "https://api.sleeper.app/v1"
PROJ = "https://api.sleeper.com/projections/nfl"
STATS = "https://api.sleeper.com/stats/nfl"

HOUR = 3600
OFFENSE = ["QB", "RB", "WR", "TE", "K", "DEF"]
IDP = ["DL", "LB", "DB", "DE", "DT", "CB", "S"]


def nfl_state() -> dict:
    return get_json("sleeper_state", f"{V1}/state/nfl", ttl=HOUR)


def league(league_id: str) -> dict:
    return get_json(f"sleeper_league_{league_id}", f"{V1}/league/{league_id}", ttl=HOUR)


def rosters(league_id: str) -> list:
    return get_json(f"sleeper_rosters_{league_id}", f"{V1}/league/{league_id}/rosters", ttl=HOUR)


def users(league_id: str) -> list:
    return get_json(f"sleeper_users_{league_id}", f"{V1}/league/{league_id}/users", ttl=HOUR)


def traded_picks(league_id: str) -> list:
    return get_json(f"sleeper_traded_picks_{league_id}", f"{V1}/league/{league_id}/traded_picks", ttl=HOUR)


def players() -> dict:
    """Full player database keyed by Sleeper id (large; cached for a day)."""
    return get_json("sleeper_players", f"{V1}/players/nfl", ttl=24 * HOUR)


def _by_player(rows: list) -> dict:
    out = {}
    for row in rows or []:
        pid = str(row.get("player_id") or "")
        if pid and pid not in out:
            out[pid] = row
    return out


def _positions(include_idp: bool) -> list:
    return OFFENSE + (IDP if include_idp else [])


def season_projections(season: str | int, include_idp: bool) -> dict:
    """Season-long projected stat lines keyed by player id."""
    params = {"season_type": "regular", "position[]": _positions(include_idp), "order_by": "pts_ppr"}
    rows = get_json(f"sleeper_proj_{season}_{int(include_idp)}", f"{PROJ}/{season}", params, ttl=12 * HOUR)
    return _by_player(rows)


def week_projections(season: str | int, week: int, include_idp: bool) -> dict:
    params = {"season_type": "regular", "position[]": _positions(include_idp), "order_by": "pts_ppr"}
    rows = get_json(
        f"sleeper_proj_{season}_w{week}_{int(include_idp)}", f"{PROJ}/{season}/{week}", params, ttl=6 * HOUR
    )
    return _by_player(rows)


def season_stats(season: str | int, include_idp: bool) -> dict:
    params = {"season_type": "regular", "position[]": _positions(include_idp), "order_by": "pts_ppr"}
    rows = get_json(f"sleeper_stats_{season}_{int(include_idp)}", f"{STATS}/{season}", params, ttl=12 * HOUR)
    return _by_player(rows)
