"""Build every configured league's values, rankings, rosters and picks into JSON.

    python -m engine.build                 # all leagues in data/leagues.json -> site/data/
    python -m engine.build --league league-1 --out /tmp/out

This is what the scheduled GitHub Action runs; the static site and the API both
read its output.
"""

import argparse
import json
import os
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

from . import draft, fetch, ids, record, sleeper, valuation, weekly
from .league import SLOT_ELIGIBILITY, format_from_sleeper
from .market import build_consensus
from .picks import PickValues, pick_label, pick_ownership, slot_pick_label
from .sources import SOURCES

ROOT = Path(__file__).resolve().parent.parent
LEAGUES_FILE = ROOT / "data" / "leagues.json"
DEFAULT_OUT = ROOT / "site" / "data"
SITE_URL = os.environ.get("SITE_URL", "https://dereksdatuh.github.io/DynastyLeagues/")


def best_lineup(players: list[dict], slots: list[str], key: str) -> list[dict]:
    """Greedy optimal lineup: most restrictive slots first, best available player by `key`."""
    pool = sorted((p for p in players if (p.get(key) or 0) > 0), key=lambda p: p[key], reverse=True)
    used, lineup = set(), []
    for slot in sorted(slots, key=lambda s: len(SLOT_ELIGIBILITY[s])):
        for p in pool:
            if p["id"] not in used and p["pos"] in SLOT_ELIGIBILITY[slot]:
                used.add(p["id"])
                lineup.append({"slot": slot, "id": p["id"], key: p[key]})
                break
    return lineup


class Shared:
    """Per-run data reused across leagues."""

    def __init__(self):
        self.state = sleeper.nfl_state()
        self.players = sleeper.players()
        try:
            crosswalk = ids.load_crosswalk()
        except Exception as exc:  # name matching still works without it
            print(f"warning: id crosswalk unavailable: {exc}", file=sys.stderr)
            crosswalk = []
        self.index = ids.PlayerIndex(self.players, crosswalk)
        self._stats: dict = {}
        self._espn: dict = {}

    def optional(self, fn):
        """Run a fetch the build can do without; None (with a warning) when it fails."""
        try:
            return fn()
        except Exception as exc:
            print(f"warning: {getattr(fn, '__name__', 'fetch')} failed: {type(exc).__name__}: {exc}"[:300], file=sys.stderr)
            return None

    def devy(self, superflex: bool) -> dict:
        """KeepTradeCut devy rankings for one QB format, fetched once per run."""
        key = ("devy", superflex)
        if key not in self._espn:
            try:
                rows, fields = draft.fetch_devy(superflex)
                classes = {}
                for r in rows:
                    classes[r["class"]] = classes.get(r["class"], 0) + 1
                self._espn[key] = {"ok": True, "players": rows, "fields": fields,
                                   "classes": {str(k): v for k, v in sorted(classes.items(), key=lambda kv: str(kv[0]))}}
            except Exception as exc:
                print(f"warning: KTC devy rankings failed: {exc}"[:300], file=sys.stderr)
                self._espn[key] = {"ok": False, "players": [], "error": f"{type(exc).__name__}: {exc}"[:300]}
        return self._espn[key]

    def espn(self, name: str, *args):
        """ESPN scoreboard / news, fetched once per run; empty when unreachable."""
        if name not in self._espn:
            try:
                self._espn[name] = getattr(weekly, name)(*args)
            except Exception as exc:
                print(f"warning: ESPN {name} failed: {exc}", file=sys.stderr)
                self._espn[name] = {}
        return self._espn[name]

    def stat_tables(self, idp: bool):
        if idp in self._stats:
            return self._stats[idp]
        season = int(self.state.get("league_season") or self.state.get("season"))
        in_season = self.state.get("season_type") in ("regular", "post")
        week = int(self.state.get("week") or 0)

        def safe(fn, *args):
            try:
                return fn(*args)
            except Exception as exc:
                print(f"warning: {fn.__name__}{args} failed: {exc}", file=sys.stderr)
                return {}

        last_week = week - 1 if in_season and week > 1 else None
        tables = {
            "season": season,
            "week_stats": safe(sleeper.week_stats, season, week, idp) if in_season and week else {},
            "last_week": last_week,
            "last_week_stats": safe(sleeper.week_stats, season, last_week, idp) if last_week else {},
            "week": week if in_season else None,
            "proj": safe(sleeper.season_projections, season, idp),
            "week_proj": safe(sleeper.week_projections, season, week, idp) if in_season and week else {},
            "cur": safe(sleeper.season_stats, season, idp) if in_season else {},
            "last": safe(sleeper.season_stats, season - 1, idp),
        }
        self._stats[idp] = tables
        return tables


