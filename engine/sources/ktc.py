"""KeepTradeCut: crowdsourced dynasty values scraped from the rankings page."""

import json
import re

from ..fetch import get_text
from ..league import POSITION_GROUP
from ..picks import parse_pick

URL = "https://keeptradecut.com/dynasty-rankings"
_ARRAY = re.compile(r"var\s+playersArray\s*=\s*(\[.*?\]);\s*\n", re.S)


def parse_players_array(html: str) -> list[dict]:
    m = _ARRAY.search(html)
    if not m:
        raise ValueError("playersArray not found on KTC page (layout changed or request blocked)")
    return json.loads(m.group(1))


def _value(row: dict, superflex: bool):
    # Untouched by KTC's TE-premium variants: scoring-fit premiums are applied by
    # the engine itself (engine/valuation.py) for every source alike.
    block = row.get("superflexValues" if superflex else "oneQBValues") or {}
    return block.get("value")


def fetch(fmt, index) -> list[dict]:
    html = get_text(
        f"ktc_dynasty_rankings_{2 if fmt.superflex else 1}",
        URL,
        {"page": 0, "filters": "QB|WR|RB|TE|RDP", "format": 2 if fmt.superflex else 1},
        ttl=6 * 3600,
    )
    rows = parse_players_array(html)
    out = []
    for row in rows:
        name = row.get("playerName") or ""
        value = _value(row, fmt.superflex)
        if not value:
            continue
        if row.get("position") == "RDP":
            pick = parse_pick(name, fmt.num_teams)
            if pick:
                out.append({"source": "ktc", "sleeper_id": None, "name": name, "group": "PICK",
                            "value": float(value), "kind": "pick", "pick": pick, "trend": None})
            continue
        group = POSITION_GROUP.get(row.get("position") or "")
        sid = index.resolve(name, group, source="ktc", ext_id=row.get("playerID"), team=row.get("team"))
        trend = (row.get("superflexValues" if fmt.superflex else "oneQBValues") or {}).get("overallTrend")
        out.append({"source": "ktc", "sleeper_id": sid, "name": name, "group": group,
                    "value": float(value), "kind": "player", "pick": None, "trend": trend})
    return out
