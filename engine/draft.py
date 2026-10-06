"""Next year's rookie draft: projected order, who holds each pick, and the class.

Order: Sleeper doesn't publish how a league seeds its rookie draft, so it is
read off the league's last rookie draft. Its non-playoff slots are compared
with last season's standings (worst record first) and with last season's max PF
(lowest potential points first); whichever matches is the league's rule. The
coming draft is then projected from this season's projected records and max PF.
Playoff teams follow, weakest projected record first.

Class: KeepTradeCut's devy rankings (college players), in this league's QB
format, filtered to the draft class. A prospect's value is what the market pays
for the pick where he ranks (from this league's pick values), adjusted for how
this league's scoring and lineup treat his position.
"""

import re
from statistics import median

from .fetch import get_json, get_text
from .league import POSITION_GROUP
from .sources.ktc import parse_players_array

V1 = "https://api.sleeper.app/v1"
DEVY_URL = "https://keeptradecut.com/devy-rankings"
CLASS_KEYS = ("draftYear", "draftClass", "draft_year", "devyYear", "class", "year", "eligibleYear", "draftEligibleYear")
POSITIONS = ("QB", "RB", "WR", "TE")


# ---------- order ----------

def drafts(league_id: str) -> list:
    return get_json(f"sleeper_drafts_{league_id}", f"{V1}/league/{league_id}/drafts", ttl=6 * 3600)


def previous_rosters(league: dict) -> list:
    prev = league.get("previous_league_id")
    if not prev or prev == "0":
        return []
    return get_json(f"sleeper_rosters_{prev}", f"{V1}/league/{prev}/rosters", ttl=24 * 3600)


def _num(st: dict, key: str) -> float:
    return (st.get(key) or 0) + (st.get(f"{key}_decimal") or 0) / 100


def last_rookie_draft(league: dict, rosters: list, all_drafts: list) -> dict | None:
    """The league's most recent completed draft as {slot: roster_id}, with its type and rounds."""
    done = [d for d in all_drafts or [] if d.get("status") == "complete"]
    if not done:
        return None
    d = max(done, key=lambda d: (str(d.get("season")), d.get("start_time") or 0))
    slots = {int(k): int(v) for k, v in (d.get("slot_to_roster_id") or {}).items() if v}
    if not slots and d.get("draft_order"):
        roster_of_user = {r.get("owner_id"): r["roster_id"] for r in rosters}
        slots = {int(s): roster_of_user[u] for u, s in d["draft_order"].items() if u in roster_of_user}
    if not slots:
        return None
    return {"season": str(d.get("season")), "type": d.get("type") or "linear",
            "rounds": int((d.get("settings") or {}).get("rounds") or 0), "slots": slots}


def infer_rule(prev_rosters: list, slots: dict, playoff_teams: int) -> dict:
    """Which of worst-record-first or lowest-max-PF-first explains the last draft's non-playoff slots."""
    stats = {r["roster_id"]: r.get("settings") or {} for r in prev_rosters}
    n_out = max(len(slots) - playoff_teams, 0)
    actual = [slots[s] for s in sorted(slots)][:n_out]
    if not actual or not all(rid in stats for rid in actual):
        return {"rule": "record", "basis": "default", "matched": None, "of": n_out}
    by_record = sorted(stats, key=lambda r: (stats[r].get("wins", 0) - stats[r].get("losses", 0), _num(stats[r], "fpts")))
    by_max_pf = sorted(stats, key=lambda r: _num(stats[r], "ppts"))
    pool = set(actual)
    rec = [r for r in by_record if r in pool]
    mpf = [r for r in by_max_pf if r in pool]
    score = lambda order: sum(a == b for a, b in zip(order, actual))
    s_rec, s_mpf = score(rec), score(mpf)
    rule = "max_pf" if s_mpf > s_rec else "record"
    return {"rule": rule, "basis": "last_draft", "matched": max(s_rec, s_mpf), "of": n_out,
            "record_matched": s_rec, "max_pf_matched": s_mpf}


def project_order(teams: list, rule: str, playoff_teams: int) -> list:
    """Roster ids in projected draft order for one round (pick 1 first)."""
    standing = sorted(teams, key=lambda t: (-t["projection"]["wins"], -t["projection"]["ppg"]))
    playoff = standing[:playoff_teams]
    out = standing[playoff_teams:]
    if rule == "max_pf":
        out.sort(key=lambda t: t["projection"]["max_pf"])
    else:
        out.sort(key=lambda t: (t["projection"]["wins"], t["projection"]["max_pf"]))
    playoff.sort(key=lambda t: (t["projection"]["wins"], t["projection"]["ppg"]))
    return [t["roster_id"] for t in out + playoff]


def slot_label(rnd: int, slot: int) -> str:
    return f"{rnd}.{slot:02d}"


