"""Local/hosted server: the static site plus endpoints to rebuild and evaluate trades.

The scheduled GitHub Action builds and publishes the same site without this
server; run it when you want on-demand rebuilds or to edit league configs.
"""

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from engine import build, trade

from . import storage

app = FastAPI(title="Dynasty Leagues")

SITE_DIR = Path(__file__).resolve().parent.parent / "site"
DATA_DIR = SITE_DIR / "data"


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/leagues")
def list_leagues():
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
def update_league(league_id: str, config: LeagueConfig):
    if config.id != league_id:
        raise HTTPException(400, "id in body must match id in path")
    return storage.upsert_league_config(config.model_dump())


@app.post("/api/rebuild")
def rebuild(league_id: str | None = None):
    """Rebuild values (all leagues, or one) from live Sleeper and market data."""
    if league_id and not storage.get_league_config(league_id):
        raise HTTPException(404, "League not configured")
    try:
        build.main(["--out", str(DATA_DIR)] + (["--league", league_id] if league_id else []))
    except SystemExit:
        raise HTTPException(502, "Build failed for every league; see server logs")
    return json.loads((DATA_DIR / "index.json").read_text())


class TradeRequest(BaseModel):
    league_id: str
    a: list[str]  # asset ids (Sleeper player ids or pick ids) team A receives
    b: list[str]


@app.post("/api/trade")
def evaluate_trade(req: TradeRequest):
    path = DATA_DIR / f"{req.league_id}.json"
    if not path.exists():
        raise HTTPException(404, "No built data for this league; POST /api/rebuild first")
    data = json.loads(path.read_text())
    assets = {p["id"]: p for p in data["players"] + data["picks"]}
    missing = [i for i in req.a + req.b if i not in assets]
    if missing:
        raise HTTPException(400, f"Unknown asset ids: {missing}")
    side = lambda ids: [{"id": i, "name": assets[i].get("name") or assets[i].get("label"), "value": assets[i]["value"]} for i in ids]
    a, b = side(req.a), side(req.b)
    return {"a": a, "b": b, **trade.evaluate(a, b)}


app.mount("/", StaticFiles(directory=str(SITE_DIR), html=True), name="site")
