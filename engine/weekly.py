"""This week in each league: live matchup snapshot, NFL game status, players of
the week, value risers and fallers, and player news.

The browser refreshes matchups and game status live (site/app.js); what is
built here is the fallback snapshot plus everything that needs a server.
"""

from datetime import datetime, timezone

from .fetch import get_json
from .league import fantasy_points, position_group

ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
# ESPN team abbreviations that differ from Sleeper's.
ESPN_TEAM = {"WSH": "WAS"}
GAME_SECONDS = 3600
HISTORY_DAYS = 21


def scoreboard(season, week) -> dict:
    return get_json(f"espn_scoreboard_{season}_{week}", f"{ESPN}/scoreboard",
                    {"seasontype": 2, "week": week, "dates": season}, ttl=300)


def espn_news(limit: int = 100) -> dict:
    return get_json("espn_news", f"{ESPN}/news", {"limit": limit}, ttl=1800)


def game_status(board: dict) -> dict:
    """NFL team -> {"state": pre|in|post, "left": share of the game still to play, "label", "kickoff"}."""
    out = {}
    for ev in (board or {}).get("events") or []:
        comp = (ev.get("competitions") or [{}])[0]
        st = (comp.get("status") or ev.get("status") or {})
        kind = (st.get("type") or {})
        state = kind.get("state") or "pre"
        if state == "pre":
            left = 1.0
        elif state == "post":
            left = 0.0
        else:
            period, clock = int(st.get("period") or 1), float(st.get("clock") or 0)
            left = max(0.0, min(1.0, ((4 - period) * 900 + clock) / GAME_SECONDS)) if period <= 4 else 0.03
        teams = [ESPN_TEAM.get(c["team"]["abbreviation"], c["team"]["abbreviation"])
                 for c in comp.get("competitors") or [] if c.get("team")]
        for i, team in enumerate(teams):
            out[team] = {"state": state, "left": round(left, 3), "label": kind.get("shortDetail") or "",
                         "kickoff": ev.get("date"), "opp": teams[1 - i] if len(teams) == 2 else None}
    return out


def matchup_snapshot(rows: list) -> list:
    """Sleeper matchup rows trimmed to what the Matchups tab needs."""
    keep = ("roster_id", "matchup_id", "points", "starters", "players_points")
    return [{k: r.get(k) for k in keep} for r in rows or [] if r.get("roster_id") is not None]


def players_of_week(stats: dict, fmt, players_db: dict, owner_of: dict, top: int = 15, per_pos: int = 5) -> dict:
    """Highest scorers in this league's scoring for one week's stat lines."""
    rows = []
    for pid, row in (stats or {}).items():
        info = players_db.get(pid) or {}
        pos = position_group(info)
        if pos not in fmt.positions:
            continue
        pts = fantasy_points(row.get("stats"), fmt.scoring, pos)
        if pts > 0:
            rows.append({"id": pid, "name": info.get("full_name") or pid, "pos": pos, "team": info.get("team"),
                         "pts": round(pts, 2), "roster_id": owner_of.get(pid)})
    rows.sort(key=lambda r: -r["pts"])
    by_pos = {}
    for r in rows:
        if len(by_pos.setdefault(r["pos"], [])) < per_pos:
            by_pos[r["pos"]].append(r)
    return {"overall": rows[:top], "by_position": by_pos}


def update_history(prev: dict | None, players: list, today: str | None = None, keep: int = HISTORY_DAYS) -> dict:
    """Append today's values (one snapshot per UTC day) and drop days older than `keep`."""
    today = today or datetime.now(timezone.utc).date().isoformat()
    days = dict((prev or {}).get("days") or {})
    days[today] = {p["id"]: p["value"] for p in players if p["value"] > 0 and (p.get("roster_id") or p["rank"] <= 600)}
    for d in sorted(days)[:-keep]:
        del days[d]
    return {"days": days}


def movers(history: dict, players: list, days: int = 7, top: int = 15) -> dict:
    """Biggest value changes against the oldest snapshot within `days`; market trend until history exists."""
    snaps = sorted((history or {}).get("days") or {})
    today = snaps[-1] if snaps else None
    base = None
    if today:
        cutoff = datetime.fromisoformat(today).toordinal() - days
        older = [d for d in snaps[:-1] if datetime.fromisoformat(d).toordinal() >= cutoff]
        base = older[0] if older else None
    rows = []
    if base:
        then = history["days"][base]
        for p in players:
            if p["id"] in then and p["value"] > 0:
                change = p["value"] - then[p["id"]]
                rows.append({"id": p["id"], "change": change, "pct": round(change / max(then[p["id"]], 1) * 100, 1),
                             "was": then[p["id"]], "now": p["value"]})
        source = {"kind": "history", "since": base, "days": datetime.fromisoformat(today).toordinal()
                  - datetime.fromisoformat(base).toordinal()}
    else:
        # No week of our own snapshots yet: FantasyCalc's 30-day trend on its scale.
        for p in players:
            if p.get("trend") and p["value"] > 0 and p.get("market"):
                rows.append({"id": p["id"], "change": p["trend"], "pct": round(p["trend"] / max(p["market"] - p["trend"], 1) * 100, 1),
                             "was": None, "now": p["value"]})
        source = {"kind": "market_trend", "days": 30}
    rows = [r for r in rows if r["change"]]
    rising = sorted((r for r in rows if r["change"] > 0), key=lambda r: -r["change"])[:top]
    falling = sorted((r for r in rows if r["change"] < 0), key=lambda r: r["change"])[:top]
    return {"source": source, "risers": rising, "fallers": falling}


def news_items(payload: dict, players_db: dict, owner_of: dict, limit: int = 60) -> list:
    """ESPN headlines that mention a player rostered in this league."""
    by_espn = {str(p["espn_id"]): pid for pid, p in players_db.items() if p.get("espn_id")}
    out = []
    for art in (payload or {}).get("articles") or []:
        ids = []
        for c in art.get("categories") or []:
            aid = c.get("athleteId") or (c.get("athlete") or {}).get("id")
            pid = by_espn.get(str(aid)) if aid else None
            if pid and pid in owner_of and pid not in ids:
                ids.append(pid)
        if not ids:
            continue
        link = ((art.get("links") or {}).get("web") or {}).get("href")
        out.append({"headline": art.get("headline"), "description": art.get("description"),
                    "published": art.get("published"), "url": link, "players": ids})
    out.sort(key=lambda a: a.get("published") or "", reverse=True)
    return out[:limit]


def injury_report(players: list, players_db: dict) -> list:
    """Rostered players carrying an injury designation, freshest news first."""
    out = []
    for p in players:
        info = players_db.get(p["id"]) or {}
        if p.get("roster_id") and info.get("injury_status"):
            out.append({"id": p["id"], "status": info["injury_status"], "body_part": info.get("injury_body_part"),
                        "notes": info.get("injury_notes"), "updated": info.get("news_updated")})
    out.sort(key=lambda r: -(r["updated"] or 0))
    return out