def draft_board(order: list, picks: list, year: int, rounds: int, snake: bool, pick_values=None) -> list:
    """Every pick of `year` in projected order, with its current holder."""
    held = {(p["round"], p["original_roster_id"]): p for p in picks if p["year"] == year}
    n = len(order)
    board = []
    for rnd in range(1, rounds + 1):
        seq = order[::-1] if snake and rnd % 2 == 0 else order
        for i, orig in enumerate(seq, 1):
            pk = held.get((rnd, orig))
            board.append({"overall": (rnd - 1) * n + i, "round": rnd, "slot": i, "label": slot_label(rnd, i),
                          "original_roster_id": orig, "roster_id": pk["roster_id"] if pk else orig,
                          "pick_id": pk["id"] if pk else None, "pick_value": pk["value"] if pk else 0,
                          "slot_value": round(slot_value(pick_values, year, (rnd - 1) * n + i, n)) if pick_values else None})
    return board


# ---------- class ----------

def _class_year(row: dict):
    for k in CLASS_KEYS:
        v = row.get(k)
        if v not in (None, ""):
            m = re.search(r"20\d\d", str(v))
            if m:
                return int(m.group())
    for k, v in row.items():  # unknown field name: any 20xx-looking draft year
        if isinstance(v, (int, str)) and re.fullmatch(r"20(2[6-9]|3\d)", str(v)) and "age" not in k.lower():
            return int(v)
    return None


def fetch_devy(superflex: bool) -> tuple[list[dict], list[str]]:
    """(prospects best first, field names KTC used) for one QB format."""
    html = get_text(f"ktc_devy_{2 if superflex else 1}", DEVY_URL,
                    {"page": 0, "filters": "QB|WR|RB|TE", "format": 2 if superflex else 1}, ttl=6 * 3600)
    rows = parse_players_array(html)
    out = []
    for row in rows:
        block = row.get("superflexValues" if superflex else "oneQBValues") or {}
        if not block.get("value"):
            continue
        out.append({"name": row.get("playerName"), "pos": POSITION_GROUP.get(row.get("position") or "", row.get("position")),
                    "school": row.get("team") or row.get("college") or row.get("school"),
                    "age": row.get("age"), "class": _class_year(row), "ktc": float(block["value"]),
                    "ktc_rank": block.get("rank"), "ktc_pos_rank": block.get("positionalRank"),
                    "trend": block.get("overallTrend")})
    out.sort(key=lambda p: -p["ktc"])
    return out, sorted(rows[0].keys()) if rows else []


def position_factors(players: list) -> dict:
    """How this league values each position relative to the market (scoring, lineup, TE premium)."""
    out = {}
    for pos in POSITIONS:
        rows = sorted((p for p in players if p["pos"] == pos and p.get("market")), key=lambda p: -p["market"])[:24]
        # Square root: a prospect is a bet on the position, not yet on a proven fit.
        out[pos] = median(p["value"] / p["market"] for p in rows) ** 0.5 if len(rows) >= 5 else 1.0
    mean = sum(out.values()) / len(out)
    return {k: round(v / mean, 3) for k, v in out.items()}


def slot_value(pick_values, year: int, overall: int, n: int) -> float:
    """Market value of the overall-th pick, interpolated between early/mid/late round values."""
    rnd, s = (overall - 1) // n + 1, (overall - 1) % n + 1
    centers = [(n / 6, "early"), (n / 2, "mid"), (5 * n / 6, "late")]
    pts = [(c + (rnd - 1) * n, pick_values.value(year, rnd, t)) for c, t in centers]
    nxt = pick_values.value(year, rnd + 1, "early") if rnd < 5 else pts[-1][1] * 0.6
    pts.append((rnd * n + n / 6, nxt))
    x = overall
    if x <= pts[0][0]:
        prev = pick_values.value(year, rnd - 1, "late") if rnd > 1 else pts[0][1] * 1.15
        x0, y0 = pts[0][0] - n / 3, prev
        return y0 + (pts[0][1] - y0) * (x - x0) / (pts[0][0] - x0)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return pts[-1][1]


def rookie_class(devy: list, year: int, players: list, pick_values, n: int, rounds: int) -> list:
    """The draft class on this league's value scale, best first."""
    factors = position_factors(players)
    pool = [p for p in devy if p["class"] == year] or [p for p in devy if p["class"] is None]
    total = n * max(rounds, 1)
    out = []
    for i, p in enumerate(pool, 1):
        base = slot_value(pick_values, year, i, n) if i <= total else slot_value(pick_values, year, total, n) * 0.92 ** ((i - total) / n)
        out.append({**p, "class_rank": i, "value": round(base * factors.get(p["pos"], 1.0)),
                    "factor": factors.get(p["pos"], 1.0)})
    out.sort(key=lambda p: -p["value"])
    return out
