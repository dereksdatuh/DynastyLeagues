"""Draft pick naming, valuation lookup, and ownership."""

import re

TIERS = ("early", "mid", "late")
_ORD = {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5}

_TIERED = re.compile(r"(\d{4})\s+(early|mid|late)?\s*(\d)(?:st|nd|rd|th)", re.I)
_SLOT = re.compile(r"(\d{4})\s+(?:pick|round)?\s*(\d)\.(\d{1,2})", re.I)
_ROUND = re.compile(r"(\d{4})\s+round\s+(\d)", re.I)


def parse_pick(name: str, num_teams: int = 12):
    """'2027 Mid 1st' / '2027 1st' / '2026 Pick 1.05' -> (year, round, tier|None)."""
    name = name or ""
    m = _SLOT.search(name)
    if m:
        year, rnd, slot = int(m.group(1)), int(m.group(2)), int(m.group(3))
        third = max(num_teams / 3, 1)
        tier = "early" if slot <= third else "mid" if slot <= 2 * third else "late"
        return year, rnd, tier
    m = _TIERED.search(name)
    if m:
        tier = m.group(2).lower() if m.group(2) else None
        return int(m.group(1)), int(m.group(3)), tier
    m = _ROUND.search(name)
    if m:
        return int(m.group(1)), int(m.group(2)), None
    return None


def pick_label(year: int, rnd: int, tier: str | None) -> str:
    suffix = {1: "1st", 2: "2nd", 3: "3rd"}.get(rnd, f"{rnd}th")
    return f"{year} {tier.title() + ' ' if tier else ''}{suffix}"


class PickValues:
    """Value lookup for (year, round, tier) built from normalized market pick entries."""

    def __init__(self, entries: list[tuple[int, int, str | None, float]]):
        buckets: dict[tuple, list[float]] = {}
        for year, rnd, tier, value in entries:
            buckets.setdefault((year, rnd, tier), []).append(value)
            if tier:  # tiered values also inform the generic estimate
                buckets.setdefault((year, rnd, "_tiered"), []).append(value)
        self.table = {k: sum(v) / len(v) for k, v in buckets.items()}
        self.years = sorted({k[0] for k in self.table})

    def _generic(self, year: int, rnd: int):
        for key in ((year, rnd, None), (year, rnd, "mid"), (year, rnd, "_tiered")):
            if key in self.table:
                return self.table[key]
        return None

    def value(self, year: int, rnd: int, tier: str | None = None) -> float:
        if not self.years:
            return 0.0
        # Years past what the market quotes are valued like the last quoted year,
        # years before it like the first.
        y = min(max(year, self.years[0]), self.years[-1])
        if tier and (y, rnd, tier) in self.table:
            return self.table[(y, rnd, tier)]
        generic = self._generic(y, rnd)
        if generic is not None:
            if tier and (y, rnd, "mid") in self.table:
                return generic
            return generic * {"early": 1.15, "mid": 1.0, "late": 0.87, None: 1.0}[tier]
        # Unquoted later round: decay from the previous round.
        if rnd > 1:
            return self.value(year, rnd - 1, tier) * 0.45
        return 0.0


def pick_ownership(league: dict, rosters: list, traded: list, current_season: int) -> list[dict]:
    """Every future pick in the league with its original and current owner roster ids."""
    settings = league.get("settings") or {}
    rounds = int(settings.get("draft_rounds") or 4)
    status = league.get("status")
    first_year = int(league.get("season") or current_season)
    if status not in ("pre_draft", "drafting"):
        first_year += 1
    years = [first_year, first_year + 1, first_year + 2]
    roster_ids = [r["roster_id"] for r in rosters]

    owner = {(y, rnd, rid): rid for y in years for rnd in range(1, rounds + 1) for rid in roster_ids}
    for t in traded or []:
        key = (int(t["season"]), int(t["round"]), t["roster_id"])
        if key in owner:
            owner[key] = t["owner_id"]
    return [
        {"year": y, "round": rnd, "original_roster_id": orig, "owner_roster_id": cur}
        for (y, rnd, orig), cur in sorted(owner.items())
    ]
