"""Combine market consensus and the league production model into final values."""

from statistics import median

from . import model
from .league import LeagueFormat, fantasy_points, position_group
from .market import SOURCE_WEIGHTS, QuantileMap, RatioMap, _top_mean

MODEL_WEIGHT = 0.4  # share of final value from the production model when both exist
PLAYER_PREMIUM_EXPONENT = 0.75  # player's scoring fit vs. others at his position
POSITION_PREMIUM_EXPONENT = 0.5  # position's scoring fit vs. offense overall (TEP, 6pt pass TD)
PREMIUM_CLAMP = (0.7, 1.4)
OFFENSE = {"QB", "RB", "WR", "TE"}
# Positions no market source prices are discounted from pure production value:
# they trade at a discount in practice (deep waiver pools, volatile scoring).
UNPRICED_DISCOUNT = {"DL": 0.7, "LB": 0.7, "DB": 0.6, "K": 0.3, "DEF": 0.3}


def _sites_avg(mkt: dict) -> int | None:
    raw = [mkt[f"{k}_raw"] for k in SOURCE_WEIGHTS if f"{k}_raw" in mkt]
    return round(sum(raw) / len(raw)) if raw else None


def assign_tiers(players: list[dict], key: str = "value") -> None:
    """Break tiers at natural drop-offs: a big gap to the next player or a long slide."""
    tier, tier_top, prev = 1, None, None
    for p in players:
        v = p[key]
        if prev is not None and v > 0:
            gap = (prev - v) / prev if prev else 0
            slide = (tier_top - v) / tier_top if tier_top else 0
            if gap > 0.04 or slide > 0.2:
                tier += 1
                tier_top = v
        if tier_top is None:
            tier_top = v
        p["tier"] = tier
        prev = v


def rank(players: list[dict]) -> None:
    players.sort(key=lambda p: p["value"], reverse=True)
    pos_count: dict[str, int] = {}
    for i, p in enumerate(players, 1):
        p["rank"] = i
        pos_count[p["pos"]] = pos_count.get(p["pos"], 0) + 1
        p["pos_rank"] = pos_count[p["pos"]]
    assign_tiers(players)
    by_pos: dict[str, list] = {}
    for p in players:
        by_pos.setdefault(p["pos"], []).append(p)
    for group in by_pos.values():
        tmp = [{"value": p["value"]} for p in group]
        assign_tiers(tmp)
        for p, t in zip(group, tmp):
            p["pos_tier"] = t["tier"]


import os
FA_REPLACEMENT_WEIGHT = float(os.environ.get('FA_W', '0.5'))  # replacement level: share from this league's real free agents


def free_agent_levels(rows: dict, rostered: set, groups) -> dict:
    """Points per game of the best few free agents at each position in this league."""
    out = {}
    for g in groups:
        fa = sorted((r["est"]["ppg"] for pid, r in rows.items()
                     if r["group"] == g and r["est"] and pid not in rostered and r.get("active")), reverse=True)[:3]
        if fa:
            out[g] = round(sum(fa) / len(fa), 2)
    return out


