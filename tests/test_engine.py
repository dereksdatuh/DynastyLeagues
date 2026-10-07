import copy

import pytest

from engine import build, model, outlook, trade
from engine.league import fantasy_points, format_from_sleeper
from engine.market import QuantileMap, build_consensus
from engine.picks import PickValues, parse_pick, pick_ownership
from engine.sources.ktc import parse_players_array

from .conftest import IDP_LEAGUE, STANDARD_LEAGUE


def test_format_reads_superflex_tep_and_idp():
    fmt = format_from_sleeper(IDP_LEAGUE)
    assert fmt.num_teams == 14
    assert fmt.superflex and fmt.num_qbs == 2
    assert fmt.te_premium == 1.0 and fmt.ppr == 1.0
    assert fmt.idp
    assert len(fmt.slots) == 20 and "BN" not in fmt.slots
    assert format_from_sleeper(STANDARD_LEAGUE).idp is False


def test_points_use_exact_league_scoring():
    scoring = IDP_LEAGUE["scoring_settings"]
    qb = {"pass_yd": 300, "pass_td": 2, "rush_att": 4, "rush_yd": 20}
    assert fantasy_points(qb, scoring, "QB") == pytest.approx(12 + 12 + 0.6 + 2)
    te = {"rec": 6, "rec_yd": 60, "bonus_rec_te": 6}
    assert fantasy_points(te, scoring, "TE") == pytest.approx(6 + 6 + 6)
    # Bonus derived from receptions when the stat line lacks it.
    assert fantasy_points({"rec": 6, "rec_yd": 60}, scoring, "TE") == pytest.approx(18)
    lb = {"idp_tkl_solo": 8, "idp_tkl_ast": 3, "idp_sack": 1}
    assert fantasy_points(lb, scoring, "LB") == pytest.approx(16 + 3 + 5)


def test_replacement_level_fills_flex_with_best_remaining():
    fmt = format_from_sleeper(STANDARD_LEAGUE)
    fmt.num_teams = 2
    pools = {"QB": [20, 18, 15], "RB": [15, 14, 13, 12, 11, 10], "WR": [16, 9, 8, 7, 6, 5], "TE": [10, 4, 3]}
    repl, taken = model.replacement_levels(pools, fmt)
    # 2 teams: RB 4 + WR 4 + TE 2 dedicated, 2 FLEX go to RB 11 and RB 10 (beat WR 6).
    assert taken == {"QB": 2, "RB": 6, "WR": 4, "TE": 2}
    assert repl["QB"] == 15 and repl["WR"] == pytest.approx((6 + 5) / 2)


def test_age_curve_penalizes_old_running_backs_more_than_quarterbacks():
    assert model.age_multiplier("RB", 28, 2) < model.age_multiplier("QB", 28, 2)
    assert model.age_multiplier("WR", 22, 2) > 1


def test_quantile_map_is_monotone_and_matches_ranks():
    qm = QuantileMap([100, 50, 10], [9000, 4000, 500])
    assert qm(100) == 9000 and qm(50) == 4000 and qm(10) == 500
    assert qm(75) == pytest.approx(6500)
    assert qm(5) < qm(10) < qm(60) < qm(200)


def test_consensus_rescales_flatter_source_onto_reference():
    fc = [{"kind": "player", "sleeper_id": str(i), "value": 10000 - i * 90, "pick": None} for i in range(60)]
    ktc = [{"kind": "player", "sleeper_id": str(i), "value": 3000 + (60 - i) * 50, "pick": None} for i in range(60)]
    combined, _, report = build_consensus({"fantasycalc": fc, "ktc": ktc})
    assert report["ktc"]["shared_with_reference"] == 60
    for i in (0, 30, 59):
        assert combined[str(i)]["ktc"] == pytest.approx(combined[str(i)]["fantasycalc"], abs=2)


@pytest.mark.parametrize("name,expected", [
    ("2027 Mid 1st", (2027, 1, "mid")),
    ("2027 1st", (2027, 1, None)),
    ("2026 Pick 1.02", (2026, 1, "early")),
    ("2026 Pick 2.11", (2026, 2, "late")),
    ("2028 Late 3rd", (2028, 3, "late")),
])
def test_parse_pick(name, expected):
    assert parse_pick(name, 12) == expected


