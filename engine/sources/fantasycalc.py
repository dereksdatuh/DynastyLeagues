"""FantasyCalc: crowd trade-based dynasty values, queried for the league's exact shape."""

from ..fetch import get_json
from ..league import POSITION_GROUP
from ..picks import parse_pick

URL = "https://api.fantasycalc.com/values/current"


def fetch(fmt, index) -> list[dict]:
    params = {"isDynasty": "true", "numQbs": fmt.num_qbs, "numTeams": fmt.num_teams, "ppr": fmt.ppr}
    rows = get_json(f"fantasycalc_{fmt.num_teams}_{fmt.num_qbs}_{fmt.ppr}", URL, params, ttl=6 * 3600)
    out = []
    for row in rows:
        p = row.get("player") or {}
        name = p.get("name") or ""
        value = float(row.get("value") or 0)
        if p.get("position") == "PICK":
            pick = parse_pick(name, fmt.num_teams)
            if pick:
                out.append({"source": "fantasycalc", "sleeper_id": None, "name": name, "group": "PICK",
                            "value": value, "kind": "pick", "pick": pick, "trend": None})
            continue
        group = POSITION_GROUP.get(p.get("position") or "")
        sid = str(p["sleeperId"]) if p.get("sleeperId") else index.resolve(name, group, team=p.get("maybeTeam"))
        out.append({"source": "fantasycalc", "sleeper_id": sid, "name": name, "group": group,
                    "value": value, "kind": "player", "pick": None, "trend": row.get("trend30Day")})
    return out