def season_schedule(lid: str, league: dict, state: dict):
    """Remaining regular-season pairings {week: [[a, b], ...]} (a week Sleeper can't serve
    plays the field), plus the current week's raw matchup rows for the Matchups tab."""
    schedule, current = {}, []
    for week in record.remaining_weeks(league, state):
        try:
            rows = sleeper.matchups(lid, week)
        except Exception as exc:
            print(f"warning: matchups {lid} week {week} failed: {exc}", file=sys.stderr)
            rows = []
        schedule[week] = record.schedule_pairs(rows)
        if week == int(state.get("week") or 0):
            current = rows
    median_game = bool((league.get("settings") or {}).get("league_average_match"))
    return schedule, median_game, current


def week_data(tables, current_rows, fmt, shared, players, owner_of, history) -> dict:
    """Matchups snapshot, NFL game status, players of the week, movers and news."""
    week = tables["week"]
    board = shared.espn("scoreboard", tables["season"], week) if week else {}
    return {
        "week": week,
        "season": tables["season"],
        "matchups": weekly.matchup_snapshot(current_rows),
        "games": weekly.game_status(board),
        "potw": weekly.players_of_week(tables["week_stats"], fmt, shared.players, owner_of) if week else None,
        "last_week": tables["last_week"],
        "potw_last": weekly.players_of_week(tables["last_week_stats"], fmt, shared.players, owner_of)
        if tables["last_week"] else None,
        "movers": weekly.movers(history, players),
        "news": weekly.news_items(shared.espn("espn_news"), shared.players, owner_of),
        "injuries": weekly.injury_report(players, shared.players),
    }


def load_history(league_id: str) -> dict:
    """Value snapshots so far, read back from the published site (the build keeps no state)."""
    try:
        return fetch.get_json(f"history_{league_id}", f"{SITE_URL}data/history/{league_id}.json", ttl=0)
    except Exception as exc:
        print(f"note: no value history for {league_id} yet ({type(exc).__name__}); starting fresh", file=sys.stderr)
        return {}


