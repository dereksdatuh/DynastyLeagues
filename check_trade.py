"""One-off: Ultimate Dynasty three-team trade check (temporary, not for merge)."""
import json, pathlib
from engine.build import best_lineup
from engine import record, trade

d = json.loads(pathlib.Path("site/data/league-4.json").read_text())
slots = d["league"]["format"]["starting_slots"]
teams = {t["roster_id"]: t for t in d["teams"]}
by_owner = {(t.get("owner") or "").lower(): t for t in d["teams"]}
for t in d["teams"]:
    print("TEAM", t["roster_id"], t["name"], "|", t.get("owner"), "| total", t["total_value"], "starters", t["starter_value"], f"#{t['starter_rank']}",
          t["outlook"], "| proj", t["projection"]["wins"], "-", t["projection"]["losses"], "rank", t["projection"]["rank"], "maxpf", t["projection"]["max_pf"], "maxpf_rank", t["projection"]["max_pf_rank"])
me, sam = by_owner["ds107"], by_owner["samsin123"]
matty = next((t for k, t in by_owner.items() if "matty" in k or "cajun" in k), None)
print("ME", me["roster_id"], "SAM", sam["roster_id"], "MATTY", matty and matty["roster_id"], matty and matty["owner"])
P = {p["id"]: p for p in d["players"]}
name = lambda n: next(p for p in d["players"] if p["name"] == n)
picks = {p["id"]: p for p in d["picks"]}
for p in d["picks"]:
    if p["round"] == 1 and p["year"] in (2027, 2028):
        print("PICK", p["id"], p["label"], p["value"], "holder", p["roster_id"], "orig", p["original_roster_id"], p["tier"])
rd = d["rookie_draft"]
print("RULE", rd["rule"], "ORDER", rd["order"])
for b in rd["board"]:
    if b["round"] == 1:
        print("BOARD", b["label"], "orig", b["original_roster_id"], "holder", b["roster_id"], "pick_value", b["pick_value"], "slot_value", b["slot_value"])
print("CLASS", [(p["name"], p["pos"], p["value"]) for p in rd["class"][:8]])
lamb, caleb, rice, young = (name(n) for n in ("CeeDee Lamb", "Caleb Williams", "Rashee Rice", "Bryce Young"))
for p in (lamb, caleb, rice, young):
    print("PLAYER", p["name"], p["pos"], p["pos_rank"], "value", p["value"], "age", p["age"], "ppg", p.get("ppg"), "ros", p.get("ros_ppg"), "holder", p["roster_id"])
s27 = picks[f"pick:2027:1:{sam['roster_id']}"]
s28 = picks[f"pick:2028:1:{sam['roster_id']}"]
slot102 = next(b for b in rd["board"] if b["label"] == "1.02")
print("SAM 2027", s27, "SAM 2028", s28, "1.02 slot", slot102)
v27 = slot102["slot_value"]
moves = {  # roster_id: (gets, sends)
    me["roster_id"]: ([lamb, {**s27, "value": v27}], [caleb, rice, s28]),
    sam["roster_id"]: ([caleb, s28], [young, {**s27, "value": v27}]),
    matty["roster_id"]: ([young, rice], [lamb]),
}
# Rosters after the trade and what each team's lineup becomes.
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
sigma = d["schedule"]["sigma"]
pb = record.project(ppg_b, cur, sched, d["schedule"]["median_game"], sigma)
pa = record.project(ppg_a, cur, sched, d["schedule"]["median_game"], sigma)
for rid, (gets, sends) in moves.items():
    t = teams[rid]
    gv, sv = [x["value"] for x in gets], [x["value"] for x in sends]
    lv_b = sum(x["value"] for x in best_lineup([P[i] for i in t["players"] if i in P], slots, "value"))
    lv_a = sum(x["value"] for x in best_lineup(after[rid], slots, "value"))
    print("SIDE", t["owner"], "gets", [(x.get("name") or x.get("label"), x["value"]) for x in gets], "sends", [(x.get("name") or x.get("label"), x["value"]) for x in sends],
          "raw", round(sum(gv)), round(sum(sv)), "eff", round(trade.effective(gv)), round(trade.effective(sv)),
          "starters", round(lv_b), "->", round(lv_a), "ppg", round(ppg_b[rid], 1), "->", round(ppg_a[rid], 1),
          "proj", pb[rid]["wins"], "->", pa[rid]["wins"], "rank", pb[rid]["rank"], "->", pa[rid]["rank"], "maxpf", pb[rid]["max_pf"], "->", pa[rid]["max_pf"], "maxpf_rank", pb[rid]["max_pf_rank"], "->", pa[rid]["max_pf_rank"])
# Does the trade move Sam's 2027 slot? (max PF order among non-playoff teams)
po = rd["playoff_teams"]
stand = sorted(teams, key=lambda r: (-pa[r]["wins"], -pa[r]["ppg"]))
outs = sorted(stand[po:], key=lambda r: pa[r]["max_pf"])
print("AFTER ORDER non-playoff by max PF", [(teams[r]["owner"], pa[r]["max_pf"]) for r in outs])
qbs = lambda ps: sorted([(p["name"], p["value"]) for p in ps if p["pos"] == "QB"], key=lambda x: -x[1])
for rid in moves:
    print("QBS", teams[rid]["owner"], "before", qbs([P[i] for i in teams[rid]["players"] if i in P]), "after", qbs(after[rid]))
    print("WRS", teams[rid]["owner"], "after", sorted([(p["name"], p["value"]) for p in after[rid] if p["pos"] == "WR"], key=lambda x: -x[1])[:6])
