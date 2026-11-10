import pytest

from engine import landing, record, weeks


SLOTS = ["QB", "RB", "WR", "FLEX"]


def P(pid, pos, team, ros, injury=None):
    return {"id": pid, "pos": pos, "team": team, "ros_ppg": ros, "injury": injury, "games": {}}


def test_player_weeks_bye_injury_and_sleeper_window():
    byes = {"KC": [9], "LA": [11]}
    scoring = {"rec": 1, "rec_yd": 0.1}
    up = {8: {"1": {"stats": {"rec": 5, "rec_yd": 50}}}}
    wk = weeks.player_weeks(P("1", "WR", "KC", 12), [8, 9, 10], 8, 12, up, scoring, byes)
    assert wk == {8: 10.0, 9: 0.0, 10: 12}
    # Sleeper's LAR is nflverse's LA.
    assert weeks.player_weeks(P("2", "WR", "LAR", 10), [11, 12], 8, 10, {}, scoring, byes)[11] == 0
    ir = weeks.player_weeks(P("3", "RB", "DET", 20, "IR"), [8, 11, 12, 14], 8, 20, {}, scoring, byes)
    assert ir[8] == ir[11] == 0 and ir[12] == pytest.approx(12) and ir[14] == pytest.approx(15)
    out = weeks.player_weeks(P("4", "RB", "DET", 20, "Out"), [8, 9, 10], 8, 20, up, scoring, byes)
    assert out[8] == 0 and out[9] == pytest.approx(14) and out[10] == pytest.approx(19)


def test_team_weeks_bench_covers_a_bye_and_lists_who_is_out():
    ps = [P("qb", "QB", "KC", 20), P("rb", "RB", "KC", 15), P("wr", "WR", "BUF", 14), P("fx", "WR", "BUF", 12),
          P("bn", "RB", "BUF", 8)]
    wk = {"qb": {9: 0, 10: 20}, "rb": {9: 0, 10: 15}, "wr": {9: 14, 10: 14}, "fx": {9: 12, 10: 12}, "bn": {9: 8, 10: 8}}
    for p in ps:
        p["wk"] = wk[p["id"]]
    tw = weeks.team_weeks(ps, SLOTS, [9, 10])
    assert tw[10]["mean"] == 61 and tw[9]["mean"] == 34  # no QB that week; the bench RB starts
    assert sorted(tw[9]["out"]) == ["qb", "rb"] and tw[10]["out"] == []
    assert tw[10]["sd"] > 0.12 * 61


def test_bye_week_costs_wins_and_pick_odds():
    ppg = {1: 100.0, 2: 100.0, 3: 100.0, 4: 100.0}
    cur = {r: {"wins": 2, "losses": 2, "fpts": 400, "max_pf": 450} for r in ppg}
    sched = {9: [[1, 2], [3, 4]], 10: [[1, 3], [2, 4]]}
    weekly = {r: {9: {"mean": 100, "sd": 18}, 10: {"mean": 100, "sd": 18}} for r in ppg}
    weekly[1][9] = {"mean": 60, "sd": 12}  # team 1 loses three starters to byes in week 9
    flat = record.project(ppg, cur, sched, sigma=20)
    out = record.project(ppg, cur, sched, sigma=20, weekly=weekly)
    assert flat[1]["wins"] == pytest.approx(3)
    assert out[1]["wins"] < 2.6 and out[2]["wins"] > 2.9
    assert out[1]["pf"] == pytest.approx(400 + 160)
    sos = record.strength_of_schedule(ppg, sched, sigma=20, weekly=weekly)
    assert sos[2]["weeks"][0]["opp_ppg"] == 60 and sos[2]["weeks"][0]["win"] > 0.9
    teams = [{"roster_id": r, "ros_ppg": 100.0, "record": cur[r]} for r in ppg]
    counts = landing.simulate(teams, sched, False, 20, "record", 2, None, {}, sims=2000, weekly=weekly, playoff_weeks=[11])
    assert counts[1][0] > counts[2][0]  # more likely to land the 1.01


def test_sim_weeks_adds_playoff_weeks():
    assert weeks.sim_weeks(9, [9, 10, 11, 12, 13, 14], 15, 3) == [9, 10, 11, 12, 13, 14, 15, 16, 17]
    assert weeks.sim_weeks(9, [], 15, 3) == []


def test_build_ships_weekly_lineups_with_byes(offline):
    from tests.test_engine import STANDARD_LEAGUE, _build
    data = _build(STANDARD_LEAGUE, offline)
    sch = data["schedule"]
    assert sch["byes"]["KC"] == [7] and sch["sim_weeks"][0] == 5 and sch["playoff_weeks"]
    i = sch["sim_weeks"].index(7)
    kc = [p for p in data["players"] if p.get("team") == "KC" and p.get("wk")]
    assert kc and all(p["wk"][i] == 0 for p in kc)
    t = data["teams"][0]
    assert [w["week"] for w in t["weekly"]] == sch["sim_weeks"]
    assert any(w["out"] for w in t["weekly"] if w["week"] == 7) or not any(
        data_p.get("team") == "KC" for data_p in data["players"] if data_p.get("roster_id") == t["roster_id"])