def build_league(config: dict, shared: Shared, me: str | None = None) -> dict:
    lid = config["sleeper_league_id"]
    me = (me or "").lower()
    league = sleeper.league(lid)
    rosters = sleeper.rosters(lid)
    users = sleeper.users(lid)
    traded = sleeper.traded_picks(lid)
    fmt = format_from_sleeper(league)
    tables = shared.stat_tables(fmt.idp)

    entries, source_status = {}, []
    for name, fetch in SOURCES.items():
        try:
            entries[name] = fetch(fmt, shared.index)
            matched = sum(1 for e in entries[name] if e["kind"] == "player" and e["sleeper_id"])
            total = sum(1 for e in entries[name] if e["kind"] == "player")
            source_status.append({"source": name, "ok": True, "players": total, "matched": matched,
                                  "picks": sum(1 for e in entries[name] if e["kind"] == "pick")})
        except Exception as exc:
            source_status.append({"source": name, "ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]})
    market, pick_entries, mapping = build_consensus(entries)
    for s in source_status:
        s.update(mapping.get(s["source"], {}))

    owner_of = {}
    for r in rosters:
        for pid in r.get("players") or []:
            owner_of[pid] = r["roster_id"]

    players, model_info = valuation.value_players(
        fmt, shared.players, market, tables["proj"], tables["week_proj"], tables["cur"], tables["last"], set(owner_of)
    )
    for p in players:
        p["roster_id"] = owner_of.get(p["id"])
        p["ros_ppg"] = record.ros_ppg(p.get("ppg"), p.get("injury"))
    by_id = {p["id"]: p for p in players}
    history = weekly.update_history(load_history(config["id"]), players)

    users_by_id = {u["user_id"]: u for u in users}
    teams = []
    for r in rosters:
        owner = users_by_id.get(r.get("owner_id"), {})
        roster_players = [by_id[pid] for pid in r.get("players") or [] if pid in by_id]
        st = r.get("settings") or {}
        teams.append({
            "roster_id": r["roster_id"],
            "name": (owner.get("metadata") or {}).get("team_name") or owner.get("display_name") or f"Team {r['roster_id']}",
            "owner": owner.get("display_name"),
            "avatar": owner.get("avatar"),
            "record": {"wins": st.get("wins", 0), "losses": st.get("losses", 0), "ties": st.get("ties", 0),
                       "fpts": st.get("fpts", 0) + (st.get("fpts_decimal", 0) or 0) / 100,
                       # Sleeper's "potential points": best possible lineup each week played.
                       "max_pf": round((st.get("ppts", 0) or 0) + (st.get("ppts_decimal", 0) or 0) / 100, 2)},
            "players": [p["id"] for p in sorted(roster_players, key=lambda p: p["value"], reverse=True)],
            "taxi": r.get("taxi") or [],
            "reserve": r.get("reserve") or [],
            "player_value": sum(p["value"] for p in roster_players),
            "lineup": best_lineup(roster_players, fmt.slots, "value"),
            "week_lineup": best_lineup(roster_players, fmt.slots, "proj_week"),
            "ros_lineup": best_lineup(roster_players, fmt.slots, "ros_ppg"),
            "is_me": bool(me) and me in {(owner.get("display_name") or "").lower(), (owner.get("username") or "").lower()},
        })
    for t in teams:
        t["starter_value"] = round(sum(x["value"] for x in t["lineup"]))
        t["proj_week_points"] = round(sum(x["proj_week"] for x in t["week_lineup"]), 2)
        t["ros_ppg"] = round(sum(x["ros_ppg"] for x in t["ros_lineup"]), 2)
        starters = [by_id[x["id"]] for x in t["lineup"]]
        ages = [(p["age"], p["value"]) for p in starters if p.get("age")]
        t["starter_age"] = round(sum(a * v for a, v in ages) / sum(v for _, v in ages), 1) if ages else None

    schedule, median_game, current_rows = season_schedule(lid, league, shared.state)
    ppg = {t["roster_id"]: t["ros_ppg"] for t in teams}
    sigma = record.sigma_for(ppg)
    projected = record.project(ppg, {t["roster_id"]: t["record"] for t in teams}, schedule, median_game, sigma)
    for t in teams:
        t["projection"] = projected[t["roster_id"]]

    # Next year's draft order, projected under this league's own rule (read off
    # its last rookie draft), sets next year's pick tiers.
    n = len(teams)
    playoff_teams = int((league.get("settings") or {}).get("playoff_teams") or max(n // 2, 1))
    last = shared.optional(lambda: draft.last_rookie_draft(draft.league_chain({**league, "league_id": lid})))
    rule = draft.infer_rule(last["standings"], last["slots"], last["playoff_teams"] or playoff_teams) \
        if last else {"rule": "record", "basis": "default", "matched": None, "of": None}
    # A league can state its own order in data/leagues.json, which beats what the
    # last draft implies: `non_playoff` is "max_pf" or "record", and `playoff_slots`
    # grants the playoff teams fixed slots (champion first).
    stated = config.get("draft_order") or {}
    if stated.get("non_playoff") in ("max_pf", "record"):
        rule = {**rule, "rule": stated["non_playoff"], "basis": "league_rule"}
    playoff_slots = stated.get("playoff_slots")
    if playoff_slots and not draft.valid_playoff_slots(playoff_slots, n, playoff_teams):
        playoff_slots = None
    rule = {**rule, "playoff_slots": playoff_slots}
    order = draft.project_order(teams, rule["rule"], playoff_teams, playoff_slots)
    snake = (last or {}).get("type") == "snake"
    finish_tier = {}
    for i, rid in enumerate(order):
        finish_tier[rid] = "early" if i < n / 3 else "mid" if i < 2 * n / 3 else "late"
    pick_values = PickValues(pick_entries)
    # Team name plus manager, so "via" picks name the person too.
    name_of = {t["roster_id"]: t["name"] + (f", {t['owner']}" if t.get("owner") and t["owner"] != t["name"] else "")
               for t in teams}
    picks = []
    owned = pick_ownership(league, rosters, traded, tables["season"])
    first_year = min((p["year"] for p in owned), default=None)
    for pk in owned:
        first = pk["year"] == first_year
        tier = finish_tier.get(pk["original_roster_id"]) if first else None
        # The coming draft is ordered, so each of its picks is worth what its own
        # projected slot is worth; later years only have a tier to go on.
        slot = draft.slot_in_round(order, pk["round"], pk["original_roster_id"], snake) if first else None
        overall = (pk["round"] - 1) * n + slot if slot else None
        label = slot_pick_label(pk["year"], pk["round"], slot) if slot else pick_label(pk["year"], pk["round"], tier)
        if pk["original_roster_id"] != pk["owner_roster_id"]:
            label += f" (via {name_of.get(pk['original_roster_id'], pk['original_roster_id'])})"
        value = draft.slot_value(pick_values, pk["year"], overall, n) if overall \
            else pick_values.value(pk["year"], pk["round"], tier)
        picks.append({
            "id": f"pick:{pk['year']}:{pk['round']}:{pk['original_roster_id']}",
            "label": label, "year": pk["year"], "round": pk["round"], "tier": tier,
            "slot": slot, "overall": overall, "value": round(value),
            "roster_id": pk["owner_roster_id"], "original_roster_id": pk["original_roster_id"],
        })
    for t in teams:
        t["picks"] = [p["id"] for p in picks if p["roster_id"] == t["roster_id"]]
        t["pick_value"] = sum(p["value"] for p in picks if p["roster_id"] == t["roster_id"])
        t["total_value"] = t["player_value"] + t["pick_value"]

    rookie = None
    if first_year:
        rounds = max(p["round"] for p in picks if p["year"] == first_year)
        devy = shared.devy(fmt.superflex)
        rookie = {
            "year": first_year, "rounds": rounds, "type": "snake" if snake else "linear",
            "playoff_teams": playoff_teams, "rule": rule, "last_draft_season": (last or {}).get("season"),
            "order": order, "board": draft.draft_board(order, picks, first_year, rounds, snake, pick_values),
            "class": draft.rookie_class(devy["players"], first_year, players, pick_values, n, rounds)[: n * rounds + 24]
            if devy["players"] else [],
            "source": {k: v for k, v in devy.items() if k != "players"},
        }

    teams.sort(key=lambda t: t["total_value"], reverse=True)
    starter_rank = {t["roster_id"]: i for i, t in enumerate(sorted(teams, key=lambda t: -t["starter_value"]), 1)}
    for i, t in enumerate(teams, 1):
        t["power_rank"] = i
        t["starter_rank"] = starter_rank[t["roster_id"]]
        sr = t["starter_rank"]
        t["outlook"] = "contender" if sr <= n / 3 else "rebuilding" if sr > 2 * n / 3 else "middle"

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "league": {
            "id": config["id"], "name": league.get("name") or config.get("name"),
            "sleeper_league_id": lid, "season": league.get("season"), "status": league.get("status"),
            "buy_in": config.get("buy_in"), "currency": config.get("currency"),
            "payouts": config.get("payouts"), "notes": config.get("notes"),
            "format": fmt.summary(), "scoring": fmt.scoring, "week": tables["week"],
        },
        "week": week_data(tables, current_rows, fmt, shared, players, owner_of, history),
        "schedule": {"weeks": schedule, "median_game": median_game, "sigma": round(sigma, 2),
                     "sigma_share": record.SIGMA_SHARE},
        "history": history,
        "sources": source_status,
        "model": model_info,
        "players": players,
        "picks": picks,
        "rookie_draft": rookie,
        "teams": teams,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--league", help="id from data/leagues.json (default: all)")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    settings = json.loads(LEAGUES_FILE.read_text())
    configs = settings["leagues"]
    if args.league:
        configs = [c for c in configs if c["id"] == args.league]
    shared = Shared()
    index, failures = [], 0
    for config in configs:
        try:
            data = build_league(config, shared, settings.get("sleeper_username"))
        except Exception:
            failures += 1
            print(f"error: league {config['id']} failed", file=sys.stderr)
            traceback.print_exc()
            continue
        (out / "history").mkdir(exist_ok=True)
        (out / "history" / f"{config['id']}.json").write_text(json.dumps(data.pop("history"), separators=(",", ":")))
        (out / f"{config['id']}.json").write_text(json.dumps(data, separators=(",", ":")))
        lg = data["league"]
        index.append({"id": lg["id"], "name": lg["name"], "season": lg["season"], "format": lg["format"],
                      "buy_in": lg["buy_in"], "teams": len(data["teams"]),
                      "sources": [s for s in data["sources"]], "generated_at": data["generated_at"]})
        ok = [s["source"] for s in data["sources"] if s["ok"]]
        print(f"built {config['id']} ({lg['name']}): {len(data['players'])} players, "
              f"{len(data['picks'])} picks, sources ok: {', '.join(ok) or 'none'}")
        for s in data["sources"]:
            if not s["ok"]:
                print(f"  {s['source']} failed: {s['error']}")
        top = ", ".join(f"{p['name']} {p['pos']} {p['value']}" for p in data["players"][:12])
        print(f"  top: {top}")
        recs = ", ".join(f"{t['name']} {t['projection']['wins']:.1f}-{t['projection']['losses']:.1f}"
                         for t in sorted(data["teams"], key=lambda t: t["projection"]["rank"]))
        wk = data["week"]
        mv = wk["movers"]
        print(f"  week {wk['week']}: {len(wk['matchups'])} matchup rows, {len(wk['games'])} NFL teams with game status, "
              f"{len(wk['news'])} news items, {len(wk['injuries'])} injuries, movers from {mv['source']}, "
              f"top scorer {(wk['potw'] or {}).get('overall', [{}])[0].get('name') if (wk['potw'] or {}).get('overall') else None}, "
              f"last week top {(wk['potw_last'] or {}).get('overall', [{}])[0].get('name') if (wk['potw_last'] or {}).get('overall') else None}")
        print(f"  projected: {recs} ({sum(len(w) for w in data['schedule']['weeks'].values())} scheduled games)")
        rd = data.get("rookie_draft")
        if rd:
            names = {t["roster_id"]: t["name"] for t in data["teams"]}
            src = rd["source"]
            print(f"  {rd['year']} rookie draft: {rd['rounds']} rounds {rd['type']}, order by {rd['rule']} (from {rd['last_draft_season']} draft), "
                  f"first five {[names.get(r) for r in rd['order'][:5]]}; devy source "
                  f"{'ok' if src.get('ok') else 'FAILED ' + str(src.get('error'))}, classes {src.get('classes')}, "
                  f"class size {len(rd['class'])}, top {[(p['name'], p['pos'], p['value']) for p in rd['class'][:6]]}")
            if src.get("fields"):
                print(f"  devy fields: {src['fields']}")
    (out / "index.json").write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "build": (os.environ.get("GITHUB_SHA") or "")[:7] or None, "leagues": index}, indent=1))
    if failures == len(configs):
        sys.exit(1)


if __name__ == "__main__":
    main()
