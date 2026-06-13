from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import sleeper, storage, values

app = FastAPI(title="Dynasty Leagues")

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/leagues")
async def list_leagues():
    return storage.load_leagues()["leagues"]


class LeagueConfig(BaseModel):
    id: str
    name: str
    sleeper_league_id: str
    buy_in: float = 0
    currency: str = "USD"
    payouts: dict = {}
    notes: str = ""


@app.put("/api/leagues/{league_id}")
async def update_league(league_id: str, config: LeagueConfig):
    if config.id != league_id:
        raise HTTPException(400, "id in body must match id in path")
    return storage.upsert_league_config(config.model_dump())


@app.get("/api/leagues/{league_id}/sleeper")
async def league_sleeper_info(league_id: str):
    """Live Sleeper league settings, rosters, and users for a configured league."""
    config = storage.get_league_config(league_id)
    if not config:
        raise HTTPException(404, "League not configured")

    sleeper_id = config.get("sleeper_league_id", "")
    if not sleeper_id or sleeper_id.startswith("PLACEHOLDER"):
        raise HTTPException(400, "Set a real sleeper_league_id for this league first")

    try:
        bundle = await sleeper.get_league_bundle(sleeper_id)
    except Exception as exc:
        raise HTTPException(502, f"Failed to reach Sleeper: {exc}")

    bundle["value_params"] = sleeper.derive_value_params(bundle["league"])
    return bundle


@app.get("/api/leagues/{league_id}/values")
async def league_values(league_id: str):
    """Dynasty player values adjusted for this league's scoring/roster format."""
    config = storage.get_league_config(league_id)
    if not config:
        raise HTTPException(404, "League not configured")

    sleeper_id = config.get("sleeper_league_id", "")
    if not sleeper_id or sleeper_id.startswith("PLACEHOLDER"):
        raise HTTPException(400, "Set a real sleeper_league_id for this league first")

    try:
        league = await sleeper.get_league(sleeper_id)
    except Exception as exc:
        raise HTTPException(502, f"Failed to reach Sleeper: {exc}")

    value_params = sleeper.derive_value_params(league)

    try:
        player_values = await values.get_league_values(value_params)
    except Exception as exc:
        raise HTTPException(502, f"Failed to reach FantasyCalc: {exc}")

    return {"value_params": value_params, "players": player_values}


@app.get("/api/leagues/{league_id}/rosters")
async def league_rosters(league_id: str):
    """Each team's roster with players valued under this league's settings."""
    config = storage.get_league_config(league_id)
    if not config:
        raise HTTPException(404, "League not configured")

    sleeper_id = config.get("sleeper_league_id", "")
    if not sleeper_id or sleeper_id.startswith("PLACEHOLDER"):
        raise HTTPException(400, "Set a real sleeper_league_id for this league first")

    try:
        bundle = await sleeper.get_league_bundle(sleeper_id)
        players_db = await sleeper.get_players_db()
    except Exception as exc:
        raise HTTPException(502, f"Failed to reach Sleeper: {exc}")

    value_params = sleeper.derive_value_params(bundle["league"])
    player_values = await values.get_league_values(value_params)
    value_by_sleeper_id = {v["sleeper_id"]: v for v in player_values if v["sleeper_id"]}

    users_by_id = {u["user_id"]: u for u in bundle["users"]}

    teams = []
    for roster in bundle["rosters"]:
        owner = users_by_id.get(roster.get("owner_id"), {})
        team_name = (owner.get("metadata") or {}).get("team_name") or owner.get("display_name") or "Unknown"

        roster_players = []
        total_value = 0
        for pid in roster.get("players") or []:
            info = players_db.get(pid, {})
            val_entry = value_by_sleeper_id.get(pid)
            value = val_entry["league_value"] if val_entry else 0
            total_value += value
            roster_players.append(
                {
                    "sleeper_id": pid,
                    "name": info.get("full_name", pid),
                    "position": info.get("position"),
                    "team": info.get("team"),
                    "value": value,
                    "league_rank": val_entry["league_rank"] if val_entry else None,
                }
            )

        roster_players.sort(key=lambda p: p["value"], reverse=True)

        teams.append(
            {
                "roster_id": roster.get("roster_id"),
                "owner_id": roster.get("owner_id"),
                "team_name": team_name,
                "record": {
                    "wins": roster.get("settings", {}).get("wins"),
                    "losses": roster.get("settings", {}).get("losses"),
                    "ties": roster.get("settings", {}).get("ties"),
                },
                "total_value": total_value,
                "players": roster_players,
            }
        )

    teams.sort(key=lambda t: t["total_value"], reverse=True)
    return {"value_params": value_params, "teams": teams}


# Serve the simple frontend dashboard
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
