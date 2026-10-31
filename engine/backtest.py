"""Backtest the production model on past NFL seasons and write the tuned settings.

    python -m engine.backtest                       # 2010-2025 -> data/model_tuning.json

Every number the model leans on for the future is checked here against what
actually happened next, using nflverse's season and weekly stats (PPR, 4-point
passing TDs, the generic scoring every league starts from):

* age curves by position and player type (rushing vs pocket QB, receiving vs
  early-down RB, deep vs short WR), fitted to year-over-year changes in points per
  game with the "delta method" (both seasons must clear a bar, so one fluke year
  doesn't drag the curve);
* stability: how much of a player's points over replacement, after aging, he
  actually kept the next season, counting the games he missed;
* how much a player's own availability (games played) predicts his next season's;
* how to weight this season, last season and the one before;
* in season, how much the last four games and a rising or falling role (share of
  the team's targets and carries) say about the rest of the season.

The build reads the result; constants in engine/model.py are the fallback.
"""

import argparse
import csv
import io
import json
import math
import sys
from datetime import date
from pathlib import Path

from . import fetch, nflverse
from .model import AGE_CURVES

OUT = Path(__file__).resolve().parent.parent / "data" / "model_tuning.json"
SEASON_URL = f"{nflverse.BASE}/stats_player/stats_player_reg_{{y}}.csv"
WEEK_URL = f"{nflverse.BASE}/stats_player/stats_player_week_{{y}}.csv"
GAMES = 17
POS = ("QB", "RB", "WR", "TE")
# Bar for a season to count in the age curves (PPR points per game).
BAR = {"QB": 12.0, "RB": 8.0, "WR": 8.0, "TE": 6.0}
# Replacement level: the Nth best at the position in a 12-team superflex league.
REPL_RANK = {"QB": 24, "RB": 30, "WR": 42, "TE": 15}
MIN_GAMES = 6


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def points(r: dict) -> float:
    return (0.04 * _f(r.get("passing_yards")) + 4 * _f(r.get("passing_tds")) - 2 * _f(r.get("passing_interceptions"))
            + 0.1 * _f(r.get("rushing_yards")) + 6 * _f(r.get("rushing_tds"))
            + _f(r.get("receptions")) + 0.1 * _f(r.get("receiving_yards")) + 6 * _f(r.get("receiving_tds"))
            - 2 * (_f(r.get("rushing_fumbles_lost")) + _f(r.get("receiving_fumbles_lost")) + _f(r.get("sack_fumbles_lost"))))


def archetype(pos: str, r: dict) -> str:
    """Player type from one season's line (same rule the build uses on current usage)."""
    rush = 0.1 * _f(r.get("rushing_yards")) + 6 * _f(r.get("rushing_tds"))
    rec = _f(r.get("receptions")) + 0.1 * _f(r.get("receiving_yards")) + 6 * _f(r.get("receiving_tds"))
    tot = points(r) or 1.0
    if pos == "QB":
        return "QB_rush" if rush / tot >= 0.22 else "QB_pocket"
    if pos == "RB":
        return "RB_rec" if rec / tot >= 0.33 else "RB_early"
    if pos == "WR":
        tgt = _f(r.get("targets"))
        adot = _f(r.get("receiving_air_yards")) / tgt if tgt >= 20 else 0
        return "WR_deep" if adot >= 12.5 else "WR_short"
    return pos


def _csv(url: str):
    return list(csv.DictReader(io.StringIO(fetch.TRANSPORT(url, None).text)))


def load_seasons(first: int, last: int, births: dict) -> dict:
    """(gsis, season) -> {pos, age, games, ppg, pts, type}"""
    out = {}
    for y in range(first, last + 1):
        for r in _csv(SEASON_URL.format(y=y)):
            pos = r.get("position")
            if pos not in POS or (r.get("season_type") or "REG") != "REG":
                continue
            g = _f(r.get("games"))
            if g <= 0:
                continue
            age = nflverse.age_on(births.get(r["player_id"]), date(y, 9, 1))
            pts = points(r)
            out[(r["player_id"], y)] = {"pos": pos, "age": age, "games": g, "pts": pts, "ppg": pts / g,
                                        "type": archetype(pos, r)}
    return out


