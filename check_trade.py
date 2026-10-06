"""One-off: Ultimate Dynasty three-team trade check v2 (temporary, not for merge)."""
import json, pathlib
from engine.build import best_lineup
from engine import record, trade, draft

d = json.loads(pathlib.Path("site/data/league-4.json").read_text())
slots = d["league"]["format"]["starting_slots"]
teams = {t["roster_id"]: t for t in d["teams"]}
by_owner = {(t.get("owner") or "").lower(): t for t in d["teams"]}
me, sam = by_owner["ds107"], by_owner["samsin123"]
matty = next(t for k, t in by_owner.items() if "matty" in k or "cajun" in k)
jc = next(t for k, t in by_owner.items() if "carney" in k)
print("IDS me", me["roster_id"], "sam", sam["roster_id"], "matty", matty["roster_id"], "jc", jc["roster_id"])
P = {p["id"]: p for p in d["players"]}
name = lambda n: next(p for p in d["players"] if p["name"] == n)
picks = {p["id"]: p for p in d["picks"]}
rd = d["rookie_draft"]
print("RULE", rd["rule"], "ORDER", rd["order"], "playoff", rd["playoff_teams"])
slot_of = {}
for b in rd["board"]:
    if b["round"] == 1:
        slot_of[b["original_roster_id"]] = b
        print("BOARD", b["label"], "orig", b["original_roster_id"], "holder", b["roster_id"], "pick_value", b["pick_value"], "slot_value", b["slot_value"])
print("CLASS", [(p["name"], p["pos"], p["value"]) for p in rd["class"][:8]])
caleb, young, stroud = (name(n) for n in ("Caleb Williams", "Bryce Young", "C.J. Stroud"))
for p in (caleb, young, stroud):
    print("PLAYER", p["name"], p["pos"], p["pos_rank"], "value", p["value"], "age", p["age"], "ppg", p.get("ppg"), "ros", p.get("ros_ppg"), "holder", p["roster_id"])

def pk(year, rid, slotted=True):
    p = dict(picks[f"pick:{year}:1:{rid}"])
    if slotted and year == 2027:
        p["value"] = slot_of[rid]["slot_value"]
        p["label"] = f"{p['label']} [{slot_of[rid]['label']}]"
    return p

s27, s28 = pk(2027, sam["roster_id"]), pk(2028, sam["roster_id"])
m27, j27 = pk(2027, matty["roster_id"]), pk(2027, jc["roster_id"])
for p in (s27, s28, m27, j27):
    print("PICK", p["id"], p["label"], p["value"], "holder", p["roster_id"], "orig", p["original_roster_id"])

moves = {  # roster_id: (gets, sends)
    me["roster_id"]: ([stroud, s27], [caleb, s28]),
    sam["roster_id"]: ([caleb, m27, s28], [young, s27, j27]),
    matty["roster_id"]: ([young, j27], [stroud, m27]),
}
after = {}
for rid, t in teams.items():
    ps = [P[i] for i in t["players"] if i in P]
    if rid in moves:
        gets, sends = moves[rid]
        out = {x["id"] for x in sends}
        ps = [p for p in ps if p["id"] not in out] + [x for x in gets if x["id"] in P]
    after[rid] = ps
ppg_b = {rid: sum(x["ros_ppg"] for x in best_lineup([P[i] for i in t["players"] if i in P], slots, "ros_ppg")) for rid, t in teams.items()}
ppg_a = {rid: sum(x["ros_ppg"] for x in best_lineup(after[rid], slots, "ros_ppg")) for rid in teams}
cur = {rid: t["record"] for rid, t in teams.items()}
sched = {int(k): v for k, v in d["schedule"]["weeks"].items()}
pb = record.project(ppg_b, cur, sched, d["schedule"]["median_game"], d["schedule"]["sigma"])
pa = record.project(ppg_a, cur, sched, d["schedule"]["median_game"], d["schedule"]["sigma"])
for rid, (gets, sends) in moves.items():
    t = teams[rid]
    gv, sv = [x["value"] for x in gets], [x["value"] for x in sends]
    lv_b = sum(x["value"] for x in best_lineup([P[i] for i in t["players"] if i in P], slots, "value"))
    lv_a = sum(x["value"] for x in best_lineup(after[rid], slots, "value"))
    print("SIDE", t["owner"], "gets", [(x.get("name") or x.get("label"), x["value"]) for x in gets], "sends", [(x.get("name") or x.get("label"), x["value"]) for x in sends],
          "raw", round(sum(gv)), round(sum(sv)), "eff", round(trade.effective(gv)), round(trade.effective(sv)),
          "starters", round(lv_b), "->", round(lv_a), "ppg", round(ppg_b[rid], 1), "->", round(ppg_a[rid], 1),
          "proj", pb[rid]["wins"], "->", pa[rid]["wins"], "rank", pb[rid]["rank"], "->", pa[rid]["rank"], "maxpf", pb[rid]["max_pf"], "->", pa[rid]["max_pf"], "maxpf_rank", pb[rid]["max_pf_rank"], "->", pa[rid]["max_pf_rank"])

# Projected 2027 order after the trade, and what each traded pick becomes.
po = rd["playoff_teams"]
tlist = [{"roster_id": r, "projection": pa[r]} for r in teams]
order2 = draft.project_order(tlist, rd["rule"], po)
n = len(order2)
sv_by_slot = {b["slot"]: b["slot_value"] for b in rd["board"] if b["round"] == 1}
print("AFTER ORDER", [(teams[r]["owner"], pa[r]["max_pf"], pa[r]["wins"]) for r in order2])
for lbl, p in (("SAM27", s27), ("MATTY27", m27), ("JC27", j27)):
    orig = p["original_roster_id"]
    i = order2.index(orig) + 1
    print("AFTER SLOT", lbl, teams[orig]["owner"], "slot 1.%02d" % i, "value", sv_by_slot[i],
          "| was", slot_of[orig]["label"], "value", slot_of[orig]["slot_value"])
stand = sorted(teams, key=lambda r: (-pa[r]["wins"], -pa[r]["ppg"]))
print("AFTER non-playoff by maxpf", [(teams[r]["owner"], pa[r]["max_pf"]) for r in sorted(stand[po:], key=lambda r: pa[r]["max_pf"])])
qbs = lambda ps: sorted([(p["name"], p["value"]) for p in ps if p["pos"] == "QB"], key=lambda x: -x[1])[:5]
for rid in moves:
    print("QBS", teams[rid]["owner"], "before", qbs([P[i] for i in teams[rid]["players"] if i in P]), "after", qbs(after[rid]))