def test_pick_values_fall_back_sensibly():
    pv = PickValues([(2027, 1, "early", 6000), (2027, 1, "mid", 5000), (2027, 1, "late", 4000), (2027, 2, None, 2000)])
    assert pv.value(2027, 1, "early") == 6000
    assert pv.value(2027, 1, None) == 5000
    assert pv.value(2029, 1, "mid") == 5000  # beyond quoted years -> last quoted year
    assert pv.value(2027, 3, None) == pytest.approx(900)


def test_pick_ownership_applies_trades():
    rosters = [{"roster_id": 1}, {"roster_id": 2}]
    traded = [{"season": "2027", "round": 1, "roster_id": 2, "owner_id": 1}]
    picks = pick_ownership(IDP_LEAGUE, rosters, traded, 2026)
    assert {p["year"] for p in picks} == {2027, 2028, 2029}
    moved = [p for p in picks if p["year"] == 2027 and p["round"] == 1 and p["original_roster_id"] == 2]
    assert moved[0]["owner_roster_id"] == 1


def test_trade_consolidation_premium():
    two_for_one = trade.evaluate([{"value": 6000}], [{"value": 3000}, {"value": 3000}])
    assert two_for_one["raw"]["a"] == two_for_one["raw"]["b"]
    assert two_for_one["verdict"] == "side A receives more"
    needed = two_for_one["to_balance"]["add_value"]
    fixed = trade.evaluate([{"value": 6000}], [{"value": 3000}, {"value": 3000}, {"value": needed}])
    assert fixed["verdict"] == "fair" and abs(fixed["difference_pct"]) < 0.5
    assert trade.evaluate([{"value": 5000}], [{"value": 4900}])["verdict"] == "fair"


def test_many_mid_pieces_do_not_read_even_for_fewer_better_ones():
    # A real 2026-10-06 leg: three for five, the five worth 18% more raw. It must
    # not read as fair, and the adjusted totals stay near the raw ones.
    three = [{"value": v} for v in (4911, 1903, 1846)]
    five = [{"value": v} for v in (1389, 3709, 930, 2812, 1385)]
    r = trade.evaluate(three, five)
    assert r["verdict"] == "side B receives more" and r["difference_pct"] < -5
    assert r["effective"]["b"] >= 0.8 * r["raw"]["b"]


def test_ktc_parser_reads_embedded_array():
    html = '<script>\nvar playersArray = [{"playerName": "A;]", "superflexValues": {"value": 9}}];var y = [1];</script>'
    assert parse_players_array(html)[0]["playerName"] == "A;]"
    with pytest.raises(ValueError):
        parse_players_array("<html>blocked</html>")


def _build(league, offline, config_extra=None, **kw):
    offline(league, **kw)
    config = {"id": "t", "name": "t", "sleeper_league_id": league["league_id"], "buy_in": 50, **(config_extra or {})}
    return build.build_league(config, build.Shared())


def test_full_build_idp_league(offline):
    data = _build(IDP_LEAGUE, offline)
    players = data["players"]
    assert all(s["ok"] for s in data["sources"])
    assert {p["pos"] for p in players} >= {"QB", "RB", "WR", "TE", "DL", "LB", "DB"}
    # IDP has no market value anywhere, so its value comes from the calibrated model.
    idp = [p for p in players if p["pos"] in ("DL", "LB", "DB")]
    assert idp and all(p["market"] == 0 for p in idp) and max(p["value"] for p in idp) > 0
    assert [p["rank"] for p in players] == list(range(1, len(players) + 1))
    assert all(players[i]["value"] >= players[i + 1]["value"] for i in range(len(players) - 1))
    # Every rostered player appears, with owner attached.
    rostered = {pid for t in data["teams"] for pid in t["players"]}
    assert rostered and all(p["roster_id"] for p in players if p["id"] in rostered)
    assert len(data["teams"]) == 14 and data["teams"][0]["power_rank"] == 1
    for t in data["teams"]:
        ids = [x["id"] for x in t["lineup"]]
        assert 10 <= len(ids) <= 20 and len(set(ids)) == len(ids) and set(ids) <= set(t["players"])
    assert all(t["proj_week_points"] > 0 for t in data["teams"])
    # Traded pick shows up with its new owner and a "via" label.
    via = [p for p in data["picks"] if p["original_roster_id"] == 2 and p["year"] == 2027 and p["round"] == 1]
    assert via[0]["roster_id"] == 5 and via[0]["value"] > 0
    assert via[0]["label"].endswith("(via Team 2, owner2)")  # team and manager
    assert data["league"]["week"] == 5


