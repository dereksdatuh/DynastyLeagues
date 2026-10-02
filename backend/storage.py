import json
from pathlib import Path

LEAGUES_FILE = Path(__file__).resolve().parent.parent / "data" / "leagues.json"


def load_leagues() -> dict:
    return json.loads(LEAGUES_FILE.read_text())


def save_leagues(data: dict) -> None:
    LEAGUES_FILE.write_text(json.dumps(data, indent=2) + "\n")


def get_league_config(league_id: str) -> dict | None:
    return next((lg for lg in load_leagues().get("leagues", []) if lg["id"] == league_id), None)


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
