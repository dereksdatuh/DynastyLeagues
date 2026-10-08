"""Completed trades in a league, as moves the site can value with today's numbers."""

from . import sleeper

MAX_TRADES = 60


def recent(league_id: str, legs: range, db: dict, optional) -> list[dict]:
    """Newest completed trades first. Each move is one asset going from one roster to another.

    Players carry their name and position from Sleeper's database so a player who has
    since left every roster still reads right; picks use the site's pick ids.
    """
    rows = []
    for leg in legs:
        got = optional(lambda leg=leg: sleeper.transactions(league_id, leg)) or []
        rows += [t for t in got if t.get("type") == "trade" and t.get("status") == "complete"]
    seen, out = set(), []
    for t in sorted(rows, key=lambda t: t.get("status_updated") or t.get("created") or 0, reverse=True):
        if t.get("transaction_id") in seen:
            continue
        seen.add(t.get("transaction_id"))
        moves = []
        drops = t.get("drops") or {}
        for pid, to in (t.get("adds") or {}).items():
            p = db.get(pid) or {}
            name = p.get("full_name") or " ".join(x for x in (p.get("first_name"), p.get("last_name")) if x) or pid
            moves.append({"kind": "player", "id": pid, "name": name, "pos": p.get("position") or "",
                          "from": drops.get(pid), "to": to})
        for pk in t.get("draft_picks") or []:
            moves.append({"kind": "pick", "id": f"pick:{pk['season']}:{pk['round']}:{pk['roster_id']}",
                          "season": str(pk["season"]), "round": pk["round"], "original_roster_id": pk["roster_id"],
                          "from": pk.get("previous_owner_id"), "to": pk.get("owner_id")})
        for w in t.get("waiver_budget") or []:
            moves.append({"kind": "faab", "id": "faab", "amount": w.get("amount"),
                          "from": w.get("sender"), "to": w.get("receiver")})
        out.append({"id": t.get("transaction_id"), "at": t.get("status_updated") or t.get("created"),
                    "leg": t.get("leg"), "rosters": t.get("roster_ids") or [], "moves": moves})
        if len(out) >= MAX_TRADES:
            break
    return out
