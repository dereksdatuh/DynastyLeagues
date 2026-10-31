"""What each league's own trades say it pays, by position.

Every completed trade in this league (this season and the two before it) is valued
with today's numbers and the same value adjustment the calculator uses. If the
league's managers keep paying more for RBs than the values say, RBs here get a
multiplier above 1, and so on for QB, WR, TE, IDP and picks.

The fit is deliberately cautious:
* each trade counts less the older it is (today's values describe old trades worse);
* a ridge pull toward 1 worth PRIOR_TRADES trades, so a handful of deals moves little;
* a position needs MIN_TRADES trades it appeared in, or it stays at 1;
* the result is clamped to CLAMP.
"""

import math

from . import trade as trade_eval

PRIOR_TRADES = 8.0
MIN_TRADES = 5
CLAMP = (0.92, 1.08)
HALF_LIFE_DAYS = 365
GROUP = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "DL": "IDP", "LB": "IDP", "DB": "IDP", "PICK": "PICK"}
GROUPS = ("QB", "RB", "WR", "TE", "IDP", "PICK")


def _asset(move: dict, by_id: dict, pick_value):
    """(group, today's value) for one moved piece; None when today's value is unknown
    (a player who's gone, a pick whose draft has happened), which drops the trade."""
    if move["kind"] == "player":
        p = by_id.get(move["id"])
        return (GROUP.get(p["pos"]), p["value"]) if p and p.get("value") else None
    if move["kind"] == "pick":
        v = pick_value(move)
        return ("PICK", v) if v else None
    return ("FAAB", 0)


def equations(trades: list, by_id: dict, pick_value, now_ms: float, scale: float) -> list:
    """One row per team per trade: what it got and gave, as (group, effective value) pairs."""
    rows = []
    for t in trades:
        assets, ok = [], True
        for m in t.get("moves") or []:
            a = _asset(m, by_id, pick_value)
            if a is None:
                ok = False
                break
            if a[0] in GROUPS:
                assets.append((m, a))
        if not ok or not assets:
            continue
        rids = {m["to"] for m, _ in assets} | {m["from"] for m, _ in assets}
        rids.discard(None)
        if len(rids) < 2:
            continue
        age_days = max((now_ms - (t.get("at") or now_ms)) / 86_400_000, 0)
        w = 0.5 ** (age_days / HALF_LIFE_DAYS) / (len(rids) - 1)
        # Two teams: one row says it all (the other is its mirror).
        for rid in sorted(rids)[:1] if len(rids) == 2 else sorted(rids):
            got = [a for m, a in assets if m["to"] == rid]
            gave = [a for m, a in assets if m["from"] == rid]
            if not got or not gave:
                continue
            # Depth part of the value adjustment, per piece, so multipliers stay linear.
            allv = [v for _, v in got + gave]
            top = max(allv)
            e = trade_eval.DEPTH_EXP * top / scale if scale else 0
            eff = lambda xs: [(g, v * (v / top) ** e) for g, v in xs]
            rows.append({"got": eff(got), "gave": eff(gave), "w": w})
    return rows


def fit(rows: list) -> dict:
    """Log-multipliers minimizing weighted squared log imbalance plus a ridge toward 0."""
    seen = {g: 0 for g in GROUPS}
    for r in rows:
        for g in {g for g, _ in r["got"] + r["gave"]}:
            seen[g] += 1
    free = [g for g in GROUPS if seen[g] >= MIN_TRADES]
    lm = {g: 0.0 for g in GROUPS}
    if not free or not rows:
        return {"multipliers": {g: 1.0 for g in GROUPS}, "trades_seen": seen, "rows": len(rows)}

    def loss(x):
        tot = 0.0
        for r in rows:
            a = sum(math.exp(x[g]) * v for g, v in r["got"])
            b = sum(math.exp(x[g]) * v for g, v in r["gave"])
            if a > 0 and b > 0:
                tot += r["w"] * math.log(a / b) ** 2
        # A position that is about half of one side moves that trade's log balance by
        # about half its log multiplier, so PRIOR_TRADES such trades cost 0.25 x^2 each.
        return tot + PRIOR_TRADES * 0.25 * sum(x[g] ** 2 for g in free)

    step = 0.04
    best = loss(lm)
    for _ in range(60):
        moved = False
        for g in free:
            for d in (step, -step):
                trial = {**lm, g: lm[g] + d}
                lt = loss(trial)
                if lt < best:
                    lm, best, moved = trial, lt, True
                    break
        if not moved:
            step /= 2
            if step < 0.002:
                break
    # Multipliers are relative: center them on the value-weighted average so the
    # league's overall scale doesn't drift.
    tot = sum(v for r in rows for _, v in r["got"] + r["gave"]) or 1
    share = {g: sum(v for r in rows for gg, v in r["got"] + r["gave"] if gg == g) / tot for g in GROUPS}
    center = sum(share[g] * lm[g] for g in GROUPS)
    mult = {g: round(min(max(math.exp(lm[g] - center), CLAMP[0]), CLAMP[1]), 3) if g in free else 1.0 for g in GROUPS}
    return {"multipliers": mult, "trades_seen": seen, "rows": len(rows)}


def learn(trades: list, by_id: dict, pick_value, now_ms: float, scale: float) -> dict:
    rows = equations(trades, by_id, pick_value, now_ms, scale)
    out = fit(rows)
    out["trades"] = len(trades)
    return out