def test_te_premium_raises_tes_relative_to_standard(offline):
    tep = _build(IDP_LEAGUE, offline)
    std_league = copy.deepcopy(IDP_LEAGUE)
    std_league["league_id"] = "L1-no-tep"
    std_league["scoring_settings"]["bonus_rec_te"] = 0
    std = _build(std_league, offline)

    def te_share(data):
        top = sorted(data["players"], key=lambda p: -p["value"])[:150]
        return sum(p["value"] for p in top if p["pos"] == "TE") / sum(p["value"] for p in top)

    assert te_share(tep) > te_share(std)


def test_build_survives_a_blocked_market_source(offline):
    data = _build(STANDARD_LEAGUE, offline, fail=("keeptradecut",))
    status = {s["source"]: s for s in data["sources"]}
    assert status["ktc"]["ok"] is False and "blocked" in status["ktc"]["error"]
    assert status["fantasycalc"]["ok"] and data["players"][0]["value"] > 0
    assert not any(p["pos"] in ("DL", "LB", "DB") for p in data["players"] if p["roster_id"] is None)


def test_ktc_parser_finds_renamed_array():
    html = '<script>window.__DATA__ = {"rankings": [{"playerName": "B", "superflexValues": {"value": 5}}]};</script>'
    assert parse_players_array(html)[0]["playerName"] == "B"


def test_three_team_trade_nets_and_balance():
    # A sends 6000 to B; B sends 3000 to C; C sends 3000 to A.
    teams = [
        {"name": "A", "gets": [3000], "gives": [6000]},
        {"name": "B", "gets": [6000], "gives": [3000]},
        {"name": "C", "gets": [3000], "gives": [3000]},
    ]
    res = trade.evaluate_multi(teams)
    nets = {t["name"]: t["net_pct"] for t in res["teams"]}
    assert nets["A"] == -50 and nets["B"] == 50 and nets["C"] == 0
    assert res["verdict"] == "uneven"
    assert res["to_balance"]["receiver"] == "A" and res["to_balance"]["sender"] == "B"
    assert res["to_balance"]["add_value"] > 3000
    # Two-team results match the original calculator.
    two = trade.evaluate_multi([{"name": "A", "gets": [5000], "gives": [4900]}, {"name": "B", "gets": [4900], "gives": [5000]}])
    assert two["verdict"] == "fair"


def test_win_probability_and_projected_record():
    from engine import record
    assert record.win_prob(100, 100, 20) == pytest.approx(0.5)
    assert record.win_prob(120, 100, 20) == pytest.approx(0.760, abs=0.002)  # Φ(20 / (20·√2))
    ppg = {1: 130.0, 2: 100.0, 3: 100.0, 4: 70.0}
    schedule = {5: [[1, 4], [2, 3]], 6: [[1, 2], [3, 4]], 7: []}  # week 7 has no pairing: play the field
    cur = {r: {"wins": 2, "losses": 2, "ties": 0} for r in ppg}
    out = record.project(ppg, cur, schedule, sigma=20)
    assert all(o["remaining_games"] == 3 for o in out.values())
    assert out[1]["rank"] == 1 and out[4]["rank"] == 4
    assert out[2]["wins"] == pytest.approx(2 + 0.5 + record.win_prob(100, 130, 20) + record.vs_field(2, ppg, 20), abs=0.01)
    # Expected wins across the league add up to games played.
    assert sum(o["remaining_wins"] for o in out.values()) == pytest.approx(6, abs=0.02)
    med = record.project(ppg, cur, schedule, median_game=True, sigma=20)
    assert med[1]["remaining_games"] == 6 and med[1]["wins"] > out[1]["wins"]