def _curve(params, age):
    start, end, growth, decline = params
    if age < start:
        return (1 - growth) ** (start - age)
    if age > end:
        return max(1e-6, 1 - decline) ** (age - end)
    return 1.0


def fit_curve(points_: list[tuple[float, float, float]]):
    """Best (peak start, peak end, growth, decline) for (age, log ratio, weight) points."""
    buckets: dict[int, list[float]] = {}
    for age, lr, w in points_:
        b = buckets.setdefault(int(round(age)), [0.0, 0.0])
        b[0] += lr * w
        b[1] += w
    obs = {a: (s / w, w) for a, (s, w) in buckets.items() if w >= 8}
    best, err = None, float("inf")
    for start in range(21, 31):
        for end in range(start, 37):
            for gi in range(0, 26):
                g = gi / 100
                for di in range(0, 31):
                    d = di / 100
                    p = (start, end, g, d)
                    e = 0.0
                    for a, (m, w) in obs.items():
                        pred = math.log(_curve(p, a + 1) / _curve(p, a))
                        e += w * (pred - m) ** 2
                    if e < err:
                        best, err = p, e
    return best, {str(a): round(m, 3) for a, (m, _) in sorted(obs.items())}


def age_curves(seasons: dict, holdout_from: int | None = None) -> dict:
    groups: dict[str, list] = {}
    for (pid, y), s in seasons.items():
        n = seasons.get((pid, y + 1))
        if not n or s["age"] is None or s["games"] < MIN_GAMES or n["games"] < MIN_GAMES:
            continue
        if (s["ppg"] + n["ppg"]) / 2 < BAR[s["pos"]] or s["ppg"] <= 0.5 or n["ppg"] <= 0.5:
            continue
        lr = math.log(n["ppg"] / s["ppg"])
        w = min(s["games"], n["games"])
        groups.setdefault(s["pos"], []).append((s["age"], lr, w, y))
        if s["type"] != s["pos"]:
            groups.setdefault(s["type"], []).append((s["age"], lr, w, y))
    out = {}
    for key, rows in sorted(groups.items()):
        train = [r[:3] for r in rows if holdout_from is None or r[3] < holdout_from]
        params, observed = fit_curve(train)
        if params:
            out[key] = {"curve": list(params), "seasons": len(train), "observed_log_change_by_age": observed}
            if holdout_from is not None:
                test = [r for r in rows if r[3] >= holdout_from]
                old = AGE_CURVES.get(key.split("_")[0])
                out[key]["holdout"] = {"seasons": len(test), "mae_old": _lr_mae(old, test), "mae_fitted": _lr_mae(params, test)}
    return out


def _lr_mae(params, rows):
    """Mean abs error of the predicted change in ppg (as a log ratio) on held-out seasons."""
    if not params or not rows:
        return None
    e = w = 0.0
    for age, lr, wt, _ in rows:
        e += abs(math.log(_curve(params, age + 1) / _curve(params, age)) - lr) * wt
        w += wt
    return round(e / w, 4)


def replacement(seasons: dict) -> dict:
    """Replacement ppg per (position, season): the REPL_RANK-th best by points per game (8+ games)."""
    by: dict[tuple, list] = {}
    for (pid, y), s in seasons.items():
        if s["games"] >= 8:
            by.setdefault((s["pos"], y), []).append(s["ppg"])
    out = {}
    for (pos, y), v in by.items():
        v.sort(reverse=True)
        k = REPL_RANK[pos]
        out[(pos, y)] = v[k - 1] if len(v) >= k else v[-1]
    return out


