"""Personal formula score and buy / sell / hold calls for every player.

The score (0-100) mixes seven parts, each a percentile among the league's priced
players at that part, weighted by WEIGHTS:
  value      final league value (market blended with the points model)
  production rest-of-season points a game over this league's replacement level
  longevity  years left before the position's age cliff (CLIFF), capped at 8
  fit        how much this league's scoring lifts him over generic scoring (premium)
  momentum   FantasyCalc's 30-day value trend as a share of his market value
  consensus  how closely the market sources agree (low spread)
  scarcity   how far up his position he ranks against the league's starters there

The call compares what this league's scoring says he's worth (the points model)
with what the market pays, then checks age and momentum:
  SELL  aging out (at or past the cliff), or the market pays well over his points
        while it isn't falling (sell high)
  BUY   his points are worth well over the market price, or a young player's market
        just dipped (buy low)
  HOLD  everything else
"""
from __future__ import annotations

WEIGHTS = {"value": 0.30, "production": 0.20, "longevity": 0.15, "fit": 0.08,
           "momentum": 0.10, "consensus": 0.05, "scarcity": 0.12}
CLIFF = {"QB": 34, "RB": 28, "WR": 30, "TE": 31, "DL": 31, "LB": 30, "DB": 30, "K": 38, "DEF": 99}
MAX_YEARS = 8
MIN_VALUE = 300      # players below this are left out of the percentiles and calls
GAP = 0.18           # points model vs market gap that triggers a call
SWING = 0.08         # 30-day market move that counts as a rise or a dip


def years_left(p: dict) -> float | None:
    age, cliff = p.get("age"), CLIFF.get(p.get("pos"))
    if age is None or cliff is None:
        return None
    return max(0.0, min(MAX_YEARS, cliff - age))


def _pct(values: dict) -> dict:
    """{id: raw} -> {id: 0..100 percentile}, ties share the average rank."""
    items = sorted(values.items(), key=lambda kv: kv[1])
    n = len(items)
    out, i = {}, 0
    while i < n:
        j = i
        while j + 1 < n and items[j + 1][1] == items[i][1]:
            j += 1
        for k in range(i, j + 1):
            out[items[k][0]] = round(100 * ((i + j) / 2) / (n - 1), 1) if n > 1 else 50.0
        i = j + 1
    return out


def score(players: list, replacement_ppg: dict, starters_per_position: dict) -> None:
    """Adds "formula" {score, rank, parts} and "call" {signal, why} to priced players."""
    pool = [p for p in players if (p.get("value") or 0) >= MIN_VALUE]
    if not pool:
        return
    raw = {k: {} for k in WEIGHTS}
    for p in pool:
        pid, pos = p["id"], p["pos"]
        mkt = p.get("market") or 0
        raw["value"][pid] = p["value"]
        repl = replacement_ppg.get(pos)
        ppg = p.get("ros_ppg") if p.get("ros_ppg") is not None else p.get("ppg")
        raw["production"][pid] = (ppg or 0) - (repl if repl is not None else 0)
        y = years_left(p)
        raw["longevity"][pid] = y if y is not None else MAX_YEARS / 2
        raw["fit"][pid] = p.get("premium") or 1.0
        raw["momentum"][pid] = _move(p)
        raw["consensus"][pid] = -(p.get("spread") or 0)
        slots = starters_per_position.get(pos) or 0
        raw["scarcity"][pid] = 1 - (p.get("pos_rank") or 999) / (1.5 * slots) if slots else 0.0
    pct = {k: _pct(v) for k, v in raw.items()}
    for p in pool:
        pid = p["id"]
        parts = {k: pct[k][pid] for k in WEIGHTS}
        p["formula"] = {"score": round(sum(WEIGHTS[k] * parts[k] for k in WEIGHTS), 1), "parts": parts}
        p["call"] = call(p)
    for i, p in enumerate(sorted(pool, key=lambda p: -p["formula"]["score"]), 1):
        p["formula"]["rank"] = i


def _move(p: dict) -> float:
    """30-day market change as a share of where he started (as engine/weekly.py does)."""
    t, mkt = p.get("trend") or 0, p.get("market") or 0
    return t / max(mkt - t, 1) if mkt else 0.0


def call(p: dict) -> dict:
    mkt_adj = p.get("market_adj") or p.get("market")
    model = p.get("model")
    gap = (model / mkt_adj - 1) if model and mkt_adj else 0.0
    move = _move(p)
    y = years_left(p)
    age = p.get("age")
    if y is not None and y <= 0.5 and p["pos"] not in ("K", "DEF"):
        return {"signal": "SELL", "gap": round(gap, 3), "move": round(move, 3),
                "why": f"{age} is at the {p['pos']} age cliff; value usually drops fast from here"}
    if gap <= -GAP and move > -SWING / 2:
        return {"signal": "SELL", "gap": round(gap, 3), "move": round(move, 3),
                "why": f"the market pays {round(-gap * 100)}% more than his points in this league are worth"
                       + (f", and it's up {round(move * 100)}% this month" if move >= SWING / 2 else "")}
    if move >= SWING and gap < 0 and y is not None and y <= 2:
        return {"signal": "SELL", "gap": round(gap, 3), "move": round(move, 3),
                "why": f"sell high: up {round(move * 100)}% this month with {y:g} prime years left"}
    if gap >= GAP:
        return {"signal": "BUY", "gap": round(gap, 3), "move": round(move, 3),
                "why": f"his points in this league are worth {round(gap * 100)}% more than the market price"}
    if move <= -SWING and (y is None or y >= 3) and gap > -GAP / 2:
        return {"signal": "BUY", "gap": round(gap, 3), "move": round(move, 3),
                "why": f"buy low: down {round(-move * 100)}% this month with {y:g} prime years left" if y is not None
                       else f"buy low: down {round(-move * 100)}% this month"}
    return {"signal": "HOLD", "gap": round(gap, 3), "move": round(move, 3),
            "why": "priced about right for what he scores here" + (f"; market {'up' if move > 0 else 'down'} {abs(round(move * 100))}% this month" if abs(move) >= 0.03 else "")}
