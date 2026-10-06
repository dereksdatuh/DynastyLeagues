"""One-off: Ultimate Dynasty three-team trade builder (temporary, not for merge)."""
import json, pathlib, itertools
from engine.build import best_lineup
from engine import record, trade, draft

d = json.loads(pathlib.Path("site/data/league-4.json").read_text())
slots = d["league"]["format"]["starting_slots"]
teams = {t["roster_id"]: t for t in d["teams"]}
by_owner = {(t.get("owner") or "").lower(): t for t in d["teams"]}
ME, SAM = by_owner["ds107"]["roster_id"], by_owner["samsin123"]["roster_id"]
MAT = next(t for k, t in by_owner.items() if "cajun" in k)["roster_id"]
FFB = next(t for k, t in by_owner.items() if "ffbros" in k)["roster_id"]
P = {p["id"]: p for p in d["players"]}
name = lambda n: next(p for p in d["players"] if p["name"] == n)
picks = {p["id"]: p for p in d["picks"]}
rd = d["rookie_draft"]
po = rd["playoff_teams"]
slot_of = {b["original_roster_id"]: b for b in rd["board"] if b["round"] == 1}
sv_by_slot = {b["slot"]: b["slot_value"] for b in rd["board"] if b["round"] == 1}
cur = {rid: t["record"] for rid, t in teams.items()}
sched = {int(k): v for k, v in d["schedule"]["weeks"].items()}
print("WEEKS left", len(sched), "slots", slots)
roster = lambda rid: [P[i] for i in teams[rid]["players"] if i in P]
ppg = lambda ps: sum(x["ros_ppg"] for x in best_lineup(ps, slots, "ros_ppg"))
proj = lambda m: record.project(m, cur, sched, d["schedule"]["median_game"], d["schedule"]["sigma"])
base_ppg = {r: ppg(roster(r)) for r in teams}
pb = proj(base_ppg)

def pk(year, rid, rnd=1):
    p = dict(picks[f"pick:{year}:{rnd}:{rid}"])
    if year == 2027 and rnd == 1:
        p["value"] = slot_of[rid]["slot_value"]; p["label"] = f"{p['label']} [{slot_of[rid]['label']}]"
    return p

def show(tag, p):
    return [(x.get("name") or x.get("label"), round(x["value"])) for x in p]

def run(tag, moves):
    after = {}
    for rid in teams:
        ps = roster(rid)
        if rid in moves:
            gets, sends = moves[rid]
            out = {x["id"] for x in sends}
            ps = [p for p in ps if p["id"] not in out] + [x for x in gets if x["id"] in P]
        after[rid] = ps
    pa = proj({r: ppg(after[r]) for r in teams})
    order2 = draft.project_order([{"roster_id": r, "projection": pa[r]} for r in teams], rd["rule"], po)
    print(f"=== {tag}")
    for rid, (gets, sends) in moves.items():
        gv, sv = [x["value"] for x in gets], [x["value"] for x in sends]
        lb = sum(x["value"] for x in best_lineup(roster(rid), slots, "value"))
        la = sum(x["value"] for x in best_lineup(after[rid], slots, "value"))
        print(f"SIDE {tag} {teams[rid]['owner']} gets {show(tag, gets)} sends {show(tag, sends)} raw {round(sum(gv))} vs {round(sum(sv))} eff {round(trade.effective(gv))} vs {round(trade.effective(sv))} "
              f"starters {round(lb)}->{round(la)} ppg {base_ppg[rid]:.1f}->{ppg(after[rid]):.1f} wins {pb[rid]['wins']}->{pa[rid]['wins']} maxpf {pb[rid]['max_pf']}->{pa[rid]['max_pf']}")
    for lbl, orig in (("SAM27", SAM), ("MAT27", MAT)):
        i = order2.index(orig) + 1
        print(f"SLOT {tag} {lbl} 1.{i:02d} value {sv_by_slot[i]}")
    print(f"PF {tag} Sam {pa[SAM]['max_pf']} FFBros {pa[FFB]['max_pf']} gap {round(pa[SAM]['max_pf'] - pa[FFB]['max_pf'], 1)}")
    return after, pa

