"""What each team in a league would actually pay for a player or pick.

The market value is one number for everyone. Teams don't trade that way: a team
tanking for the 1.01 prizes early picks, a contender pays for a player who starts
for it today, and in superflex a team with one starting QB pays far more for a
second than a team with three. This module turns each team's situation into a
multiplier on the market value of every asset, per team.

A team's situation:
  mode   -1 (tanking/rebuilding) .. +1 (contending), from where its starters rank,
         where its record projects, and whether it projects at the very bottom
  needs  -1 (deepest room in the league) .. +1 (thinnest), per position
  qb     in superflex, how many startable QBs it has against the QB slots it fills

The multiplier for a team receiving an asset (clamped to FACTOR_CLAMP):
  picks    rebuilders +10% plus up to +25% more the better the pick (an early pick
           in next year's draft is the most prized asset a tanking team can get);
           contenders down to -15%. Picks further out move 70-80% as much.
  age      rebuilders +12% for players 24 and under, up to -30% for players past 26;
           contenders shave up to 8% off young players who wouldn't start for them.
  start    contenders up to +15% for the share of a player's points that would
           land in their lineup.
  need     +/-12% by how thin or deep the team is at the player's position.
  QB       superflex: +25% per missing starting QB (to +50%) for a QB who'd start;
           a team already carrying a spare starter takes 12% off a QB who wouldn't.
"""

from .league import SLOT_ELIGIBILITY

FACTOR_CLAMP = (0.6, 1.6)
MIN_VALUE = 200  # players below this are waiver-level; their multipliers are not worth shipping
OFFENSE = ("QB", "RB", "WR", "TE")


def _lineup_points(roster: list, slots: list) -> float:
    pool = sorted((p for p in roster if (p.get("ros_ppg") or 0) > 0), key=lambda p: -p["ros_ppg"])
    used, total = set(), 0.0
    for slot in sorted(slots, key=lambda s: len(SLOT_ELIGIBILITY[s])):
        for p in pool:
            if p["id"] not in used and p["pos"] in SLOT_ELIGIBILITY[slot]:
                used.add(p["id"])
                total += p["ros_ppg"]
                break
    return total


def _spread(rank: int, n: int) -> float:
    """Rank 1 (best) -> +1, rank n (worst) -> -1."""
    return 1 - 2 * (rank - 1) / (n - 1) if n > 1 else 0.0