def stability(seasons: dict, curves: dict, repl: dict) -> dict:
    """Points over replacement kept the next season, after aging, counting missed games."""
    acc: dict[str, list] = {}
    for (pid, y), s in seasons.items():
        r = repl.get((s["pos"], y + 1))
        if r is None or s["age"] is None or s["games"] < 8:
            continue
        c = (curves.get(s["type"]) or curves.get(s["pos"]) or {}).get("curve")
        ratio = _curve(c, s["age"] + 1) / _curve(c, s["age"]) if c else 1.0
        expect = max(s["ppg"] * ratio - r, 0) * GAMES
        if expect <= 0:
            continue
        n = seasons.get((pid, y + 1))
        got = max(n["ppg"] - r, 0) * n["games"] if n else 0.0
        a = acc.setdefault(s["pos"], [0.0, 0.0, 0])
        a[0] += got
        a[1] += expect
        a[2] += 1
    return {pos: {"stability": round(g / e, 3), "players": n} for pos, (g, e, n) in acc.items() if e}


def availability(seasons: dict) -> dict:
    """How much two seasons of games played predict the next: avail' = mean + k (own - mean)."""
    out = {}
    for pos in POS:
        rows = []
        for (pid, y), s in seasons.items():
            if s["pos"] != pos or s["ppg"] < BAR[pos]:
                continue
            p = seasons.get((pid, y - 1))
            n = seasons.get((pid, y + 1))
            if not p or not n:
                continue
            hist = (s["games"] + p["games"]) / (2 * GAMES)
            rows.append((min(hist, 1), min(n["games"] / GAMES, 1)))
        if len(rows) < 30:
            continue
        mx = sum(h for h, _ in rows) / len(rows)
        my = sum(f for _, f in rows) / len(rows)
        cov = sum((h - mx) * (f - my) for h, f in rows)
        var = sum((h - mx) ** 2 for h, _ in rows)
        out[pos] = {"mean": round(my, 3), "k": round(cov / var, 3) if var else 0.0, "players": len(rows)}
    return out


def season_weights(seasons: dict, curves: dict) -> dict:
    """Weights on the last three seasons (aged forward) that best predict the next."""
    rows = []
    for (pid, y), n in seasons.items():
        if n["games"] < MIN_GAMES or n["age"] is None:
            continue
        c = (curves.get(n["type"]) or curves.get(n["pos"]) or {}).get("curve")
        hist = []
        for back in (1, 2, 3):
            s = seasons.get((pid, y - back))
            if s and s["games"] >= 4 and s["age"] is not None and c:
                hist.append((s["ppg"] * _curve(c, n["age"]) / _curve(c, s["age"]), s["games"]))
            else:
                hist.append(None)
        if hist[0] is None or max(h[0] for h in hist if h) < BAR[n["pos"]] * 0.75:
            continue
        rows.append((n["ppg"], hist, n["games"]))

    def mae(w):
        e = tot = 0.0
        for y_, hist, g in rows:
            num = den = 0.0
            for wi, h in zip(w, hist):
                if h:
                    k = wi * min(h[1], GAMES) / GAMES
                    num += k * h[0]
                    den += k
            if den:
                e += abs(num / den - y_) * g
                tot += g
        return e / tot
    best, err = (1.0, 0.0, 0.0), mae((1.0, 0.0, 0.0))
    last_only = err
    for a in range(0, 21):
        for b in range(0, 21 - a):
            w = (1.0, a / 20, b / 20)
            e = mae(w)
            if e < err:
                best, err = w, e
    return {"last": 1.0, "two_ago": best[1], "three_ago": best[2], "players": len(rows),
            "mae_last_season_only": round(last_only, 3), "mae_tuned": round(err, 3)}