caleb, young, hurts, rice = (name(n) for n in ("Caleb Williams", "Bryce Young", "Jalen Hurts", "Rashee Rice"))
for p in (caleb, young, hurts, rice):
    print("PLAYER", p["name"], p["pos"], p["pos_rank"], "value", p["value"], "age", p["age"], "ros", p.get("ros_ppg"), "holder", p["roster_id"])
s27, s28, m27 = pk(2027, SAM), pk(2028, SAM), pk(2027, MAT)

# Derek's assets that could go to Sam without lifting his points: picks and bench players.
my_line = {x["id"] for x in best_lineup(roster(ME), slots, "ros_ppg")}
sam_ppg0 = ppg([p for p in roster(SAM) if p["id"] != young["id"]])
cands = []
for p in d["picks"]:
    if p["roster_id"] == ME and p["id"] != s28["id"]:
        cands.append(dict(p, pf=0.0))
for p in roster(ME):
    if p["id"] not in my_line and p["id"] not in (caleb["id"],) and p["value"] >= 300:
        cands.append(dict(p, pf=round(ppg([q for q in roster(SAM) if q["id"] != young["id"]] + [p]) - sam_ppg0, 2)))
cands.sort(key=lambda x: -x["value"])
for c in cands[:25]:
    print("MINE", c.get("name") or c.get("label"), c.get("pos", "pick"), round(c["value"]), "age", c.get("age"), "ros", c.get("ros_ppg"), "sam_ppg_add", c["pf"])
print("SAMLINE", [(x["name"], x["pos"], x["ros_ppg"], x["value"]) for x in best_lineup(roster(SAM), slots, "ros_ppg")])
print("FFBLINE", [(x["name"], x["pos"], x["ros_ppg"]) for x in best_lineup(roster(FFB), slots, "ros_ppg")])
print("MATQB", sorted([(p["name"], p["value"], p["ros_ppg"]) for p in roster(MAT) if p["pos"] == "QB"], key=lambda x: -x[1]))
print("MEQB", sorted([(p["name"], p["value"], p["ros_ppg"]) for p in roster(ME) if p["pos"] == "QB"], key=lambda x: -x[1]))

core_sam = ([m27, s28], [young, s27])
V = {
  "A_hurts_for_caleb": {ME: ([s27, hurts], [s28, caleb]), SAM: core_sam, MAT: ([young, caleb], [m27, hurts])},
  "B_hurts_for_rice": {ME: ([s27, hurts], [s28, rice]), SAM: core_sam, MAT: ([young, rice], [m27, hurts])},
  "C_no_hurts_derek": {ME: ([s27], [s28]), SAM: core_sam, MAT: ([young], [m27])},
}
for tag, mv in V.items():
    run(tag, mv)

# Variant A plus the cheapest pick/bench adds to Sam (no points) until Sam is within the fair margin.
def balance(tag, mv):
    gets, sends = mv[SAM]
    add = []
    pool = [c for c in cands if c["pf"] <= 0.5]
    for c in sorted(pool, key=lambda x: x["value"]):
        pass
    best = None
    for k in (1, 2, 3):
        for combo in itertools.combinations(pool[:14], k):
            g = [x["value"] for x in gets] + [c["value"] for c in combo]
            if trade.effective(g) >= trade.effective([x["value"] for x in sends]) * 0.97:
                cost = sum(c["value"] for c in combo)
                if best is None or cost < best[0]:
                    best = (cost, combo)
        if best:
            break
    if not best:
        print("BAL", tag, "none"); return
    combo = list(best[1])
    mv2 = {**mv, ME: (mv[ME][0], mv[ME][1] + combo), SAM: (gets + combo, sends)}
    run(tag + "+sweetener", mv2)
for tag in ("A_hurts_for_caleb", "B_hurts_for_rice"):
    balance(tag, V[tag])
