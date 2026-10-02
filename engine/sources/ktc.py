"""KeepTradeCut: crowdsourced dynasty values scraped from the rankings page."""

import json
import re

from ..fetch import get_text
from ..league import POSITION_GROUP
from ..picks import parse_pick

URL = "https://keeptradecut.com/dynasty-rankings"
_ARRAY = re.compile(r"playersArray\s*=\s*\[")
_TITLE = re.compile(r"<title>(.*?)</title>", re.S | re.I)


def _decode_list_at(html: str, i: int):
    try:
        rows, _ = json.JSONDecoder().raw_decode(html, i)
    except ValueError:
        return None
    if isinstance(rows, list) and rows and isinstance(rows[0], dict) and "playerName" in rows[0]:
        return rows
    return None


def parse_players_array(html: str) -> list[dict]:
    """The rankings page embeds every player as a JSON array in a script tag."""
    m = _ARRAY.search(html)
    if m:
        rows = _decode_list_at(html, m.end() - 1)
        if rows:
            return rows
    # Variable renamed: find the first player object and back up to its array.
    key = html.find('"playerName"')
    if key != -1:
        for i in range(key, max(key - 400, 0), -1):
            if html[i] == "[":
                rows = _decode_list_at(html, i)
                if rows:
                    return rows
    title = _TITLE.search(html)
    hint = title.group(1).strip()[:80] if title else html[:80].replace("\n", " ")
    ctx = html[max(key - 120, 0): key + 80].replace("\n", " ") if key != -1 else ""
    raise ValueError(f"player array not found on KTC page ({len(html)} bytes, title: {hint!r}, near: {ctx!r})")


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