def value_players(
    fmt: LeagueFormat,
    players_db: dict,
    market: dict,
    proj: dict,
    week_proj: dict,
    cur: dict,
    last: dict,
    rostered: set,
    two_ago: dict | None = None,
    situations=None,
):
    candidates = set(market) | set(proj) | set(cur) | set(last) | set(rostered)
    team_games = situations.team_games(cur) if situations else {}
    rows = {}
    for pid in candidates:
        info = players_db.get(pid)
        if not info:
            continue
        group = position_group(info)
        if group not in fmt.positions and pid not in rostered:
            continue
        sit = situations.of(pid, group, info, cur, last, team_games) if situations else None
        rows[pid] = {"info": info, "group": group, "sit": sit, "active": pid in proj or pid in cur,
                     "est": model.estimate_ppg(pid, group, fmt, proj, cur, last, two_ago,
                                               (sit or {}).get("role", 1.0))}

    # Replacement levels from players with a meaningful sample or a projection.
    ppg_by_group: dict[str, list[float]] = {g: [] for g in fmt.positions}
    for pid, r in rows.items():
        est = r["est"]
        if est and r["group"] in ppg_by_group and (pid in proj or pid in cur):
            ppg_by_group[r["group"]].append(est["ppg"])
    lineup_repl, starters = model.replacement_levels(ppg_by_group, fmt)
    # Replacement is what you'd actually start instead: half the theoretical level
    # (the best player left once every lineup is full) and half the best free agents
    # in this league as rostered today, so deep benches and thin waivers count.
    fa = free_agent_levels(rows, rostered, lineup_repl) if len(rostered) >= fmt.num_teams * 5 else {}
    repl = {g: round((1 - FA_REPLACEMENT_WEIGHT) * v + FA_REPLACEMENT_WEIGHT * min(fa[g], v), 2) if g in fa else v
            for g, v in lineup_repl.items()}

    # Scoring-fit premium relative to the typical starter at the same position.
    pos_median = {}
    for g in OFFENSE:
        prems = sorted(
            ((r["est"]["ppg"], r["est"]["premium"]) for r in rows.values() if r["group"] == g and r["est"]),
            reverse=True,
        )[: max(starters.get(g, 0), 12)]
        pos_median[g] = median([p for _, p in prems]) if prems else 1.0
    overall_median = median(pos_median.values()) if pos_median else 1.0

    for pid, r in rows.items():
        est, g = r["est"], r["group"]
        age = r["info"].get("age")
        sit = r["sit"] or {}
        r["score"] = model.dynasty_score(est["ppg"], g, age, repl.get(g, 0), sit.get("archetype"),
                                         sit.get("later", 1.0)) if est and g in repl else 0.0
        rel = 1.0
        if est and g in OFFENSE and pos_median.get(g):
            rel = (est["premium"] / pos_median[g]) ** PLAYER_PREMIUM_EXPONENT
            rel *= (pos_median[g] / overall_median) ** POSITION_PREMIUM_EXPONENT
            rel = min(max(rel, PREMIUM_CLAMP[0]), PREMIUM_CLAMP[1])
        r["rel_premium"] = rel
        m = market.get(pid, {}).get("market", 0)
        r["market_adj"] = m * rel if m else 0

    # Calibrate production scores onto the market scale using offensive players
    # both sides know about; that same curve then prices IDP/K the market ignores.
    pairs = [(r["score"], r["market_adj"]) for r in rows.values() if r["score"] > 0 and r["market_adj"] > 0 and r["group"] in OFFENSE]
    if len(pairs) >= 25:
        calib = QuantileMap([a for a, _ in pairs], [b for _, b in pairs])
    else:
        scores = [r["score"] for r in rows.values() if r["score"] > 0]
        mkts = [r["market_adj"] for r in rows.values() if r["market_adj"] > 0]
        top_s = _top_mean(scores)
        calib = RatioMap(_top_mean(mkts) / top_s if top_s and mkts else 10000 / top_s if top_s else 1.0)

    out = []
    for pid, r in rows.items():
        info, g, est = r["info"], r["group"], r["est"]
        model_val = calib(r["score"]) if r["score"] > 0 else 0
        mkt = market.get(pid, {})
        if r["market_adj"] and est:
            w = MODEL_WEIGHT if (pid in proj or pid in cur) else MODEL_WEIGHT / 2
            value = (1 - w) * r["market_adj"] + w * model_val
        elif r["market_adj"]:
            value = r["market_adj"]
        else:
            value = model_val * UNPRICED_DISCOUNT.get(g, 1.0)
        wk = week_proj.get(pid)
        sp = proj.get(pid)
        out.append({
            "id": pid,
            "name": info.get("full_name") or f"{info.get('first_name', '')} {info.get('last_name', '')}".strip(),
            "pos": g,
            "team": info.get("team"),
            "age": info.get("age"),
            "exp": info.get("years_exp"),
            "injury": info.get("injury_status"),
            "value": round(value),
            "market": mkt.get("market", 0),
            "market_adj": round(r["market_adj"]),
            "model": round(model_val),
            "premium": round(r["rel_premium"], 3),
            "ppg": est["ppg"] if est else None,
            # Points per game over what this league's replacement starter scores.
            "vor": round(est["ppg"] - repl[g], 2) if est and g in repl else None,
            "situation": _situation_out(r["sit"]),
            "proj_week": round(fantasy_points((wk or {}).get("stats"), fmt.scoring, g), 2) if wk else None,
            "proj_season": round(fantasy_points((sp or {}).get("stats"), fmt.scoring, g), 1) if sp else None,
            "sources": {k: mkt[k] for k in ("fantasycalc", "ktc", "dynastyprocess") if k in mkt},
            # Each site's own number, before it is put on the shared scale.
            "sources_raw": {k: round(mkt[f"{k}_raw"]) for k in ("fantasycalc", "ktc", "dynastyprocess") if f"{k}_raw" in mkt},
            # Plain average of the sites' own numbers, for display next to the league value.
            "sites_avg": _sites_avg(mkt),
            "spread": mkt.get("spread", 0),
            "trend": mkt.get("trend"),
        })
    out = [p for p in out if p["value"] > 0 or p["id"] in rostered]
    rank(out)
    return out, {"replacement_ppg": repl, "replacement_lineup_ppg": lineup_repl, "replacement_fa_ppg": fa,
                 "starters_per_position": starters, "premium_baseline": pos_median,
                 "stability": model.STABILITY, "discount": model.DISCOUNT,
                 "archetype_curves": {k: list(v) for k, v in model.ARCHETYPE_CURVES.items()}}


def _situation_out(sit: dict | None) -> dict | None:
    """The parts of a player's situation worth showing (and only those that are set)."""
    if not sit:
        return None
    keep = {k: v for k, v in sit.items() if v not in (None, False, [], 1.0)}
    return keep or None