def test_schedule_pairs_and_remaining_weeks():
    from engine import record
    rows = [{"roster_id": 1, "matchup_id": 2}, {"roster_id": 3, "matchup_id": 2}, {"roster_id": 2, "matchup_id": None}]
    assert record.schedule_pairs(rows) == [[1, 3]]
    lg = {"season": "2026", "status": "in_season", "settings": {"playoff_week_start": 15}}
    assert record.remaining_weeks(lg, {"season": "2026", "week": 5, "season_type": "regular"}) == list(range(5, 15))
    assert record.remaining_weeks({**lg, "status": "pre_draft", "season": "2027"}, {"season": "2026", "week": 5}) == list(range(1, 15))
    assert record.remaining_weeks({**lg, "status": "complete"}, {}) == []


def test_build_projects_records_from_schedule(offline):
    data = _build(STANDARD_LEAGUE, offline)
    weeks = data["schedule"]["weeks"]
    assert list(weeks) == list(range(5, 15)) and all(len(w) == 6 for w in weeks.values())
    teams = data["teams"]
    assert sorted(t["projection"]["rank"] for t in teams) == list(range(1, 13))
    for t in teams:
        pr = t["projection"]
        assert pr["remaining_games"] == 10 and t["ros_ppg"] > 0
        assert pr["wins"] + pr["losses"] == pytest.approx(t["record"]["wins"] + t["record"]["losses"] + 10)
    assert sum(t["projection"]["remaining_wins"] for t in teams) == pytest.approx(60, abs=0.1)
    best = max(teams, key=lambda t: t["ros_ppg"])
    assert best["projection"]["remaining_wins"] > 5
    assert [t["is_me"] for t in teams].count(True) == 0  # no username passed
    mine = build.build_league({"id": "t", "name": "t", "sleeper_league_id": "L2"}, build.Shared(), "ds107")
    assert [t["owner"] for t in mine["teams"] if t["is_me"]] == ["DS107"]


def test_projected_max_pf_adds_best_lineup_for_each_week_left(offline):
    from engine import record
    ppg = {1: 130.0, 2: 100.0}
    cur = {1: {"wins": 1, "losses": 1, "max_pf": 300.0}, 2: {"wins": 1, "losses": 1, "max_pf": 320.0}}
    out = record.project(ppg, cur, {5: [[1, 2]], 6: [[1, 2]]}, median_game=True, sigma=20)
    # Two weeks left; the median game adds a result, not points.
    assert out[1]["max_pf"] == pytest.approx(560) and out[2]["max_pf"] == pytest.approx(520)
    assert out[1]["max_pf_rank"] == 1
    data = _build(STANDARD_LEAGUE, offline)
    for t in data["teams"]:
        assert t["record"]["max_pf"] == pytest.approx(480.5 + t["roster_id"] - 1)
        assert t["projection"]["max_pf"] == pytest.approx(t["record"]["max_pf"] + t["ros_ppg"] * 10, abs=0.1)
    assert sorted(t["projection"]["max_pf_rank"] for t in data["teams"]) == list(range(1, 13))


def test_game_status_reads_espn_clock():
    from engine import weekly
    board = {"events": [
        {"competitions": [{"status": {"period": 3, "clock": 450, "type": {"state": "in"}},
                           "competitors": [{"team": {"abbreviation": "KC"}}, {"team": {"abbreviation": "WSH"}}]}]},
        {"competitions": [{"status": {"type": {"state": "post"}},
                           "competitors": [{"team": {"abbreviation": "BUF"}}, {"team": {"abbreviation": "MIA"}}]}]},
    ]}
    g = weekly.game_status(board)
    assert g["KC"]["left"] == pytest.approx((900 + 450) / 3600, abs=0.001) and g["WAS"]["opp"] == "KC"
    assert g["BUF"]["left"] == 0 and g["MIA"]["state"] == "post"


def test_history_and_movers():
    from engine import weekly
    players = [{"id": "a", "value": 5000, "rank": 1, "roster_id": 1, "trend": 300, "market": 5100},
               {"id": "b", "value": 3000, "rank": 2, "roster_id": None, "trend": -200, "market": 3000}]
    fresh = weekly.update_history({}, players, today="2026-10-05")
    mv = weekly.movers(fresh, players)
    assert mv["source"]["kind"] == "market_trend" and mv["risers"][0]["id"] == "a" and mv["fallers"][0]["id"] == "b"
    old = {"days": {"2026-09-27": {"a": 1}, "2026-09-29": {"a": 4000, "b": 3500}, "2026-10-04": {"a": 4900}}}
    hist = weekly.update_history(old, players, today="2026-10-05", keep=3)
    assert sorted(hist["days"]) == ["2026-09-29", "2026-10-04", "2026-10-05"]
    mv = weekly.movers(hist, players)
    assert mv["source"] == {"kind": "history", "since": "2026-09-29", "days": 6}
    assert mv["risers"][0] == {"id": "a", "change": 1000, "pct": 25.0, "was": 4000, "now": 5000}
    assert mv["fallers"][0]["id"] == "b" and mv["fallers"][0]["change"] == -500


