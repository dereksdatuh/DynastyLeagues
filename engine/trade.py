"""Trade evaluation with a consolidation premium.

Two 3,000 players are not worth one 6,000 player: the stud takes one roster spot
and one lineup slot. Each side's value is a power sum, (Σ vᵖ)^(1/p) with p > 1,
which rewards the side getting the best piece. p = 1 would be a plain sum.
The same formula runs in the browser (site/app.js) so both agree.
"""

CONSOLIDATION_POWER = 1.35
FAIR_MARGIN = 0.05


def effective(values: list[float], p: float = CONSOLIDATION_POWER) -> float:
    vals = [v for v in values if v > 0]
    return sum(v ** p for v in vals) ** (1 / p) if vals else 0.0


def balance_needed(short_side: list[float], target: float, p: float = CONSOLIDATION_POWER) -> float:
    """Value of the single piece that brings `short_side` up to `target` effective value."""
    have = sum(v ** p for v in short_side if v > 0)
    need = target ** p - have
    return need ** (1 / p) if need > 0 else 0.0


def evaluate(side_a: list[dict], side_b: list[dict], p: float = CONSOLIDATION_POWER) -> dict:
    va = [x["value"] for x in side_a]
    vb = [x["value"] for x in side_b]
    ea, eb = effective(va, p), effective(vb, p)
    top = max(ea, eb) or 1
    pct = (ea - eb) / top
    if abs(pct) <= FAIR_MARGIN:
        verdict, short, target = "fair", None, None
    elif pct > 0:
        verdict, short, target = "side A receives more", "b", ea
    else:
        verdict, short, target = "side B receives more", "a", eb
    result = {
        "raw": {"a": round(sum(va)), "b": round(sum(vb))},
        "effective": {"a": round(ea), "b": round(eb)},
        "difference_pct": round(pct * 100, 1),
        "verdict": verdict,
    }
    if short:
        result["to_balance"] = {"side": short, "add_value": round(balance_needed(vb if short == "b" else va, target, p))}
    return result