def contexts(teams: list, by_id: dict, slots: list, superflex: bool) -> dict:
    n = len(teams)
    # Mode: half where the starters rank, half where the record projects.
    mpf_rank = {t["roster_id"]: i for i, t in enumerate(sorted(teams, key=lambda t: t["projection"]["max_pf"]), 1)}
    out = {}
    for t in teams:
        mode = 0.5 * _spread(t["starter_rank"], n) + 0.5 * _spread(t["projection"]["rank"], n)
        if mpf_rank[t["roster_id"]] <= 2:  # bottom two by max PF: the 1.01/1.02 race
            mode = min(mode, -0.9)
        out[t["roster_id"]] = {"mode": round(mode, 3)}

    # Position rooms: value of each team's top-k at a position, k = typical starters there.
    positions = sorted({g for s in slots for g in SLOT_ELIGIBILITY[s]} & set(OFFENSE)) or list(OFFENSE)
    k_of = {}
    for pos in positions:
        counts = sorted(sum(1 for x in t["lineup"] if by_id[x["id"]]["pos"] == pos) for t in teams)
        k_of[pos] = max(counts[len(counts) // 2], 1)
    for pos in positions:
        rooms = {}
        for t in teams:
            vals = sorted((by_id[i]["value"] for i in t["players"] if i in by_id and by_id[i]["pos"] == pos), reverse=True)
            k = k_of[pos]
            rooms[t["roster_id"]] = sum(vals[:k]) + 0.25 * sum(vals[k:k + 2])
        ranked = sorted(rooms, key=lambda r: -rooms[r])
        for i, rid in enumerate(ranked, 1):
            out[rid].setdefault("needs", {})[pos] = round(-_spread(i, n), 3)

    # Superflex QB count: a QB is startable if his points or his value would make
    # him one of the league's top (teams x QB slots) QBs.
    qb_slots = sum(1 for s in slots if s == "QB") + (sum(1 for s in slots if s == "SUPER_FLEX") if superflex else 0)
    qbs = [p for p in by_id.values() if p["pos"] == "QB"]
    cut = n * max(qb_slots, 1)
    ppg_cut = sorted((p.get("ros_ppg") or 0 for p in qbs), reverse=True)[cut - 1] if len(qbs) >= cut else 0
    val_cut = sorted((p["value"] for p in qbs), reverse=True)[cut - 1] if len(qbs) >= cut else 0
    for t in teams:
        have = sum(1 for i in t["players"] if i in by_id and by_id[i]["pos"] == "QB"
                   and ((by_id[i].get("ros_ppg") or 0) >= ppg_cut * 0.95 or by_id[i]["value"] >= val_cut))
        c = out[t["roster_id"]]
        c["qb"] = {"slots": qb_slots, "startable": have, "superflex": superflex}
        m = c["mode"]
        c["label"] = "tanking" if m <= -0.75 else "rebuilding" if m <= -0.3 else "contending" if m >= 0.3 else "middle"
    return {"teams": out, "qb_ppg_cut": round(ppg_cut, 2), "qb_value_cut": round(val_cut), "room_size": k_of}


def factors(teams: list, players: list, picks: list, slots: list, ctx: dict, first_year: int | None) -> dict:
    """{roster_id: {asset_id: multiplier}}, leaving out multipliers within 1% of 1."""
    by_id = {p["id"]: p for p in players}
    top_pick = max((p["value"] for p in picks), default=1) or 1
    qb_ppg_cut, qb_val_cut = ctx["qb_ppg_cut"], ctx["qb_value_cut"]
    out = {}
    for t in teams:
        rid = t["roster_id"]
        c = ctx["teams"][rid]
        mode = c["mode"]
        roster = [by_id[i] for i in t["players"] if i in by_id]
        on_team = {p["id"] for p in roster}
        base_pts = _lineup_points(roster, slots)
        qb = c["qb"]
        deficit = max(qb["slots"] - qb["startable"], 0) if qb["superflex"] else 0
        surplus = max(qb["startable"] - qb["slots"], 0) if qb["superflex"] else 0
        row = {}
        for p in players:
            if (p.get("value") or 0) < MIN_VALUE:
                continue
            f = 1.0
            age = p.get("age")
            pts = p.get("ros_ppg") or 0
            share = 0.0
            if pts > 0 and (mode > 0 or p["pos"] == "QB"):
                if p["id"] in on_team:
                    gain = base_pts - _lineup_points([x for x in roster if x["id"] != p["id"]], slots)
                else:
                    gain = _lineup_points(roster + [p], slots) - base_pts
                share = min(max(gain / pts, 0.0), 1.0)
            if mode < 0 and age:
                r = -mode
                if age <= 24:
                    f += 0.12 * r
                elif age >= 27:
                    f -= r * min(0.30, 0.06 * (age - 26))
            if mode > 0:
                f += 0.15 * mode * share
                if age and age <= 23 and share < 0.2:
                    f -= 0.08 * mode
            if p["pos"] == "QB" and qb["superflex"]:
                startable = pts >= qb_ppg_cut * 0.95 or p["value"] >= qb_val_cut
                if deficit and startable:
                    f += min(0.25 * deficit, 0.5)
                elif surplus and not (share >= 0.5):
                    f -= 0.12
            elif p["pos"] in c.get("needs", {}):
                f += 0.12 * c["needs"][p["pos"]]
            f = min(max(f, FACTOR_CLAMP[0]), FACTOR_CLAMP[1])
            if abs(f - 1) >= 0.01:
                row[p["id"]] = round(f, 3)
        for pk in picks:
            if not pk.get("value"):
                continue
            near = pk["year"] == first_year
            q = pk["value"] / top_pick
            if mode < 0:
                f = 1 + (-mode) * (0.10 + 0.25 * q) * (1.0 if near else 0.8)
            else:
                f = 1 - mode * 0.15 * (1.0 if near else 0.7)
            f = min(max(f, FACTOR_CLAMP[0]), FACTOR_CLAMP[1])
            if abs(f - 1) >= 0.01:
                row[pk["id"]] = round(f, 3)
        out[rid] = row
    return out