def in_season(weekly_years: list[int]) -> dict:
    """Games 1-8 to predict 9-17: weight on the last four games, and on a changing role."""
    rows = []
    for y in weekly_years:
        by: dict[str, list] = {}
        team: dict[tuple, list] = {}
        for r in _csv(WEEK_URL.format(y=y)):
            if r.get("position") not in POS or (r.get("season_type") or "REG") != "REG":
                continue
            wk = int(_f(r.get("week")))
            opp = _f(r.get("targets")) + _f(r.get("carries"))
            by.setdefault(r["player_id"], []).append((wk, points(r), opp, r.get("team"), r["position"]))
            t = team.setdefault((r.get("team"), wk), [0.0])
            t[0] += opp
        for pid, g in by.items():
            g.sort()
            first = [x for x in g if x[0] <= 9][:8]
            rest = [x for x in g if x[0] > 9]
            if len(first) < 8 or len(rest) < 4:
                continue
            pos = first[0][4]
            if pos == "QB":
                continue  # a QB's role is the depth chart, not a share
            ppg = sum(x[1] for x in first) / 8
            if ppg < BAR[pos] * 0.6:
                continue

            def share(xs):
                num = sum(x[2] for x in xs)
                den = sum(team.get((x[3], x[0]), [0])[0] for x in xs)
                return num / den if den else 0
            sh_all, sh_recent = share(first), share(first[4:])
            trend = sh_recent / sh_all if sh_all else 1.0
            recent = sum(x[1] for x in first[4:]) / 4
            rows.append((ppg, recent, min(max(trend, 0.5), 1.5), sum(x[1] for x in rest) / len(rest), len(rest)))

    def mae(alpha, k):
        e = tot = 0.0
        for ppg, recent, trend, fut, n in rows:
            base = (1 - alpha) * ppg + alpha * recent
            pred = base * (1 + k * (trend - 1))
            e += abs(pred - fut) * n
            tot += n
        return e / tot if tot else 0
    best, err = (0.0, 0.0), mae(0.0, 0.0)
    plain = err
    for ai in range(0, 21):
        for ki in range(-10, 21):
            e = mae(ai / 20, ki / 20)
            if e < err:
                best, err = (ai / 20, ki / 20), e
    return {"recent_weight": best[0], "role_trend": best[1], "players": len(rows),
            "mae_season_ppg": round(plain, 3), "mae_tuned": round(err, 3)}


def run(first: int, last: int, weekly: list[int]) -> dict:
    births = {g: v.get("birth") for g, v in nflverse.ids().items()}
    seasons = load_seasons(first, last, births)
    holdout = age_curves(seasons, holdout_from=2020)
    curves = age_curves(seasons)
    # A fitted curve replaces the hand-set one only where it predicted the held-out
    # seasons clearly better; elsewhere the old curve stays (marked use: false).
    for k, v in curves.items():
        h = holdout.get(k, {}).get("holdout") or {}
        v["use"] = bool(h.get("mae_fitted") is not None and h.get("mae_old") is not None
                        and h["mae_fitted"] < h["mae_old"] - 0.005)
    repl = replacement(seasons)
    return {
        "generated": date.today().isoformat(),
        "seasons": [first, last],
        "scoring": "PPR, 4-pt pass TD (nflverse regular-season stats)",
        "archetypes": {"QB_rush": "22%+ of points from rushing", "RB_rec": "33%+ of points from receiving",
                       "WR_deep": "12.5+ air yards per target"},
        "age_curves": curves,
        # Curves fitted on 2010-2019 only, scored on 2020-2025: does the fit beat the old hand-set curves?
        "aging_holdout": {k: v["holdout"] for k, v in holdout.items()},
        "stability": stability(seasons, curves, repl),
        "availability": availability(seasons),
        "season_weights": season_weights(seasons, curves),
        "in_season": in_season(weekly),
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--first", type=int, default=2010)
    ap.add_argument("--last", type=int, default=2025)
    ap.add_argument("--weekly", default="2022,2023,2024,2025")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args(argv)
    res = run(args.first, args.last, [int(x) for x in args.weekly.split(",") if x])
    Path(args.out).write_text(json.dumps(res, indent=1))
    print(json.dumps({k: v for k, v in res.items() if k != "age_curves"}, indent=1))
    for k, v in res["age_curves"].items():
        print(k, v["curve"], v["seasons"], file=sys.stderr)


if __name__ == "__main__":
    main()