def test_build_week_data(offline):
    data = _build(STANDARD_LEAGUE, offline)
    wk = data["week"]
    assert wk["week"] == 5 and len(wk["matchups"]) == 12 and all(m["starters"] for m in wk["matchups"])
    assert wk["games"]["WAS"]["state"] == "in" and wk["games"]["KC"]["left"] > 0
    assert wk["potw"]["overall"] and wk["last_week"] == 4 and wk["potw_last"]["overall"][0]["pts"] > 0
    pts = [r["pts"] for r in wk["potw_last"]["overall"]]
    assert pts == sorted(pts, reverse=True) and set(wk["potw_last"]["by_position"]) <= {"QB", "RB", "WR", "TE"}
    rostered = {pid for t in data["teams"] for pid in t["players"]}
    assert wk["news"] and all(set(n["players"]) <= rostered for n in wk["news"])
    assert all(i["status"] == "Questionable" for i in wk["injuries"])
    assert wk["movers"]["source"]["kind"] == "market_trend" and wk["movers"]["risers"]
    assert data["history"]["days"]


def test_rookie_draft_order_rule_board_and_class(offline):
    data = _build(STANDARD_LEAGUE, offline)
    rd = data["rookie_draft"]
    # The last draft matched lowest max PF, not worst record, so that rule is used.
    assert rd["rule"]["rule"] == "max_pf" and rd["rule"]["max_pf_matched"] > rd["rule"]["record_matched"]
    teams = {t["roster_id"]: t for t in data["teams"]}
    playoff = rd["playoff_teams"]
    out = rd["order"][: len(teams) - playoff]
    assert [teams[r]["projection"]["max_pf"] for r in out] == sorted(teams[r]["projection"]["max_pf"] for r in out)
    # Every non-playoff team projects to miss the playoffs.
    assert all(teams[r]["projection"]["rank"] > playoff for r in out)
    # Board: one pick per team per round; a traded pick shows its new holder.
    assert rd["year"] == 2027 and len(rd["board"]) == len(teams) * rd["rounds"]
    traded = next(b for b in rd["board"] if b["round"] == 1 and b["original_roster_id"] == 2)
    assert traded["roster_id"] == 5 and traded["label"].startswith("1.")
    # Each of next year's picks is named and valued by its own projected slot, so
    # two first-rounders at different slots are no longer worth the same.
    firsts = [p for p in data["picks"] if p["year"] == 2027 and p["round"] == 1]
    assert len(firsts) == len(teams)
    by_slot = {p["slot"]: p for p in firsts}
    assert sorted(by_slot) == list(range(1, len(teams) + 1))
    assert by_slot[1]["label"].startswith("2027 1.01") and by_slot[1]["tier"] == "early"
    assert [by_slot[s]["value"] for s in sorted(by_slot)] == sorted((p["value"] for p in firsts), reverse=True)
    assert by_slot[1]["value"] > by_slot[2]["value"] > by_slot[len(teams)]["value"]
    # Two years out there is no order to read yet, so those picks keep a round-wide value.
    later = [p for p in data["picks"] if p["year"] > 2028 and p["round"] == 1]
    assert later and len({p["value"] for p in later}) == 1 and all(p["slot"] is None for p in later)
    # Class: only 2027 prospects, on the league's value scale, best first.
    cls = rd["class"]
    assert cls and all(p["class"] == 2027 for p in cls) and rd["source"]["ok"]
    vals = [p["value"] for p in cls]
    assert vals == sorted(vals, reverse=True) and 0 < vals[0] < data["players"][0]["value"]


