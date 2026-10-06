"""Put every market source on one value scale and blend them into a consensus.

Sources differ in curve shape (KTC is flatter at the top than FantasyCalc, for
example), so a simple ratio rescale would distort them. Instead each source is
quantile-mapped onto the reference source using the players they share: the Nth
most valuable shared player in source S is worth what the Nth most valuable
shared player is worth in the reference.
"""

from bisect import bisect_left

SOURCE_WEIGHTS = {"fantasycalc": 1.0, "ktc": 1.0, "dynastyprocess": 0.8}
REFERENCE_ORDER = ["fantasycalc", "ktc", "dynastyprocess"]
MIN_SHARED = 25


class QuantileMap:
    """Monotone piecewise-linear map from paired samples (sorted independently)."""

    def __init__(self, xs: list[float], ys: list[float]):
        pairs = sorted(zip(sorted(xs), sorted(ys)))
        self.xs, self.ys = [], []
        for x, y in pairs:
            if self.xs and x <= self.xs[-1]:
                self.ys[-1] = max(self.ys[-1], y)
                continue
            self.xs.append(x)
            self.ys.append(y)

    def __call__(self, x: float) -> float:
        xs, ys = self.xs, self.ys
        if not xs:
            return x
        if x <= xs[0]:
            return x * ys[0] / xs[0] if xs[0] else ys[0]
        if x >= xs[-1]:
            return x * ys[-1] / xs[-1]
        i = bisect_left(xs, x)
        x0, x1, y0, y1 = xs[i - 1], xs[i], ys[i - 1], ys[i]
        return y0 + (y1 - y0) * (x - x0) / (x1 - x0)


class RatioMap:
    def __init__(self, ratio: float):
        self.ratio = ratio

    def __call__(self, x: float) -> float:
        return x * self.ratio


def _top_mean(values: list[float], n: int = 20) -> float:
    top = sorted(values, reverse=True)[:n]
    return sum(top) / len(top) if top else 0.0


def build_consensus(entries_by_source: dict[str, list[dict]]):
    """Returns (player_values, pick_entries, source_report).

    player_values: sleeper_id -> {"market": consensus, "<source>": mapped value, "trend": ...}
    pick_entries: [(year, round, tier, mapped_value)]
    """
    usable = {s: e for s, e in entries_by_source.items() if e}
    ref = next((s for s in REFERENCE_ORDER if s in usable), None)
    if ref is None:
        return {}, [], {}

    def player_map(entries):
        best: dict[str, float] = {}
        for e in entries:
            if e["kind"] == "player" and e["sleeper_id"]:
                best[e["sleeper_id"]] = max(best.get(e["sleeper_id"], 0), e["value"])
        return best

    ref_players = player_map(usable[ref])
    mappers = {}
    report = {}
    for source, entries in usable.items():
        players = player_map(entries)
        shared = [pid for pid in players if pid in ref_players]
        if source == ref:
            mappers[source] = RatioMap(1.0)
        elif len(shared) >= MIN_SHARED:
            mappers[source] = QuantileMap([players[p] for p in shared], [ref_players[p] for p in shared])
        else:
            ref_top, src_top = _top_mean(list(ref_players.values())), _top_mean(list(players.values()))
            mappers[source] = RatioMap(ref_top / src_top if src_top else 1.0)
        report[source] = {"players": len(players), "shared_with_reference": len(shared), "reference": ref}

    combined: dict[str, dict] = {}
    picks = []
    for source, entries in usable.items():
        fn = mappers[source]
        for e in entries:
            mapped = fn(e["value"])
            if e["kind"] == "pick":
                picks.append((*e["pick"], mapped))
                continue
            if not e["sleeper_id"]:
                continue
            row = combined.setdefault(e["sleeper_id"], {})
            row[source] = max(row.get(source, 0), round(mapped))
            row[f"{source}_raw"] = max(row.get(f"{source}_raw", 0), e["value"])
            if e.get("trend") is not None and source == "fantasycalc":
                row["trend"] = e["trend"]

    for row in combined.values():
        num = den = 0.0
        vals = []
        for source in SOURCE_WEIGHTS:
            if source in row:
                w = SOURCE_WEIGHTS[source]
                num += w * row[source]
                den += w
                vals.append(row[source])
        row["market"] = round(num / den) if den else 0
        row["n_sources"] = len(vals)
        # Disagreement between sites, as a share of consensus value.
        row["spread"] = round((max(vals) - min(vals)) / row["market"], 3) if len(vals) > 1 and row["market"] else 0
    return combined, picks, report
