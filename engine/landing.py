"""Where each team's coming-draft picks land: the rest of the season played out many times.

Each simulated season plays every remaining week (each team's score drawn around
that week's best lineup, byes and injuries out, plus one projection error per team
for the whole season; engine/weeks.py), the league median game too when it has one,
seeds the playoffs the league's way, plays the bracket (byes for the top seeds,
placement games for teams knocked out in the same round), and builds the draft
order by the league's rule: non-playoff teams by lowest max PF or worst record,
playoff teams by finish or by their fixed slots. A pick is then worth the average
value of the slots it landed at, so a middling team's pick carries the chance it
slides into the top three, and a lock for 1.01 is priced as one.

The browser's Playoff Odds tab runs the same kind of simulation for display.
"""

import random

from . import draft, record

SIMS = 3000


def _bracket_finish(seeds: list, score, rng, weeks: list | None = None) -> list:
    """Playoff teams in finishing order (champion first). `score(rid, week)` draws one
    team's score; round i is played in weeks[i] when the league's playoff weeks are known."""
    size = 1
    while size < len(seeds):
        size *= 2
    # Standard bracket positions: 1 v size, 2 v size-1, ...; missing seeds are byes.
    alive = seeds + [None] * (size - len(seeds))
    pos = [0]
    while len(pos) < size:
        n = len(pos) * 2
        pos = [x for p in pos for x in (p, n - 1 - p)]
    alive = [alive[p] for p in pos]
    out_by_round = []
    rnd = [0]

    def play(a, b):
        if a is None:
            return b, a
        if b is None:
            return a, b
        week = weeks[min(rnd[0], len(weeks) - 1)] if weeks else None
        sa, sb = score(a, week), score(b, week)
        return (a, b) if sa >= sb else (b, a)
    while len(alive) > 1:
        nxt, losers = [], []
        for i in range(0, len(alive), 2):
            w, l = play(alive[i], alive[i + 1])
            nxt.append(w)
            if l is not None:
                losers.append(l)
        # Teams knocked out in the same round play for placement.
        placed = []
        rest = sorted(losers, key=lambda r: seeds.index(r))
        while len(rest) >= 2:
            a, b = rest.pop(0), rest.pop(0)
            w, l = play(a, b)
            placed += [w, l]
        placed += rest
        out_by_round.append(placed)
        alive = nxt
        rnd[0] += 1
    finish = [alive[0]]
    for placed in reversed(out_by_round):
        finish += placed
    return finish


def simulate(teams: list, schedule: dict, median_game: bool, sigma: float, rule: str, playoff_teams: int,
             playoff_slots, divisions: dict, sims: int = SIMS, seed: int = 11, weekly: dict | None = None,
             playoff_weeks: list | None = None) -> dict:
    """{roster_id: [count of first-round slot 1, 2, ...]} over `sims` seasons.
    weekly {rid: {week: {"mean", "sd"}}} from engine/weeks.py; without it every week
    is the rest-of-season lineup points with the league's one spread."""
    rng = random.Random(seed)
    n = len(teams)
    ppg = {t["roster_id"]: t.get("ros_ppg") or 0 for t in teams}
    wk = record.Weeks(ppg, sigma, weekly)
    bias = {}

    def score(rid, week):
        mu, sd = wk.get(rid, week) if week is not None else (ppg[rid], sigma)
        return rng.gauss(mu, sd) + bias.get(rid, 0.0)
    rec = {t["roster_id"]: t["record"] for t in teams}
    played = {rid: max((r.get("wins") or 0) + (r.get("losses") or 0) + (r.get("ties") or 0), 1) for rid, r in rec.items()}
    # Each week's max PF runs ahead of points scored by the team's usual bench gap.
    gap = {rid: max(((r.get("max_pf") or 0) - (r.get("fpts") or 0)) / played[rid], 0) for rid, r in rec.items()}
    counts = {rid: [0] * n for rid in ppg}
    use_slots = draft.valid_playoff_slots(playoff_slots, n, playoff_teams)
    for _ in range(sims):
        st = {rid: {"wins": float(r.get("wins") or 0) + 0.5 * (r.get("ties") or 0), "pf": float(r.get("fpts") or 0),
                    "max_pf": float(r.get("max_pf") or 0)} for rid, r in rec.items()}
        bias = {rid: rng.gauss(0, b) for rid, b in wk.bias.items()}
        for week, pairs in schedule.items():
            scores = {rid: score(rid, week) for rid in ppg}
            for a, b in pairs:
                if a in st and b in st:
                    st[a if scores[a] >= scores[b] else b]["wins"] += 1
            if median_game:
                med = sorted(scores.values())[len(scores) // 2]
                for rid, sc in scores.items():
                    if sc > med:
                        st[rid]["wins"] += 1
            for rid, sc in scores.items():
                st[rid]["pf"] += sc
                st[rid]["max_pf"] += sc + gap[rid]
        seeded = record.seed(st, playoff_teams, divisions)
        playoff = seeded[:playoff_teams]
        others = seeded[playoff_teams:]
        if rule == "max_pf":
            others.sort(key=lambda r: st[r]["max_pf"])
        else:
            others.sort(key=lambda r: (st[r]["wins"], st[r]["max_pf"]))
        finish = _bracket_finish(playoff, score, rng, playoff_weeks) if playoff else []
        if use_slots:
            order = [None] * n
            for place, rid in enumerate(finish):
                order[playoff_slots[place] - 1] = rid
            it = iter(others)
            order = [o if o is not None else next(it) for o in order]
        else:
            order = others + list(reversed(finish))
        for i, rid in enumerate(order):
            counts[rid][i] += 1
    return counts


def pick_value(counts: list, rnd: int, n: int, snake: bool, value_of) -> tuple[float, float]:
    """Average value and average slot of a round-`rnd` pick from first-round slot counts."""
    total = sum(counts) or 1
    val = slot_sum = 0.0
    for i, c in enumerate(counts):
        if not c:
            continue
        s1 = i + 1
        slot = n + 1 - s1 if snake and rnd % 2 == 0 else s1
        val += c * value_of((rnd - 1) * n + slot)
        slot_sum += c * slot
    return val / total, slot_sum / total


def odds(counts: list) -> dict:
    """Display summary: chance of a top-3 pick and the 10th-90th percentile slots."""
    total = sum(counts) or 1
    cum, lo, hi = 0, None, None
    for i, c in enumerate(counts):
        cum += c
        if lo is None and cum >= 0.1 * total:
            lo = i + 1
        if hi is None and cum >= 0.9 * total:
            hi = i + 1
    return {"top3": round(sum(counts[:3]) / total, 3), "range": [lo, hi],
            "dist": [round(c / total, 3) for c in counts]}