def test_league_stated_draft_order_grants_playoff_teams_fixed_slots(offline):
    """Ultimate Dynasty's rule: playoff teams take stated slots, champion picking last."""
    slots = [12, 11, 9, 10, 7, 8]
    data = _build(STANDARD_LEAGUE, offline,
                  config_extra={"draft_order": {"non_playoff": "max_pf", "playoff_slots": slots}})
    rd = data["rookie_draft"]
    teams = {t["roster_id"]: t for t in data["teams"]}
    assert rd["rule"]["basis"] == "league_rule" and rd["rule"]["playoff_slots"] == slots
    seeded = sorted(teams.values(), key=lambda t: (-t["projection"]["wins"], -t["projection"]["ppg"]))
    for place, t in enumerate(seeded[: rd["playoff_teams"]]):
        assert rd["order"][slots[place] - 1] == t["roster_id"]
    # The non-playoff teams fill what is left, lowest max PF first.
    rest = [r for i, r in enumerate(rd["order"], 1) if i not in slots]
    assert [teams[r]["projection"]["max_pf"] for r in rest] == sorted(teams[r]["projection"]["max_pf"] for r in rest)


def test_stated_playoff_slots_are_ignored_when_unusable(offline):
    data = _build(STANDARD_LEAGUE, offline,
                  config_extra={"draft_order": {"playoff_slots": [12, 12, 99]}})
    rd = data["rookie_draft"]
    assert rd["rule"]["playoff_slots"] is None and len(set(rd["order"])) == len(data["teams"])


def test_class_blends_slot_and_ktc_devy_and_lifts_picks(offline, monkeypatch):
    # Pin one prospect to his position's current #1, as data/prospects.json does for Jeremiah Smith.
    monkeypatch.setattr(build, "prospect_overrides", lambda: [{"name": "Prospect 10", "pos_rank": 1}])
    data = _build(STANDARD_LEAGUE, offline)
    rd = data["rookie_draft"]
    cls = rd["class"]
    w = rd["class_weight"]
    assert w["slot"] == 0.5 and w["ktc_devy"] == 0.5
    priced = [p for p in cls if not p.get("pinned")]
    assert all(abs(p["value"] - (0.5 * p["slot_part"] + 0.5 * p["ktc_part"])) <= 1 for p in priced)
    pinned = next(p for p in cls if p["name"] == "Prospect 10")
    best_at_pos = max(p["value"] for p in data["players"] if p["pos"] == pinned["pos"])
    assert pinned["pinned"] == f"{pinned['pos']}1" and pinned["value"] == best_at_pos
    # The coming draft's picks carry the class: the 1.01 is priced from the market's
    # 1.01 and the best prospect, so it moves with the class, not just the market.
    first = next(p for p in data["picks"] if p["year"] == rd["year"] and p["round"] == 1 and p["slot"] == 1)
    board_101 = next(b for b in rd["board"] if b["overall"] == 1)
    assert board_101["slot_value"] == first["value"]
    assert first["value"] > 0.5 * cls[0]["value"]


def test_team_values_tankers_prize_early_picks_contenders_discount_them(offline):
    data = _build(STANDARD_LEAGUE, offline)
    tv = data["team_values"]
    ctx, fac = tv["context"]["teams"], tv["factors"]
    rd = data["rookie_draft"]
    firsts = sorted((p for p in data["picks"] if p["year"] == rd["year"] and p["round"] == 1), key=lambda p: p["slot"])
    tank = min(ctx, key=lambda r: ctx[r]["mode"])
    contend = max(ctx, key=lambda r: ctx[r]["mode"])
    assert ctx[tank]["label"] == "tanking" and ctx[contend]["label"] == "contending"
    f = lambda rid, pid: fac[rid].get(pid, 1.0)
    early, late = firsts[0]["id"], firsts[-1]["id"]
    assert f(tank, early) > f(tank, late) > 1 > f(contend, early)
    # Every team's multipliers stay inside the clamp.
    assert all(0.8 <= v <= 1.25 for row in fac.values() for v in row.values())


