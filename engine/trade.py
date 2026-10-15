"""Trade evaluation with a value adjustment: trading is more than addition.

Twelve third-round picks are not a fair price for one star. Each side's total is
the raw sum of what that team receives, changed by three things:

  depth   every piece counts at v · (v / T)^e, where T is the best piece anywhere in
          the trade and e = DEPTH_EXP · T / SCALE. Pieces far below the best one are
          worth less than face value, and the discount grows with how much of a
          stud T is: a 9,000 star dilutes a pile of mid pieces far more than a
          2,000 player dilutes a pile of fliers.
  stud    the side receiving the trade's best piece gets a premium of
          t · STUD_SHARE · (t / SCALE)² · (1 − t_other / t), where t is its best
          piece and t_other the other side's best. Zero when both best pieces are
          equal, largest for a true stud against nothing close.
  roster  each extra player a team receives beyond what it sends costs a roster
          spot: the receiver drops someone, so each of its smallest extra incoming
          players loses min(v, R), R being the value of a last-roster-spot player.
          Picks take no roster spot.

SCALE is the league's top asset value. The "value adjustment" shown on the site is
reverse engineered from these: the value of the one player the short side would need
added to make it even, minus the raw gap. It moves as pieces are added to either side.
The same formula runs in the browser (site/app.js) so both agree.
"""
from __future__ import annotations

DEPTH_EXP = 0.2
STUD_SHARE = 0.35
FAIR_MARGIN = 0.05
DEFAULT_SCALE = 10_000
DEFAULT_ROSTER_SPOT = 300


def _items(xs) -> list[dict]:
    """Accept bare numbers or {"value", "kind"} dicts; kind defaults to player."""
    out = []
    for x in xs:
        if isinstance(x, dict):
            out.append({"value": float(x.get("value") or 0), "kind": x.get("kind") or "player"})
        else:
            out.append({"value": float(x or 0), "kind": "player"})
    return [x for x in out if x["value"] > 0]


def adjust(gets, gives, scale: float = DEFAULT_SCALE, roster_spot: float = DEFAULT_ROSTER_SPOT) -> dict:
    """One team's view: adjusted value received (g) and sent (v), with each part."""
    gets, gives = _items(gets), _items(gives)
    allv = [x["value"] for x in gets + gives]
    top = max(allv) if allv else 0.0
    e = DEPTH_EXP * top / scale if scale else 0.0

    def part(side):
        raw = sum(x["value"] for x in side)
        depth = sum(x["value"] * (x["value"] / top) ** e for x in side) - raw if top else 0.0
        return {"raw": raw, "depth": depth, "stud": 0.0, "roster": 0.0}

    g, v = part(gets), part(gives)
    tg = max((x["value"] for x in gets), default=0.0)
    tv = max((x["value"] for x in gives), default=0.0)
    if tg > tv:
        g["stud"] = tg * STUD_SHARE * (tg / scale) ** 2 * (1 - tv / tg)
    elif tv > tg:
        v["stud"] = tv * STUD_SHARE * (tv / scale) ** 2 * (1 - tg / tv)
    p_in = sorted(x["value"] for x in gets if x["kind"] == "player")
    p_out = sorted(x["value"] for x in gives if x["kind"] == "player")
    extra = len(p_in) - len(p_out)
    if extra > 0:
        g["roster"] = -sum(min(x, roster_spot) for x in p_in[:extra])
    elif extra < 0:
        v["roster"] = -sum(min(x, roster_spot) for x in p_out[:-extra])
    for s in (g, v):
        s["total"] = max(s["raw"] + s["depth"] + s["stud"] + s["roster"], 0.0)
    pct = (g["total"] - v["total"]) / (max(g["total"], v["total"]) or 1)
    return {"g": g, "v": v, "pct": pct}


def even_out(gets, gives, scale: float = DEFAULT_SCALE, roster_spot: float = DEFAULT_ROSTER_SPOT) -> float:
    """Value of the one player to add to `gets` that makes this team even (pct = 0)."""
    gets = _items(gets)
    if adjust(gets, gives, scale, roster_spot)["pct"] >= 0:
        return 0.0
    lo, hi = 0.0, 3.0 * scale
    if adjust(gets + [{"value": hi}], gives, scale, roster_spot)["pct"] < 0:
        return hi
    for _ in range(50):
        mid = (lo + hi) / 2
        if adjust(gets + [{"value": mid}], gives, scale, roster_spot)["pct"] < 0:
            lo = mid
        else:
            hi = mid
    return hi


def evaluate(side_a, side_b, scale: float = DEFAULT_SCALE, roster_spot: float = DEFAULT_ROSTER_SPOT) -> dict:
    """Two-team trade. Each side is what that team receives."""
    a = adjust(side_a, side_b, scale, roster_spot)
    pct = a["pct"]
    ea, eb = a["g"]["total"], a["v"]["total"]
    if abs(pct) <= FAIR_MARGIN:
        verdict, short = "fair", None
    elif pct > 0:
        verdict, short = "side A receives more", "b"
    else:
        verdict, short = "side B receives more", "a"
    result = {
        "raw": {"a": round(a["g"]["raw"]), "b": round(a["v"]["raw"])},
        "effective": {"a": round(ea), "b": round(eb)},
        "difference_pct": round(pct * 100, 1),
        "verdict": verdict,
    }
    if short:
        gets, gives = (side_b, side_a) if short == "b" else (side_a, side_b)
        add = even_out(gets, gives, scale, roster_spot)
        raw_gap = sum(x["value"] for x in _items(gives)) - sum(x["value"] for x in _items(gets))
        result["to_balance"] = {"side": short, "add_value": round(add)}
        # Credit beyond the raw gap: positive goes to the side already ahead (its
        # stud or fewer roster spots), negative means the short side's pieces were
        # the better ones and the credit is its own.
        adj_value = add - raw_gap
        other = "a" if short == "b" else "b"
        result["value_adjustment"] = {"side": other if adj_value >= 0 else short, "value": round(abs(adj_value))}
    return result


def evaluate_multi(teams: list[dict], scale: float = DEFAULT_SCALE, roster_spot: float = DEFAULT_ROSTER_SPOT) -> dict:
    """Trades among 2-4 teams. Each team is {"name", "gets": [...], "gives": [...]}.

    A team's net is its adjusted value received against adjusted value sent, as a
    share of the larger. The trade is fair when every team is within FAIR_MARGIN.
    """
    rows, adj = [], []
    for t in teams:
        a = adjust(t["gets"], t["gives"], scale, roster_spot)
        adj.append(a)
        rows.append({"name": t.get("name"), "gets": round(a["g"]["total"]), "gives": round(a["v"]["total"]),
                     "net_pct": round(a["pct"] * 100, 1)})
    fair = all(abs(r["net_pct"]) <= FAIR_MARGIN * 100 for r in rows)
    result = {"teams": rows, "verdict": "fair" if fair else "uneven"}
    if not fair:
        loser = min(range(len(rows)), key=lambda i: rows[i]["net_pct"])
        winner = max(range(len(rows)), key=lambda i: rows[i]["net_pct"])
        result["to_balance"] = {
            "receiver": rows[loser]["name"], "sender": rows[winner]["name"],
            "add_value": round(even_out(teams[loser]["gets"], teams[loser]["gives"], scale, roster_spot)),
        }
    return result
