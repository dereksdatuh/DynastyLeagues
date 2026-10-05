"""Build every configured league's values, rankings, rosters and picks into JSON.

    python -m engine.build                 # all leagues in data/leagues.json -> site/data/
    python -m engine.build --league league-1 --out /tmp/out

This is what the scheduled GitHub Action runs; the static site and the API both
read its output.
"""

import argparse
import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

from . import ids, record, sleeper, valuation
from .league import SLOT_ELIGIBILITY, format_from_sleeper
from .market import build_consensus
from .picks import PickValues, pick_label, pick_ownership
from .sources import SOURCES

ROOT = Path(__file__).resolve().parent.parent
LEAGUES_FILE = ROOT / "data" / "leagues.json"
DEFAULT_OUT = ROOT / "site" / "data"


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

        tables = {
            "season": season,
            "week": week if in_season else None,
            "proj": safe(sleeper.season_projections, season, idp),
            "week_proj": safe(sleeper.week_projections, season, week, idp) if in_season and week else {},
            "cur": safe(sleeper.season_stats, season, idp) if in_season else {},
            "last": safe(sleeper.season_stats, season - 1, idp),
        }
        self._stats[idp] = tables
        return tables


def season_schedule(lid: str, league: dict, state: dict):
    """Remaining regular-season pairings {week: [[a, b], ...]}; a week Sleeper can't serve plays the field."""
    schedule = {}
    for week in record.remaining_weeks(league, state):
        try:
            schedule[week] = record.schedule_pairs(sleeper.matchups(lid, week))
        except Exception as exc:
            print(f"warning: matchups {lid} week {week} failed: {exc}", file=sys.stderr)
            schedule[week] = []
    median_game = bool((league.get("settings") or {}).get("league_average_match"))
    return schedule, median_game


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

    schedule, median_game = season_schedule(lid, league, shared.state)
    ppg = {t["roster_id"]: t["ros_ppg"] for t in teams}
    sigma = record.sigma_for(ppg)
    projected = record.project(ppg, {t["roster_id"]: t["record"] for t in teams}, schedule, median_game, sigma)
    for t in teams:
        t["projection"] = projected[t["roster_id"]]

    # Projected finish (weakest lineup picks first) sets next year's pick tiers.
    n = len(teams)
    weakest_first = sorted(teams, key=lambda t: t["starter_value"])
    finish_tier = {}
    for i, t in enumerate(weakest_first):
        finish_tier[t["roster_id"]] = "early" if i < n / 3 else "mid" if i < 2 * n / 3 else "late"
    pick_values = PickValues(pick_entries)
    name_of = {t["roster_id"]: t["name"] for t in teams}
    picks = []
    owned = pick_ownership(league, rosters, traded, tables["season"])
    first_year = min((p["year"] for p in owned), default=None)
    for pk in owned:
        tier = finish_tier.get(pk["original_roster_id"]) if pk["year"] == first_year else None
        label = pick_label(pk["year"], pk["round"], tier)
        if pk["original_roster_id"] != pk["owner_roster_id"]:
            label += f" (via {name_of.get(pk['original_roster_id'], pk['original_roster_id'])})"
        picks.append({
            "id": f"pick:{pk['year']}:{pk['round']}:{pk['original_roster_id']}",
            "label": label, "year": pk["year"], "round": pk["round"], "tier": tier,
            "value": round(pick_values.value(pk["year"], pk["round"], tier)),
            "roster_id": pk["owner_roster_id"], "original_roster_id": pk["original_roster_id"],
        })
    for t in teams:
        t["picks"] = [p["id"] for p in picks if p["roster_id"] == t["roster_id"]]
        t["pick_value"] = sum(p["value"] for p in picks if p["roster_id"] == t["roster_id"])
        t["total_value"] = t["player_value"] + t["pick_value"]

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
        "schedule": {"weeks": schedule, "median_game": median_game, "sigma": round(sigma, 2),
                     "sigma_share": record.SIGMA_SHARE},
        "sources": source_status,
        "model": model_info,
        "players": players,
        "picks": picks,
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
        print(f"  projected: {recs} ({sum(len(w) for w in data['schedule']['weeks'].values())} scheduled games)")
    (out / "index.json").write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "leagues": index}, indent=1))
    if failures == len(configs):
        sys.exit(1)


if __name__ == "__main__":
    main()
