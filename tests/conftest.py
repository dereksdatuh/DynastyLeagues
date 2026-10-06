"""Offline fixtures: a synthetic NFL player pool and fake responses for every source."""

import json
import random
from types import SimpleNamespace

import pytest

from engine import fetch

# Real roster/scoring settings from league-1 ("IDPs Most Wanted"): 14-team SF, TEP, IDP.
IDP_LEAGUE = {
    "league_id": "L1",
    "name": "IDPs Most Wanted",
    "season": "2026",
    "status": "in_season",
    "total_rosters": 14,
    "roster_positions": ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "FLEX", "SUPER_FLEX",
                         "DL", "DL", "LB", "LB", "DB", "DB", "IDP_FLEX", "IDP_FLEX", "IDP_FLEX", "IDP_FLEX"]
    + ["BN"] * 20,
    "settings": {"taxi_slots": 4, "reserve_slots": 5, "type": 2, "draft_rounds": 4},
    "scoring_settings": {
        "pass_yd": 0.04, "pass_td": 6.0, "pass_int": -1.0, "pass_2pt": 2.0, "rush_yd": 0.1, "rush_td": 6.0,
        "rush_att": 0.15, "rush_fd": 0.15, "rec": 1.0, "rec_yd": 0.1, "rec_td": 6.0, "bonus_rec_te": 1.0,
        "bonus_rec_rb": 0.25, "fum_lost": -2.0, "idp_tkl_solo": 2.0, "idp_tkl_ast": 1.0, "idp_sack": 5.0,
        "idp_int": 6.0, "idp_pass_def": 3.0, "idp_ff": 3.0, "idp_tkl_loss": 2.0, "idp_qb_hit": 1.5,
    },
}

STANDARD_LEAGUE = {
    "league_id": "L2",
    "name": "Plain 12 Team",
    "season": "2026",
    "status": "in_season",
    "total_rosters": 12,
    "roster_positions": ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"] + ["BN"] * 15,
    "settings": {"draft_rounds": 4},
    "scoring_settings": {"pass_yd": 0.04, "pass_td": 4.0, "pass_int": -1.0, "rush_yd": 0.1, "rush_td": 6.0,
                         "rec": 1.0, "rec_yd": 0.1, "rec_td": 6.0, "fum_lost": -2.0},
}

COUNTS = {"QB": 50, "RB": 90, "WR": 120, "TE": 50, "DE": 60, "LB": 70, "CB": 60, "S": 50}
NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet"]


def _stats(pos: str, q: float, rng: random.Random, games: float) -> dict:
    """Plausible per-season stat line for quality q in (0,1]."""
    g = games
    if pos == "QB":
        s = {"pass_yd": 4300 * q, "pass_td": 32 * q, "pass_int": 10, "rush_yd": 450 * q * rng.random(),
             "rush_att": 70 * q, "rush_td": 4 * q, "rush_fd": 20 * q}
    elif pos == "RB":
        s = {"rush_yd": 1300 * q, "rush_att": 280 * q, "rush_td": 11 * q, "rush_fd": 65 * q,
             "rec": 50 * q * rng.random(), "rec_yd": 400 * q, "rec_td": 2 * q}
        s["bonus_rec_rb"] = s["rec"]
    elif pos == "WR":
        s = {"rec": 105 * q, "rec_yd": 1400 * q, "rec_td": 10 * q}
    elif pos == "TE":
        s = {"rec": 85 * q, "rec_yd": 950 * q, "rec_td": 7 * q}
        s["bonus_rec_te"] = s["rec"]
    elif pos in ("DE",):
        s = {"idp_tkl_solo": 35 * q, "idp_tkl_ast": 15 * q, "idp_sack": 12 * q, "idp_qb_hit": 25 * q,
             "idp_tkl_loss": 14 * q, "idp_ff": 3 * q}
    elif pos == "LB":
        s = {"idp_tkl_solo": 95 * q, "idp_tkl_ast": 50 * q, "idp_sack": 4 * q, "idp_pass_def": 5 * q,
             "idp_tkl_loss": 9 * q}
    else:  # CB / S
        s = {"idp_tkl_solo": 65 * q, "idp_tkl_ast": 20 * q, "idp_int": 3 * q, "idp_pass_def": 11 * q}
    s = {k: round(v * g / 17, 2) for k, v in s.items()}
    s["gp"] = g
    return s