def test_superflex_team_short_at_qb_pays_more_for_a_starting_qb():
    from engine import team_value
    slots = ["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX"]
    qbs = [{"id": f"q{i}", "pos": "QB", "value": 8000 - i * 500, "ros_ppg": 24 - i, "age": 26} for i in range(8)]
    skill = [{"id": f"{pos}{t}", "pos": pos, "value": 3000, "ros_ppg": 12, "age": 26}
             for t in range(3) for pos in ("RB", "WR", "TE", "WR2")]
    for p in skill:
        p["pos"] = p["pos"].rstrip("2")
    by_id = {p["id"]: p for p in qbs + skill}
    team = lambda rid, roster: {"roster_id": rid, "players": roster, "starter_rank": rid, "lineup": [],
                                "projection": {"rank": rid, "max_pf": 1500 + rid}}
    teams = [
        team(1, ["q1", "q2", "q3", "RB0", "WR0", "TE0", "WR20"]),  # three starting QBs
        team(2, ["q5", "RB1", "WR1", "TE1", "WR21"]),              # one
        team(3, ["q6", "q7", "RB2", "WR2", "TE2", "WR22"]),       # none startable
    ]
    for t in teams:
        t["lineup"] = [{"id": i} for i in t["players"]]
    ctx = team_value.contexts(teams, by_id, slots, superflex=True)
    have = {rid: c["qb"]["startable"] for rid, c in ctx["teams"].items()}
    assert have[1] > have[2] > have[3]
    fac = team_value.factors(teams, list(by_id.values()), [], slots, ctx, None)
    starter = "q0"  # the best QB, on nobody's roster in this sketch
    assert fac[3].get(starter, 1) > fac[2].get(starter, 1) > fac[1].get(starter, 1)


def test_next_season_ages_players_and_regresses_stars():
    lv = {"RB": 15.0, "QB": 20.0}
    old_rb = {"pos": "RB", "age": 30, "ppg": 18.0}
    young_wr = {"pos": "WR", "age": 21, "ppg": 12.0}
    vet_qb = {"pos": "QB", "age": 28, "ppg": 24.0}
    assert outlook.next_ppg(old_rb, lv) < 18.0 * 0.85          # an aging back fades
    assert outlook.next_ppg(young_wr, lv) > 12.0                # a young receiver grows
    assert 20.0 < outlook.next_ppg(vet_qb, lv) < 24.0           # a star regresses toward a starter
    assert outlook.next_ppg({"pos": "QB", "age": 25, "ppg": None}, lv) == 0.0


def test_expected_slots_keep_a_clear_tanker_on_top_and_spread_the_middle():
    strength = {1: 60.0, 2: 150.0, 3: 152.0, 4: 154.0, 5: 156.0, 6: 158.0,
                7: 160.0, 8: 162.0, 9: 164.0, 10: 166.0, 11: 168.0, 12: 170.0}
    exp = outlook.expected_slots(strength, "max_pf", 6, None, False, 1, lambda o: 100.0 - o)
    assert exp[(1, 1)]["slot"] < 1.05                          # far weaker: almost always 1.01
    mid = exp[(1, 6)]["slot"]
    assert 3 < mid < 10                                         # close pack: spread across slots
    assert exp[(1, 1)]["value"] > exp[(1, 6)]["value"] > exp[(1, 12)]["value"]


def test_draft_after_next_is_priced_by_projected_strength(offline):
    data = _build(STANDARD_LEAGUE, offline)
    nd = data["next_draft"]
    assert nd and nd["year"] == 2028 and len(nd["teams"]) == len(data["teams"])
    weakest, strongest = nd["teams"][0], nd["teams"][-1]
    assert weakest["ppg"] <= strongest["ppg"] and weakest["first_slot"] < strongest["first_slot"]
    firsts = {p["original_roster_id"]: p for p in data["picks"] if p["year"] == 2028 and p["round"] == 1}
    assert firsts[weakest["roster_id"]]["value"] > firsts[strongest["roster_id"]]["value"]
    assert all(p.get("proj_slot") for p in firsts.values())
    # Ordered by expected slot, values fall; a team's first is worth more than its second.
    by_slot = sorted(firsts.values(), key=lambda p: p["proj_slot"])
    vals = [p["value"] for p in by_slot]
    assert vals[0] == max(vals) and vals[-1] == min(vals)
    seconds = {p["original_roster_id"]: p for p in data["picks"] if p["year"] == 2028 and p["round"] == 2}
    assert all(firsts[r]["value"] > seconds[r]["value"] for r in firsts)
    # Teams holding coming-draft picks get those rookies in next season's roster.
    assert any(t["rookies"] for t in nd["teams"])
