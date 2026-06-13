import json
import os
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CACHE_DIR = DATA_DIR / "cache"
LEAGUES_FILE = DATA_DIR / "leagues.json"

CACHE_DIR.mkdir(parents=True, exist_ok=True)


def load_leagues() -> dict:
    with open(LEAGUES_FILE, "r") as f:
        return json.load(f)


def save_leagues(data: dict) -> None:
    with open(LEAGUES_FILE, "w") as f:
        json.dump(data, f, indent=2)


def get_league_config(league_id: str) -> dict | None:
    data = load_leagues()
    for league in data.get("leagues", []):
        if league["id"] == league_id:
            return league
    return None


def upsert_league_config(league: dict) -> dict:
    data = load_leagues()
    leagues = data.setdefault("leagues", [])
    for i, existing in enumerate(leagues):
        if existing["id"] == league["id"]:
            leagues[i] = {**existing, **league}
            save_leagues(data)
            return leagues[i]
    leagues.append(league)
    save_leagues(data)
    return league


def cache_path(name: str) -> Path:
    return CACHE_DIR / f"{name}.json"


def read_cache(name: str, max_age_seconds: int) -> dict | list | None:
    path = cache_path(name)
    if not path.exists():
        return None
    if time.time() - path.stat().st_mtime > max_age_seconds:
        return None
    with open(path, "r") as f:
        return json.load(f)


def write_cache(name: str, data) -> None:
    with open(cache_path(name), "w") as f:
        json.dump(data, f)