def make_world(seed: int = 7):
    rng = random.Random(seed)
    players, proj, last, cur = {}, {}, {}, {}
    pid = 1000
    for pos, n in COUNTS.items():
        for i in range(n):
            pid += 1
            q = max(0.05, 1 - i / n) ** 1.3
            age = rng.randint(21, 33)
            name = f"{NAMES[i % 10]} {pos}{i}"
            fp = {"DE": ["DL"], "LB": ["LB"], "CB": ["DB"], "S": ["DB"]}.get(pos, [pos])
            players[str(pid)] = {"player_id": str(pid), "full_name": name, "first_name": name.split()[0],
                                 "last_name": name.split()[1], "position": pos, "fantasy_positions": fp,
                                 "team": "KC" if pid % 2 else "BUF", "age": age, "years_exp": max(0, age - 22),
                                 "search_rank": i + 1, "espn_id": 9000 + pid,
                                 "injury_status": "Questionable" if pid % 37 == 0 else None,
                                 "injury_body_part": "Hamstring" if pid % 37 == 0 else None, "news_updated": pid}
            proj[str(pid)] = {"player_id": str(pid), "stats": _stats(pos, q, rng, 17)}
            last[str(pid)] = {"player_id": str(pid), "stats": _stats(pos, q * rng.uniform(0.8, 1.2), rng, 15)}
            cur[str(pid)] = {"player_id": str(pid), "stats": _stats(pos, q * rng.uniform(0.8, 1.2), rng, 4)}
    offense = [p for p in players.values() if p["position"] in ("QB", "RB", "WR", "TE")]
    return SimpleNamespace(rng=rng, players=players, proj=proj, last=last, cur=cur, offense=offense)


def _market_value(p, world, superflex, curve):
    st = world.proj[p["player_id"]]["stats"]
    base = st.get("pass_yd", 0) * 0.04 + st.get("pass_td", 0) * 4 + st.get("rush_yd", 0) * 0.1 \
        + st.get("rush_td", 0) * 6 + st.get("rec", 0) + st.get("rec_yd", 0) * 0.1 + st.get("rec_td", 0) * 6
    if p["position"] == "QB":
        base *= 1.6 if superflex else 0.8
    youth = 1 + (27 - p["age"]) * 0.06
    return max(1, round(curve(base * youth)))


