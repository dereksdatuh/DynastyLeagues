"""Player identity resolution across sources (Sleeper ids are the canonical key)."""

import csv
import io
import re

from .fetch import get_text
from .league import position_group

CROSSWALK_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv"
_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def normalize_name(name: str) -> str:
    name = (name or "").lower().replace("’", "'")
    name = re.sub(r"[.'\-,]", " ", name)
    tokens = [t for t in name.split() if t not in _SUFFIXES]
    return " ".join(tokens)


class PlayerIndex:
    """Looks up Sleeper ids by external id or by (name, position group)."""

    def __init__(self, sleeper_players: dict, crosswalk_rows: list[dict] | None = None):
        self.players = sleeper_players
        self.by_name: dict[tuple, list[str]] = {}
        for pid, p in sleeper_players.items():
            group = position_group(p)
            name = p.get("full_name") or f"{p.get('first_name', '')} {p.get('last_name', '')}"
            if not group or not name.strip():
                continue
            self.by_name.setdefault((normalize_name(name), group), []).append(pid)
        self.external: dict[str, dict[str, str]] = {"fantasypros": {}, "ktc": {}, "mfl": {}}
        for row in crosswalk_rows or []:
            sid = (row.get("sleeper_id") or "").strip()
            if not sid or sid == "NA":
                continue
            for src, col in (("fantasypros", "fantasypros_id"), ("ktc", "ktc_id"), ("mfl", "mfl_id")):
                ext = (row.get(col) or "").strip()
                if ext and ext != "NA":
                    self.external[src][ext] = sid

    def resolve(self, name: str, group: str | None, source: str | None = None, ext_id=None, team=None):
        if source and ext_id is not None:
            sid = self.external.get(source, {}).get(str(ext_id))
            if sid:
                return sid
        if not group:
            return None
        candidates = self.by_name.get((normalize_name(name), group), [])
        if len(candidates) == 1:
            return candidates[0]
        if len(candidates) > 1:
            # Prefer the active player on the named team, then the most relevant one.
            on_team = [c for c in candidates if team and self.players[c].get("team") == team]
            pool = on_team or candidates
            pool.sort(key=lambda c: self.players[c].get("search_rank") or 10**9)
            return pool[0]
        return None


def load_crosswalk() -> list[dict]:
    text = get_text("dp_playerids", CROSSWALK_URL, ttl=24 * 3600)
    return list(csv.DictReader(io.StringIO(text)))
