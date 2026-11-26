"""site/outlook.json: researched 2027-29 roles the future lineups read."""
import json
from pathlib import Path

ROLES = {"elite", "lead", "starter", "flex", "backup", "none"}


def test_outlook_roles_are_valid():
    data = json.loads((Path(__file__).resolve().parents[1] / "site" / "outlook.json").read_text())
    players = data["players"]
    assert players
    names = set()
    for p in players:
        assert p["pos"] in {"QB", "RB", "WR", "TE"}, p["name"]
        assert set(p["roles"]) <= {"2027", "2028", "2029"}, p["name"]
        assert set(p["roles"].values()) <= ROLES, p["name"]
        assert p["boom_role"] in ROLES and p["bust_role"] in ROLES, p["name"]
        assert p["name"] not in names, f"duplicate {p['name']}"
        names.add(p["name"])
