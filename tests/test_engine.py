import copy

import pytest

from engine import build, model, trade
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


def test_ktc_parser_reads_embedded_array():
    html = '<script>\nvar playersArray = [{"playerName": "A;]", "superflexValues": {"value": 9}}];var y = [1];</script>'
    assert parse_players_array(html)[0]["playerName"] == "A;]"
    with pytest.raises(ValueError):
        parse_players_array("<html>blocked</html>")


def _build(league, offline, **kw):
    offline(league, **kw)
    config = {"id": "t", "name": "t", "sleeper_league_id": league["league_id"], "buy_in": 50}
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
    assert via[0]["roster_id"] == 5 and "via" in via[0]["label"] and via[0]["value"] > 0
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