def fake_responses(world, league):
    """Map URL fragments to fake payloads the way each real service shapes them."""
    rosters = []
    offense = sorted(world.offense, key=lambda p: -world.proj[p["player_id"]]["stats"]["gp"])
    pool = list(world.players)
    world.rng.shuffle(pool)
    per = 28
    for r in range(league["total_rosters"]):
        rosters.append({"roster_id": r + 1, "owner_id": f"u{r + 1}", "players": pool[r * per:(r + 1) * per],
                        "settings": {"wins": r % 4, "losses": 4 - r % 4, "ties": 0, "fpts": 400 + r, "ppts": 480 + r, "ppts_decimal": 50}})
    users = [{"user_id": f"u{r + 1}", "display_name": "DS107" if r == 0 else f"owner{r + 1}",
              "metadata": {"team_name": f"Team {r + 1}"}} for r in range(league["total_rosters"])]
    # Round-robin schedule: Sleeper returns future weeks with matchup_id set and no points.
    n = league["total_rosters"]
    order = list(range(1, n + 1))
    schedule = {}
    for week in range(1, 18):
        rows = [{"roster_id": order[i], "matchup_id": i + 1, "points": 0} for i in range(n // 2)]
        rows += [{"roster_id": order[n - 1 - i], "matchup_id": i + 1, "points": 0} for i in range(n // 2)]
        if week == 5:  # the current week: starters and points so far
            for r in rows:
                mine = rosters[r["roster_id"] - 1]["players"]
                r["starters"] = mine[:8]
                r["players_points"] = {pid: (int(pid) % 7) * 1.5 for pid in mine}
                r["points"] = sum(r["players_points"][pid] for pid in mine[:8])
        schedule[f"/league/{league['league_id']}/matchups/{week}"] = rows
        order = [order[0], order[-1]] + order[1:-1]
    traded = [{"season": "2027", "round": 1, "roster_id": 2, "previous_owner_id": 2, "owner_id": 5}]

    fc, ktc, dp = [], [], []
    for p in offense:
        fc_v = _market_value(p, world, True, lambda x: x * 26)
        fc.append({"player": {"id": 1, "name": p["full_name"], "sleeperId": p["player_id"], "position": p["position"],
                              "maybeTeam": "KC", "maybeAge": p["age"]}, "value": fc_v, "trend30Day": 10})
        ktc_v = _market_value(p, world, True, lambda x: 1500 + x * 14)
        ktc.append({"playerName": p["full_name"], "playerID": 1, "position": p["position"], "team": "KC",
                    "oneQBValues": {"value": ktc_v}, "superflexValues": {"value": ktc_v, "overallTrend": 3}})
        dp.append(f'"{p["full_name"]}","{p["position"]}","KC",{p["age"]},2022,1,1,1,{fc_v},{fc_v},"2026-10-02",""')
    for year, base in ((2027, 7000), (2028, 6000)):
        for rnd, mult in ((1, 1), (2, 0.4)):
            fc.append({"player": {"name": f"{year} {['', '1st', '2nd'][rnd]}", "position": "PICK"},
                       "value": base * mult})
            for tier, tm in (("Early", 1.2), ("Mid", 1.0), ("Late", 0.85)):
                ktc.append({"playerName": f"{year} {tier} {['', '1st', '2nd'][rnd]}", "position": "RDP",
                            "superflexValues": {"value": 1500 + base * mult * tm * 0.55},
                            "oneQBValues": {"value": 1500 + base * mult * tm * 0.55}})
    ktc_html = "<html><script>\nvar playersArray = " + json.dumps(ktc) + ";\nvar x = 1;</script></html>"
    # 2027 and 2028 college classes, best first, as KTC's devy page embeds them.
    devy = [{"playerName": f"Prospect {i}", "playerID": 5000 + i, "position": ["QB", "RB", "WR", "TE"][i % 4],
             "team": "Texas", "age": 20, "draftYear": 2027 if i % 3 else 2028,
             "superflexValues": {"value": 9000 - i * 120, "rank": i + 1}, "oneQBValues": {"value": 8500 - i * 120}}
            for i in range(60)]
    devy_html = "<html><script>\nvar playersArray = " + json.dumps(devy) + ";</script></html>"
    # Last season (league P1): roster 1 has the worst record but roster 2 the lowest max PF, and so on;
    # the 2026 rookie draft was seeded by lowest max PF.
    prev = [{"roster_id": r + 1, "settings": {"wins": r, "losses": 13 - r, "fpts": 1500 + r,
                                               "ppts": 1800 + ((r + 1) % n) * 10}} for r in range(n)]
    by_max_pf = sorted(prev, key=lambda x: x["settings"]["ppts"])
    last_draft = [{"draft_id": "D1", "season": "2026", "status": "complete", "type": "linear", "settings": {"rounds": 4},
                   "slot_to_roster_id": {str(i + 1): r["roster_id"] for i, r in enumerate(by_max_pf)}}]
    dp_csv = '"player","pos","team","age","draft_year","ecr_1qb","ecr_2qb","ecr_pos","value_1qb","value_2qb","scrape_date","fp_id"\n' + "\n".join(dp)
    lid = league["league_id"]
    return {
        "/state/nfl": {"season": "2026", "league_season": "2026", "week": 5, "season_type": "regular"},
        f"/league/{lid}/rosters": rosters,
        f"/league/{lid}/users": users,
        f"/league/{lid}/traded_picks": traded,
        f"/league/{lid}": {**league, "previous_league_id": "P1"},
        f"/league/{lid}/drafts": last_draft,
        "/league/P1/rosters": prev,
        "keeptradecut.com/devy-rankings": devy_html,
        **schedule,
        "/players/nfl": world.players,
        "/projections/nfl/2026/5": list(world.proj.values()),
        "/projections/nfl/2026": list(world.proj.values()),
        "/stats/nfl/2026": list(world.cur.values()),
        "/stats/nfl/2026/5": [{"player_id": k, "stats": {kk: vv / 4 for kk, vv in v["stats"].items()}} for k, v in list(world.cur.items())[:200]],
        "/stats/nfl/2026/4": [{"player_id": k, "stats": {kk: vv / 4 for kk, vv in v["stats"].items()}} for k, v in world.cur.items()],
        "espn.com/apis/site/v2/sports/football/nfl/scoreboard": {"events": [{
            "date": "2026-10-05T17:00Z",
            "competitions": [{"status": {"period": 3, "clock": 450, "type": {"state": "in", "shortDetail": "7:30 - 3rd"}},
                              "competitors": [{"team": {"abbreviation": "KC"}}, {"team": {"abbreviation": "WSH"}}]}]}]},
        "espn.com/apis/site/v2/sports/football/nfl/news": {"articles": [
            {"headline": f"News about {world.players[pid]['full_name']}", "published": f"2026-10-0{1 + i % 5}T12:00:00Z",
             "categories": [{"type": "athlete", "athleteId": 9000 + int(pid)}], "links": {"web": {"href": f"https://example.com/{pid}"}}}
            for i, pid in enumerate(list(world.players)[:40])] + [{"headline": "League-wide story", "categories": []}]},
        "/stats/nfl/2025": list(world.last.values()),
        "fantasycalc": fc,
        "keeptradecut": ktc_html,
        "values.csv": dp_csv,
        "db_playerids": "sleeper_id,fantasypros_id,ktc_id,mfl_id\n",
    }


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload
        self.text = payload if isinstance(payload, str) else json.dumps(payload)

    def json(self):
        return self.payload if not isinstance(self.payload, str) else json.loads(self.payload)


@pytest.fixture
def offline(monkeypatch, tmp_path):
    """Route all engine HTTP through a fake for the given league; returns a setter."""
    monkeypatch.setattr(fetch, "CACHE_DIR", tmp_path / "cache")

    def install(league, world=None, fail=()):
        world = world or make_world()
        responses = fake_responses(world, league)

        def transport(url, params):
            for frag in fail:
                if frag in url:
                    raise RuntimeError(f"blocked: {url}")
            # Longest fragment first so /league/X/rosters beats /league/X.
            for frag in sorted(responses, key=len, reverse=True):
                if frag in url:
                    return FakeResponse(responses[frag])
            raise AssertionError(f"unexpected url {url}")

        monkeypatch.setattr(fetch, "TRANSPORT", transport)
        return world

    return install
