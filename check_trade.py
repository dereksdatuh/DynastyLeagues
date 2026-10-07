"""One-off: Ultimate Dynasty three-team deal search (temporary, not for merge)."""
import json, pathlib, itertools
from engine.build import best_lineup
from engine import trade

d = json.loads(pathlib.Path("site/data/league-4.json").read_text())
slots = d["league"]["format"]["starting_slots"]
teams = {t["roster_id"]: t for t in d["teams"]}
own = lambda k: next(t for t in d["teams"] if k in (t.get("owner") or "").lower())["roster_id"]
ME, SAM, MAT, FFB = own("ds107"), own("samsin123"), own("cajun"), own("ffbros")
P = {p["id"]: p for p in d["players"]}
K = {p["id"]: p for p in d["picks"]}
A = {**P, **K}
fac = {int(k): v for k, v in d["team_values"]["factors"].items()}
ctx = {int(k): v for k, v in d["team_values"]["context"]["teams"].items()}
weeks = len(d["schedule"]["weeks"])
name = lambda n: next(p for p in d["players"] if p["name"] == n)
ppg = lambda ps: sum(x["ros_ppg"] for x in best_lineup(ps, slots, "ros_ppg"))
roster = {r: [P[i] for i in t["players"] if i in P] for r, t in teams.items()}
maxpf = lambda r, ps: round(teams[r]["record"]["max_pf"] + ppg(ps) * weeks, 1)
lbl = lambda a: a.get("name") or a.get("label")
for r in (ME, SAM, MAT, FFB):
    print("CTX", teams[r]["owner"], ctx[r]["label"], ctx[r]["mode"], "QB", ctx[r]["qb"], "maxpf now", teams[r]["projection"]["max_pf"])

corum, young, addison, hurts = (name(n) for n in ("Blake Corum", "Bryce Young", "Jordan Addison", "Jalen Hurts"))
for p in (corum, young, addison, hurts):
    print("PLAYER", p["name"], p["pos"], "value", p["value"], "age", p["age"], "ros", p["ros_ppg"], "holder", teams[p["roster_id"]]["owner"],
          "to me", round(p["value"] * fac[ME].get(p["id"], 1)), "to sam", round(p["value"] * fac[SAM].get(p["id"], 1)), "to matty", round(p["value"] * fac[MAT].get(p["id"], 1)))
s27, s28, j27, m27 = K[f"pick:2027:1:{SAM}"], K[f"pick:2028:1:{SAM}"], K["pick:2027:1:3"], K[f"pick:2027:1:{MAT}"]
for p in (s27, s28, j27, m27):
    print("PICK", p["id"], p["label"], p["value"], "holder", teams[p["roster_id"]]["owner"],
          "to me", round(p["value"] * fac[ME].get(p["id"], 1)), "to sam", round(p["value"] * fac[SAM].get(p["id"], 1)), "to matty", round(p["value"] * fac[MAT].get(p["id"], 1)))
myqbs = sorted((p for p in roster[ME] if p["pos"] == "QB"), key=lambda p: -p["value"])
print("MYQB", [(p["name"], p["value"], p["ros_ppg"], p["age"]) for p in myqbs])
print("MATQB", [(p["name"], p["value"], p["ros_ppg"]) for p in sorted(roster[MAT], key=lambda p: -p["value"]) if p["pos"] == "QB"])

base_core = {  # (from, to, asset)
    "core": [(SAM, ME, s27), (SAM, ME, corum), (SAM, MAT, young), (SAM, MAT, addison), (SAM, MAT, j27),
             (ME, SAM, s28), (MAT, ME, hurts), (MAT, SAM, m27)],
}
# Pool to balance Sam with things that won't start for him: picks, and non-starters.
sam_line_now = ppg([p for p in roster[SAM] if p["id"] not in (corum["id"], young["id"], addison["id"])])
pool = []
for owner in (ME, MAT):
    for pk in d["picks"]:
        if pk["roster_id"] == owner and pk["id"] not in (s28["id"], s27["id"], j27["id"], m27["id"], f"pick:2028:1:{MAT}", f"pick:2029:1:{MAT}") and pk["value"] >= 300:
            pool.append((owner, pk))
    for p in roster[owner]:
        if p["id"] in (hurts["id"],) or p["pos"] == "QB" or p["value"] < 400:
            continue
        add = ppg([q for q in roster[SAM] if q["id"] not in (corum["id"], young["id"], addison["id"])] + [p]) - sam_line_now
        if add <= 0.5:
            pool.append((owner, p))
pool.sort(key=lambda x: -x[1]["value"])
pool = pool[:15]
print("POOL", [(teams[o]["owner"], lbl(a), a["value"], round(a["value"] * fac[SAM].get(a["id"], 1))) for o, a in pool])

def evaluate(moves):
    gets = {r: [] for r in (ME, SAM, MAT)}
    gives = {r: [] for r in (ME, SAM, MAT)}
    for fr, to, a in moves:
        gets[to].append(a); gives[fr].append(a)
    res = {}
    for r in (ME, SAM, MAT):
        mg = trade.effective([a["value"] for a in gets[r]]); mv = trade.effective([a["value"] for a in gives[r]])
        tg = trade.effective([a["value"] * fac[r].get(a["id"], 1) for a in gets[r]]); tv = trade.effective([a["value"] * fac[r].get(a["id"], 1) for a in gives[r]])
        out = {a["id"] for a in gives[r]}
        ps = [p for p in roster[r] if p["id"] not in out] + [a for a in gets[r] if a["id"] in P]
        res[r] = {"m": (mg - mv) / max(mg, mv, 1), "t": (tg - tv) / max(tg, tv, 1), "mg": mg, "mv": mv, "tg": tg, "tv": tv,
                  "ppg0": ppg(roster[r]), "ppg1": ppg(ps), "maxpf": maxpf(r, ps)}
    return res

stroud = name("C.J. Stroud")
caleb = name("Caleb Williams")
print("PLAYER", stroud["name"], stroud["value"], stroud["ros_ppg"], "to me", round(stroud["value"] * fac[ME].get(stroud["id"], 1)))
m28 = K[f"pick:2028:1:{MAT}"]; d29 = K[f"pick:2029:1:{ME}"]; m2_27 = K[f"pick:2027:2:{MAT}"]
d2_28 = next(pk for pk in d["picks"] if pk["roster_id"] == ME and pk["id"].startswith("pick:2028:2:") and "Gruden" in pk["label"])
derek = base_core["core"] + [(MAT, ME, stroud), (ME, MAT, caleb), (ME, SAM, d29), (ME, SAM, d2_28), (MAT, SAM, m28), (MAT, SAM, m2_27)]
r = evaluate(derek)
for fr, to, a in derek:
    print("DMOVE", teams[fr]["owner"], "->", teams[to]["owner"], lbl(a), a["value"], "to receiver", round(a["value"] * fac[to].get(a["id"], 1)))
for x in r:
    print("DSIDE", teams[x]["owner"], f"team {r[x]['t']*100:+.1f}% mkt {r[x]['m']*100:+.1f}%", {k: (round(v, 1) if isinstance(v, float) else v) for k, v in r[x].items()})
# variant: same but Stroud stays with Matty
r2 = evaluate([m for m in derek if m[2] is not stroud])
print("NOSTROUD", " ".join(f"{teams[x]['owner']} team {r2[x]['t']*100:+.1f}% mkt {r2[x]['m']*100:+.1f}% ppg {r2[x]['ppg1']:.1f} maxpf {r2[x]['maxpf']}" for x in r2))
qbs_after = sorted([p for p in roster[ME] if p["pos"] == "QB" and p["id"] != caleb["id"]] + [hurts, stroud], key=lambda p: -p["ros_ppg"])
print("DQB", [(p["name"], p["ros_ppg"], p["value"]) for p in qbs_after])
print("MATQB_AFTER", [(p["name"], p["ros_ppg"]) for p in sorted([p for p in roster[MAT] if p["pos"] == "QB" and p["id"] not in (hurts["id"], stroud["id"])] + [young, caleb], key=lambda p: -p["ros_ppg"])][:4])
DES = own("desmith99")
TEAMS4 = (ME, SAM, MAT, DES)
print("CTX", teams[DES]["owner"], ctx[DES]["label"], ctx[DES]["mode"], "QB", ctx[DES]["qb"], "maxpf now", teams[DES]["projection"]["max_pf"])
def ev4(moves):
    gets = {r: [] for r in TEAMS4}; gives = {r: [] for r in TEAMS4}
    for fr, to, a in moves:
        gets[to].append(a); gives[fr].append(a)
    res = {}
    for r in TEAMS4:
        mg = trade.effective([a["value"] for a in gets[r]]); mv = trade.effective([a["value"] for a in gives[r]])
        tg = trade.effective([a["value"] * fac[r].get(a["id"], 1) for a in gets[r]]); tv = trade.effective([a["value"] * fac[r].get(a["id"], 1) for a in gives[r]])
        out = {a["id"] for a in gives[r]}
        ps = [p for p in roster[r] if p["id"] not in out] + [a for a in gets[r] if a["id"] in P]
        res[r] = {"m": (mg - mv) / max(mg, mv, 1), "t": (tg - tv) / max(tg, tv, 1), "ppg0": ppg(roster[r]), "ppg1": ppg(ps), "maxpf": maxpf(r, ps)}
    return res
import re as _re
def fname(n):
    key = _re.sub(r"[^a-z]", "", n.lower())
    hits = [p for p in d["players"] if key in _re.sub(r"[^a-z]", "", p["name"].lower())]
    print("LOOKUP", n, [(p["name"], p["pos"], teams[p["roster_id"]]["owner"] if p.get("roster_id") in teams else None) for p in hits][:4])
    return sorted(hits, key=lambda p: -p["value"])[0]
rice, simpson, metcalf, mhj = (fname(n) for n in ("Rashee Rice", "Ty Simpson", "Metcalf", "Marvin Harrison"))
for p in (rice, simpson, metcalf, mhj):
    print("PLAYER", p["name"], p["pos"], p["value"], "age", p["age"], "ros", p["ros_ppg"], "holder", teams[p["roster_id"]]["owner"], "to sam", round(p["value"] * fac[SAM].get(p["id"], 1)))
des27 = K[f"pick:2027:1:{DES}"]
print("PICK", des27["label"], des27["value"])
four = [(SAM, ME, s27), (ME, MAT, rice), (ME, SAM, s28),
        (MAT, DES, hurts), (SAM, DES, addison), (MAT, DES, metcalf), (DES, SAM, simpson), (DES, MAT, mhj), (DES, SAM, des27),
        (SAM, MAT, young), (SAM, MAT, corum), (MAT, SAM, m27)]
r = ev4(four)
print("FOUR", " | ".join(f"{teams[x]['owner']} team {r[x]['t']*100:+.1f}% mkt {r[x]['m']*100:+.1f}% ppg {r[x]['ppg0']:.1f}->{r[x]['ppg1']:.1f} maxpf {r[x]['maxpf']}" for x in r))
sam_after = [p for p in roster[SAM] if p["id"] not in (corum["id"], young["id"], addison["id"])]
print("SIMPSON_EFFECT", round(ppg(sam_after + [simpson]) - ppg(sam_after), 2), "sam lineup", [(x.get("name"), x["ros_ppg"]) for x in best_lineup(sam_after + [simpson], slots, "ros_ppg")][:3])
print("LOWMAX", sorted(((teams[t]['owner'], r[t]['maxpf'] if t in r else teams[t]['projection']['max_pf']) for t in teams), key=lambda x: x[1])[:3])
used = {m[2]["id"] for m in four}
mylu = {x["id"] for x in best_lineup([p for p in roster[ME] if p["id"] != rice["id"]], slots, "ros_ppg")}
dp = [pk for pk in d["picks"] if pk["roster_id"] == ME and pk["id"] not in used and pk["value"] >= 250]
dp += [p for p in roster[ME] if p["id"] not in used and p["id"] not in mylu and p["value"] >= 300]
dp.sort(key=lambda a: -a["value"]); dp = dp[:10]
print("DP", [(lbl(a), a["value"]) for a in dp])
sb = ppg(sam_after + [simpson])
res = []
for k in range(0, 4):
    for combo in itertools.combinations(dp, k):
        for dest in itertools.product((SAM, MAT, DES), repeat=k):
            if any(t == SAM and a["id"] in P and ppg(sam_after + [simpson, a]) - sb > 0.5 for a, t in zip(combo, dest)):
                continue
            rr = ev4(four + [(ME, t, a) for a, t in zip(combo, dest)])
            if all(rr[x]["t"] >= -0.05 for x in rr):
                res.append((k, -rr[ME]["t"], [f"{lbl(a)}->{teams[t]['owner']}" for a, t in zip(combo, dest)], rr))
res.sort(key=lambda x: (x[0], x[1]))
for k, _, c, rr in res[:8]:
    print("FIX", k, c, "|", " ".join(f"{teams[x]['owner']} team {rr[x]['t']*100:+.1f}% mkt {rr[x]['m']*100:+.1f}%" for x in rr))
print("NFIX", len(res))
deslu = {x["id"] for x in best_lineup([p for p in roster[DES] if p["id"] not in (simpson["id"], mhj["id"])] + [hurts, addison, metcalf], slots, "ros_ppg")}
matlu = {x["id"] for x in best_lineup([p for p in roster[MAT] if p["id"] not in (hurts["id"], metcalf["id"])] + [young, corum, mhj, rice], slots, "ros_ppg")}
xp = [(DES, pk) for pk in d["picks"] if pk["roster_id"] == DES and pk["id"] not in used and pk["value"] >= 300]
xp += [(DES, p) for p in roster[DES] if p["id"] not in used and p["id"] not in deslu and p["value"] >= 400]
xp += [(ME, a) for a in dp[:7]]
xp.sort(key=lambda x: -x[1]["value"]); xp = xp[:16]
print("XP", [(teams[o]["owner"], lbl(a), a["value"]) for o, a in xp])
ok = lambda rr: all(rr[x]["t"] >= -0.05 and rr[x]["m"] >= -0.05 for x in rr)
res = []
for k in range(1, 5):
    for combo in itertools.combinations(xp, k):
        for dest in itertools.product((SAM, MAT), repeat=k):
            if any(t == SAM and a["id"] in P and ppg(sam_after + [simpson, a]) - sb > 0.5 for (o, a), t in zip(combo, dest)):
                continue
            rr = ev4(four + [(o, t, a) for (o, a), t in zip(combo, dest)])
            if ok(rr):
                spread = max(abs(rr[x]["m"]) for x in rr) + max(abs(rr[x]["t"]) for x in rr)
                res.append((k, spread, [f"{teams[o]['owner']}:{lbl(a)}->{teams[t]['owner']}" for (o, a), t in zip(combo, dest)], rr))
    if res: break
res.sort(key=lambda x: (x[0], x[1]))
for k, sp, c, rr in res[:8]:
    print("XFIX", k, c, "|", " ".join(f"{teams[x]['owner']} team {rr[x]['t']*100:+.1f}% mkt {rr[x]['m']*100:+.1f}% ppg {rr[x]['ppg0']:.1f}->{rr[x]['ppg1']:.1f} maxpf {rr[x]['maxpf']}" for x in rr))
print("NXFIX", len(res))
# Earlier fair versions under the new math
wil, jcm = fname("Malik Willis"), fname("Croskey-Merritt")
d29_2 = next(pk for pk in d["picks"] if pk["roster_id"] == ME and pk["id"].startswith("pick:2029:2:"))
d29_3 = next(pk for pk in d["picks"] if pk["roster_id"] == ME and pk["id"].startswith("pick:2029:3:"))
d29_4 = next(pk for pk in d["picks"] if pk["roster_id"] == ME and pk["id"].startswith("pick:2029:4:"))
big = derek + [(ME, SAM, d29_2), (ME, SAM, d29_4), (ME, MAT, d29_3), (ME, MAT, jcm)]
d2_28 = next(pk for pk in d["picks"] if pk["roster_id"] == ME and pk["id"].startswith("pick:2028:2:"))
slim = [(SAM, ME, s27), (SAM, ME, corum), (ME, SAM, s28), (ME, SAM, d2_28), (ME, SAM, K[f"pick:2029:1:{ME}"]), (MAT, SAM, m27), (SAM, MAT, young), (SAM, MAT, addison), (MAT, SAM, m2_27), (ME, MAT, wil), (ME, SAM, d29_2)]
for nm, mv in (("BIG18", big), ("SLIMWILLIS", slim)):
    rr = evaluate(mv)
    print(nm, " ".join(f"{teams[x]['owner']} team {rr[x]['t']*100:+.1f}% mkt {rr[x]['m']*100:+.1f}% ppg {rr[x]['ppg0']:.1f}->{rr[x]['ppg1']:.1f} maxpf {rr[x]['maxpf']}" for x in rr))
pitts = fname("Kyle Pitts"); des2 = K[f"pick:2027:2:{DES}"]
evenm = four + [(DES, MAT, pitts), (DES, SAM, des2)]
for r_ in TEAMS4:
    g = [a for fr, to, a in evenm if to == r_]; v = [a for fr, to, a in evenm if fr == r_]
    fmtl = lambda xs: "; ".join(f"{lbl(a)} {a['value']} (x{fac[r_].get(a['id'], 1):.3f}={round(a['value'] * fac[r_].get(a['id'], 1))})" for a in xs)
    rg, rv = sum(a["value"] for a in g), sum(a["value"] for a in v)
    eg, evv = trade.effective([a["value"] for a in g]), trade.effective([a["value"] for a in v])
    tg = trade.effective([a["value"] * fac[r_].get(a["id"], 1) for a in g]); tv = trade.effective([a["value"] * fac[r_].get(a["id"], 1) for a in v])
    print("MATH", teams[r_]["owner"], "| IN:", fmtl(g), "| OUT:", fmtl(v), f"| raw {rg} vs {rv} | adj {eg:.0f} vs {evv:.0f} = {(eg-evv)/max(eg,evv)*100:+.1f}% | team {tg:.0f} vs {tv:.0f} = {(tg-tv)/max(tg,tv)*100:+.1f}%")
samv = evenm + [(ME, SAM, d29)]
rr = ev4(samv)
print("SAMV", " | ".join(f"{teams[x]['owner']} team {rr[x]['t']*100:+.1f}% mkt {rr[x]['m']*100:+.1f}% ppg {rr[x]['ppg0']:.1f}->{rr[x]['ppg1']:.1f} maxpf {rr[x]['maxpf']}" for x in rr))
print("D29", lbl(d29), d29["value"], "to sam", round(d29["value"] * fac[SAM].get(d29["id"], 1)))
print("LOWMAX2", sorted(((teams[t]['owner'], rr[t]['maxpf'] if t in rr else teams[t]['projection']['max_pf']) for t in teams), key=lambda x: x[1])[:3])
# ways to win something back: drop one of Sam's other incoming pieces, or Sam sends Derek something
sam_in = [m for m in samv if m[1] == SAM and m[2] is not d29]
for m in sam_in:
    r3 = ev4([x for x in samv if x is not m])
    print("DROP", lbl(m[2]), "from", teams[m[0]]["owner"], "|", " ".join(f"{teams[x]['owner']} team {r3[x]['t']*100:+.1f}% mkt {r3[x]['m']*100:+.1f}%" for x in r3))
usedv = {m[2]["id"] for m in samv}
back = [pk for pk in d["picks"] if pk["roster_id"] == SAM and pk["id"] not in usedv and pk["value"] >= 250]
back += [p for p in roster[SAM] if p["id"] not in usedv and p["value"] >= 300]
back.sort(key=lambda a: -a["value"])
for a in back[:14]:
    r3 = ev4(samv + [(SAM, ME, a)])
    print("BACK", lbl(a), a["value"], "|", " ".join(f"{teams[x]['owner']} team {r3[x]['t']*100:+.1f}% mkt {r3[x]['m']*100:+.1f}% ppg {r3[x]['ppg0']:.1f}->{r3[x]['ppg1']:.1f} maxpf {r3[x]['maxpf']}" for x in r3))
print("STROUD", stroud["name"], stroud["value"], "holder", teams[stroud["roster_id"]]["owner"], "ros", stroud["ros_ppg"], "hurts", hurts["value"], hurts["ros_ppg"])
fmt = lambda rr: " | ".join(f"{teams[x]['owner']} team {rr[x]['t']*100:+.1f}% mkt {rr[x]['m']*100:+.1f}% ppg {rr[x]['ppg0']:.1f}->{rr[x]['ppg1']:.1f} maxpf {rr[x]['maxpf']:.0f}" for x in rr)
sw = lambda mv: [(fr, to, stroud if a is hurts else a) for fr, to, a in mv]
for nm, mv in (("ST_EVEN", sw(evenm)), ("ST_29", sw(samv))):
    print(nm, fmt(ev4(mv)))
print("LOWMAX3", sorted(((teams[t]['owner'], ev4(sw(samv))[t]['maxpf'] if t in TEAMS4 else teams[t]['projection']['max_pf']) for t in teams), key=lambda x: x[1])[:3])
base = sw(samv)
usedb = {m[2]["id"] for m in base} | {hurts["id"]}
matlu2 = {x["id"] for x in best_lineup([p for p in roster[MAT] if p["id"] not in (stroud["id"], metcalf["id"])] + [young, corum, mhj, rice, pitts], slots, "ros_ppg")}
cand = [(MAT, pk) for pk in d["picks"] if pk["roster_id"] == MAT and pk["id"] not in usedb and pk["value"] >= 300]
cand += [(MAT, p) for p in roster[MAT] if p["id"] not in usedb and p["id"] not in matlu2 and p["value"] >= 400]
cand += [(SAM, pk) for pk in d["picks"] if pk["roster_id"] == SAM and pk["id"] not in usedb and pk["value"] >= 300]
cand.sort(key=lambda x: -x[1]["value"]); cand = cand[:14]
print("CAND", [(teams[o]["owner"], lbl(a), a["value"]) for o, a in cand])
drops = [m for m in base if m[0] == DES]
res = []
for k in range(0, 4):
    for combo in itertools.combinations(cand, k):
        for dest in itertools.product((ME, SAM, DES), repeat=k):
            if any(o == t for (o, a), t in zip(combo, dest)): continue
            if any(t == SAM and a["id"] in P for (o, a), t in zip(combo, dest)): continue
            for dr in [None] + drops:
                mv = [m for m in base if m is not dr] + [(o, t, a) for (o, a), t in zip(combo, dest)]
                rr = ev4(mv)
                if all(rr[x]["t"] >= -0.05 and rr[x]["m"] >= -0.05 for x in rr):
                    sp = max(abs(rr[x]["m"]) for x in rr)
                    res.append((k + (dr is not None), -rr[ME]["m"], sp, [f"{teams[o]['owner']}:{lbl(a)}->{teams[t]['owner']}" for (o, a), t in zip(combo, dest)] + ([f"DROP {lbl(dr[2])}"] if dr else []), rr))
    if len(res) >= 5: break
res.sort(key=lambda x: (x[0], x[1]))
for k, _, sp, c, rr in res[:10]:
    print("SFIX", k, c, "||", fmt(rr))
print("NSFIX", len(res))
T3 = (SAM, MAT, DES)
def ev3(moves):
    gets = {r: [] for r in T3}; gives = {r: [] for r in T3}
    for fr, to, a in moves:
        gets[to].append(a); gives[fr].append(a)
    res = {}
    for r in T3:
        mg = trade.effective([a["value"] for a in gets[r]]); mv = trade.effective([a["value"] for a in gives[r]])
        tg = trade.effective([a["value"] * fac[r].get(a["id"], 1) for a in gets[r]]); tv = trade.effective([a["value"] * fac[r].get(a["id"], 1) for a in gives[r]])
        out = {a["id"] for a in gives[r]}
        ps = [p for p in roster[r] if p["id"] not in out] + [a for a in gets[r] if a["id"] in P]
        res[r] = {"m": (mg - mv) / max(mg, mv, 1), "t": (tg - tv) / max(tg, tv, 1), "ppg0": ppg(roster[r]), "ppg1": ppg(ps), "maxpf": maxpf(r, ps)}
    return res
f3 = lambda rr: " | ".join(f"{teams[x]['owner']} team {rr[x]['t']*100:+.1f}% mkt {rr[x]['m']*100:+.1f}% ppg {rr[x]['ppg0']:.1f}->{rr[x]['ppg1']:.1f} maxpf {rr[x]['maxpf']:.0f}" for x in rr)
awil = fname("Antonio Williams")
print("AW", awil["name"], awil["pos"], awil["value"], teams[awil["roster_id"]]["owner"], "ros", awil["ros_ppg"])
desc = [(DES, SAM, des27), (DES, SAM, simpson), (SAM, DES, young), (SAM, DES, awil)]
print("DESCOUNTER", f3(ev3(desc)))
b3 = [(SAM, MAT, young), (MAT, DES, stroud), (DES, SAM, des27), (DES, SAM, simpson)]
b3w = b3 + [(SAM, DES, awil)]
for nm, mv in (("B3", b3), ("B3W", b3w)):
    print(nm, f3(ev3(mv)))
u3 = {m[2]["id"] for m in b3w}
def lu(r, extra_out=(), extra_in=()):
    return {x["id"] for x in best_lineup([p for p in roster[r] if p["id"] not in extra_out] + list(extra_in), slots, "ros_ppg")}
mlu = lu(MAT, (stroud["id"],), (young,)); dlu = lu(DES, (simpson["id"],), (stroud,))
pool3 = []
for r, l in ((SAM, set()), (MAT, mlu), (DES, dlu)):
    pool3 += [(r, pk) for pk in d["picks"] if pk["roster_id"] == r and pk["id"] not in u3 and pk["value"] >= 250]
    pool3 += [(r, p) for p in roster[r] if p["id"] not in u3 and p["id"] not in l and p["value"] >= 300]
pool3 = [x for x in pool3 if not (x[0] == MAT and x[1]["id"] in (f"pick:2028:1:{MAT}", f"pick:2029:1:{MAT}"))]
pool3.sort(key=lambda x: -x[1]["value"]); pool3 = pool3[:20]
print("POOL3", [(teams[o]["owner"], lbl(a), a["value"]) for o, a in pool3])
samlu0 = ppg([p for p in roster[SAM] if p["id"] not in (young["id"], awil["id"])] + [simpson])
out = []
for basenm, base3 in (("B3", b3), ("B3W", b3w)):
    for k in range(0, 4):
        for combo in itertools.combinations(pool3, k):
            for dest in itertools.product(T3, repeat=k):
                if any(o == t for (o, a), t in zip(combo, dest)): continue
                mv = base3 + [(o, t, a) for (o, a), t in zip(combo, dest)]
                rr = ev3(mv)
                if all(abs(rr[x]["m"]) <= 0.05 and abs(rr[x]["t"]) <= 0.05 for x in rr):
                    sp = max(max(abs(rr[x]["m"]), abs(rr[x]["t"])) for x in rr)
                    samup = rr[SAM]["ppg1"] - samlu0
                    out.append((k, sp, basenm, [f"{teams[o]['owner']}:{lbl(a)}->{teams[t]['owner']}" for (o, a), t in zip(combo, dest)], rr, samup))
out.sort(key=lambda x: (x[0], x[1]))
for k, sp, bn, c, rr, su in out[:14]:
    print("FIX3", k, f"{sp*100:.1f}", bn, c, "||", f3(rr), "| sam ppg vs no-add", f"{su:+.1f}")
print("NFIX3", len(out))
print("FFB_MAXPF", teams[FFB]["projection"]["max_pf"] if "FFB" in dir() else None)
out = []
for k in range(1, 5):
    for combo in itertools.combinations(pool3, k):
        for dest in itertools.product(T3, repeat=k):
            if any(o == t for (o, a), t in zip(combo, dest)): continue
            if any(t == SAM and a["id"] in P for (o, a), t in zip(combo, dest)): continue
            mv = b3w + [(o, t, a) for (o, a), t in zip(combo, dest)]
            rr = ev3(mv)
            if all(abs(rr[x]["m"]) <= 0.05 and abs(rr[x]["t"]) <= 0.05 for x in rr):
                sp = max(max(abs(rr[x]["m"]), abs(rr[x]["t"])) for x in rr)
                out.append((k, sp, [f"{teams[o]['owner']}:{lbl(a)}->{teams[t]['owner']}" for (o, a), t in zip(combo, dest)], rr))
    if len(out) >= 6: break
out.sort(key=lambda x: (x[0], x[1]))
for k, sp, c, rr in out[:12]:
    print("WFIX", k, f"{sp*100:.1f}", c, "||", f3(rr))
print("NWFIX", len(out))
kc = fname("Concepcion")
g0 = [(MAT, SAM, m28), (DES, SAM, simpson), (MAT, DES, stroud), (SAM, MAT, young)]
g0w = g0 + [(SAM, DES, awil)]
print("M28", lbl(m28), m28["value"])
for nm, mv in (("G0", g0), ("G0W", g0w)):
    print(nm, f3(ev3(mv)))
ug = {m[2]["id"] for m in g0w} | {kc["id"]}
poolg = []
for r, l in ((SAM, set()), (MAT, mlu), (DES, dlu)):
    poolg += [(r, pk) for pk in d["picks"] if pk["roster_id"] == r and pk["id"] not in ug and pk["value"] >= 250]
    poolg += [(r, p) for p in roster[r] if p["id"] not in ug and p["id"] not in l and p["value"] >= 300]
poolg.sort(key=lambda x: -x[1]["value"]); poolg = [x for x in poolg if x[1]["value"] < 5000 and x[1]["id"] != des27["id"]][:15]
print("POOLG", [(teams[o]["owner"], lbl(a), a["value"]) for o, a in poolg])
for bn, base in (("G0", g0), ("G0W", g0w)):
    out = []
    for k in range(0, 5):
        for combo in itertools.combinations(poolg, k):
            for dest in itertools.product(T3, repeat=k):
                if any(o == t for (o, a), t in zip(combo, dest)): continue
                if any(t == SAM and a["id"] in P for (o, a), t in zip(combo, dest)): continue
                rr = ev3(base + [(o, t, a) for (o, a), t in zip(combo, dest)])
                if all(abs(rr[x]["m"]) <= 0.05 and abs(rr[x]["t"]) <= 0.05 for x in rr):
                    sp = max(max(abs(rr[x]["m"]), abs(rr[x]["t"])) for x in rr)
                    out.append((k, sp, [f"{teams[o]['owner']}:{lbl(a)}->{teams[t]['owner']}" for (o, a), t in zip(combo, dest)], rr))
        if len(out) >= 6: break
    out.sort(key=lambda x: (x[0], x[1]))
    for k, sp, c, rr in out[:8]:
        print("GFIX", bn, k, f"{sp*100:.1f}", c, "||", f3(rr))
    print("NGFIX", bn, len(out))
lpick = lambda r, pref: next(pk for pk in d["picks"] if pk["roster_id"] == r and pk["id"].startswith(pref) and "via" not in pk["label"])
m2_04 = next(pk for pk in d["picks"] if pk["roster_id"] == MAT and lbl(pk).startswith("2027 2.04"))
d2_09 = next(pk for pk in d["picks"] if pk["roster_id"] == DES and lbl(pk).startswith("2027 2.09"))
hw = g0 + [(DES, MAT, pitts), (MAT, SAM, m2_04), (SAM, DES, awil), (DES, MAT, d2_09)]
print("HW", f3(ev3(hw)))
uh = {m[2]["id"] for m in hw} | {kc["id"], des27["id"]}
ph = []
for r, l in ((SAM, set()), (MAT, mlu), (DES, dlu)):
    ph += [(r, pk) for pk in d["picks"] if pk["roster_id"] == r and pk["id"] not in uh and pk["value"] >= 150 and not (r == SAM and ":1:" in pk["id"]) and not (r == MAT and pk["id"] in (f"pick:2029:1:{MAT}",))]
    ph += [(r, p) for p in roster[r] if p["id"] not in uh and p["id"] not in l and p["value"] >= 200]
ph.sort(key=lambda x: -x[1]["value"]); ph = ph[:22]
print("PH", [(teams[o]["owner"], lbl(a), a["value"]) for o, a in ph])
out = []
for k in range(1, 3):
    for combo in itertools.combinations(ph, k):
        for dest in itertools.product(T3, repeat=k):
            if any(o == t for (o, a), t in zip(combo, dest)): continue
            if any(t == SAM and a["id"] in P for (o, a), t in zip(combo, dest)): continue
            rr = ev3(hw + [(o, t, a) for (o, a), t in zip(combo, dest)])
            if all(abs(rr[x]["m"]) <= 0.05 and abs(rr[x]["t"]) <= 0.05 for x in rr):
                sp = max(max(abs(rr[x]["m"]), abs(rr[x]["t"])) for x in rr)
                out.append((k, sp, [f"{teams[o]['owner']}:{lbl(a)}->{teams[t]['owner']}" for (o, a), t in zip(combo, dest)], rr))
    if out: break
# also try dropping DES's 2.09 to Matty
for dr in (d2_09, pitts):
    rr = ev3([m for m in hw if m[2] is not dr]); print("HWDROP", lbl(dr), f3(rr))
out.sort(key=lambda x: (x[0], x[1]))
for k, sp, c, rr in out[:10]:
    print("HFIX", k, f"{sp*100:.1f}", c, "||", f3(rr))
print("NHFIX", len(out))
daniels = fname("Jayden Daniels")
my28_2 = [pk for pk in d["picks"] if pk["roster_id"] == ME and pk["id"].startswith("pick:2028:2:")]
print("MY28_2", [(lbl(p), p["value"]) for p in my28_2])
k28 = my28_2[0]
fourteen = [(MAT, ME, hurts), (SAM, ME, s27), (ME, DES, daniels), (ME, SAM, s28), (ME, SAM, k28),
            (SAM, DES, awil), (DES, SAM, simpson), (DES, MAT, pitts), (DES, MAT, mhj), (DES, SAM, des27),
            (SAM, MAT, young), (SAM, MAT, addison), (SAM, MAT, corum), (MAT, SAM, m27)]
r14 = ev4(fourteen)
print("F14", " | ".join(f"{teams[x]['owner']} team {r14[x]['t']*100:+.1f}% mkt {r14[x]['m']*100:+.1f}% ppg {r14[x]['ppg0']:.1f}->{r14[x]['ppg1']:.1f} maxpf {r14[x]['maxpf']:.0f}" for x in r14))
for r_ in TEAMS4:
    g = [a for fr, to, a in fourteen if to == r_]; v = [a for fr, to, a in fourteen if fr == r_]
    print("F14V", teams[r_]["owner"], "IN", [(lbl(a), a["value"]) for a in g], "OUT", [(lbl(a), a["value"]) for a in v])
print("DANIELS", daniels["value"], daniels["ros_ppg"], "HURTS", hurts["value"], hurts["ros_ppg"])
print("LOWMAX14", sorted(((teams[t]['owner'], r14[t]['maxpf'] if t in r14 else teams[t]['projection']['max_pf']) for t in teams), key=lambda x: x[1])[:3])
u14 = {m[2]["id"] for m in fourteen}
mylu14 = {x["id"] for x in best_lineup([p for p in roster[ME] if p["id"] != daniels["id"]] + [hurts], slots, "ros_ppg")}
pool14 = []
for r in TEAMS4:
    lu_ = {x["id"] for x in best_lineup(roster[r], slots, "ros_ppg")}
    pool14 += [(r, pk) for pk in d["picks"] if pk["roster_id"] == r and pk["id"] not in u14 and 300 <= pk["value"] < 4000 and not (r == SAM and ":1:" in pk["id"]) and not (r == DES and ":1:" in pk["id"])]
    pool14 += [(r, p) for p in roster[r] if p["id"] not in u14 and p["id"] not in lu_ and p["id"] not in mylu14 and 400 <= p["value"] < 4000 and p["id"] != kc["id"]]
pool14.sort(key=lambda x: -x[1]["value"]); pool14 = pool14[:16]
print("POOL14", [(teams[o]["owner"], lbl(a), a["value"]) for o, a in pool14])
out = []
for k in range(1, 4):
    for combo in itertools.combinations(pool14, k):
        for dest in itertools.product(TEAMS4, repeat=k):
            if any(o == t for (o, a), t in zip(combo, dest)): continue
            if any(t == SAM and a["id"] in P for (o, a), t in zip(combo, dest)): continue
            rr = ev4(fourteen + [(o, t, a) for (o, a), t in zip(combo, dest)])
            if all(abs(rr[x]["m"]) <= 0.05 and rr[x]["t"] >= -0.05 for x in rr):
                sp = max(abs(rr[x]["m"]) for x in rr)
                out.append((k, sp, [f"{teams[o]['owner']}:{lbl(a)}->{teams[t]['owner']}" for (o, a), t in zip(combo, dest)], rr))
    if len(out) >= 4: break
out.sort(key=lambda x: (x[0], x[1]))
for k, sp, c, rr in out[:10]:
    print("F14FIX", k, f"{sp*100:.1f}", c, "||", " | ".join(f"{teams[x]['owner']} team {rr[x]['t']*100:+.1f}% mkt {rr[x]['m']*100:+.1f}%" for x in rr))
print("NF14FIX", len(out))
lamb = fname("CeeDee Lamb")
T3L = (ME, SAM, MAT)
def evL(moves):
    global TEAMS4
    old = TEAMS4; TEAMS4 = T3L
    try: return ev4(moves)
    finally: TEAMS4 = old
lt = [(MAT, ME, lamb), (MAT, ME, m27), (ME, MAT, rice), (ME, SAM, s28), (SAM, MAT, young), (SAM, MAT, addison), (SAM, MAT, j27)]
rl = evL(lt)
print("LT", " | ".join(f"{teams[x]['owner']} team {rl[x]['t']*100:+.1f}% mkt {rl[x]['m']*100:+.1f}% ppg {rl[x]['ppg0']:.1f}->{rl[x]['ppg1']:.1f} maxpf {rl[x]['maxpf']:.0f}" for x in rl))
for r_ in T3L:
    g = [a for fr, to, a in lt if to == r_]; v = [a for fr, to, a in lt if fr == r_]
    print("LTV", teams[r_]["owner"], "IN", [(lbl(a), a["value"], round(a["value"] * fac[r_].get(a["id"], 1))) for a in g], "OUT", [(lbl(a), a["value"], round(a["value"] * fac[r_].get(a["id"], 1))) for a in v])
print("LAMB", lamb["value"], lamb["ros_ppg"], "RICE", rice["value"], rice["ros_ppg"])
print("PROJKEYS", list(teams[MAT]["projection"].keys()))
for t in sorted(teams, key=lambda t: -teams[t]["projection"].get("proj_wins", teams[t]["projection"].get("wins", 0)) if isinstance(teams[t]["projection"].get("proj_wins", 0), (int, float)) else 0):
    pr = teams[t]["projection"]
    print("STAND", teams[t]["owner"], {k: v for k, v in pr.items() if not isinstance(v, (list, dict))}, "ppg", round(ppg(roster[t]), 1))
print("MATPPG", round(ppg(roster[MAT]), 1), "->", round(rl[MAT]["ppg1"], 1))
nd = d.get("next_draft") or {}
for t in nd.get("teams", []):
    pk = next((p for p in d["picks"] if p["year"] == nd["year"] and p["round"] == 1 and p["original_roster_id"] == t["roster_id"]), None)
    print("ND", t["rank"], teams[t["roster_id"]]["owner"], "now", t["now_ppg"], "next", t["ppg"], "slot", t["first_slot"], "val", pk and pk["value"], "holder", pk and teams[pk["roster_id"]]["owner"], "rookies", t["rookies"])
print("NDCLASS", nd.get("class", [])[:6])
s28n = K[f"pick:2028:1:{SAM}"]
e = lambda xs: trade.effective(xs)
for nm, a, b in (("DEREK", [lamb["value"], m27["value"]], [rice["value"], s28n["value"]]), ("SAM", [s28n["value"]], [young["value"], addison["value"], j27["value"]]), ("MATTY", [rice["value"], young["value"], addison["value"], j27["value"]], [lamb["value"], m27["value"]])):
    x, y = e(a), e(b); print("LT2", nm, round(x), round(y), f"{(x-y)/max(x,y)*100:+.1f}%")
print("S28", lbl(s28n), s28n["value"])
# ---- L4: Lamb + Jcarney 1st four-way (2026-10-07 evening) ----
lamb = fname("CeeDee Lamb")
j27 = K["pick:2027:1:3"]
print("L4INFO", [(lbl(a), a["value"], teams[a["roster_id"]]["owner"]) for a in (lamb, rice, young, corum, addison, awil, simpson, stroud, j27, s28, des27)])
for r in TEAMS4:
    print("L4CTX", teams[r]["owner"], ctx[r]["label"], ctx[r]["mode"], "QB", ctx[r]["qb"], "rec", teams[r]["record"], "seed", teams[r]["record"].get("seed"))
L4 = [(MAT, ME, lamb), (ME, MAT, rice), (SAM, MAT, young), (SAM, ME, j27), (ME, SAM, s28), (DES, SAM, simpson),
      (SAM, ME, corum), (MAT, DES, stroud)]
OPTS = {"Addison>Matty": (SAM, MAT, addison), "Williams>DES": (SAM, DES, awil), "DES1st>Sam": (DES, SAM, des27)}
f4 = lambda rr: " | ".join(f"{teams[x]['owner']} mkt {rr[x]['m']*100:+.1f}% team {rr[x]['t']*100:+.1f}% ppg {rr[x]['ppg0']:.1f}->{rr[x]['ppg1']:.1f} maxpf {rr[x]['maxpf']:.0f}" for x in rr)
def slot_after(rr):
    mp = {t: (rr[t]["maxpf"] if t in rr else teams[t]["projection"]["max_pf"]) for t in teams}
    return sorted(((teams[t]["owner"], round(v)) for t, v in mp.items()), key=lambda x: x[1])[:3]
sam_core = [p for p in roster[SAM] if p["id"] not in (young["id"], corum["id"])]
print("L4SIMPSON", "Sam ppg w/o", round(ppg(sam_core), 2), "with Simpson", round(ppg(sam_core + [simpson]), 2))
variants = {}
for k in range(0, 4):
    for names in itertools.combinations(OPTS, k):
        variants["+".join(names) or "base"] = L4 + [OPTS[n] for n in names]
for nm, mv in variants.items():
    rr = ev4(mv); print("L4VAR", nm, "|", f4(rr), "| low maxpf", slot_after(rr))
keep = {kc["id"], caleb["id"], f"pick:2027:1:{SAM}", f"pick:2028:1:{MAT}", f"pick:2029:1:{MAT}", f"pick:2028:1:{SAM}"}
def lineup_ids(r, mv):
    out = {a["id"] for fr, to, a in mv if fr == r}; inn = [a for fr, to, a in mv if to == r and a["id"] in P]
    return {x["id"] for x in best_lineup([p for p in roster[r] if p["id"] not in out] + inn, slots, "ros_ppg")}
best = []
for nm, mv in []:
    used = {m[2]["id"] for m in mv} | keep
    pool = []
    for r in TEAMS4:
        l = lineup_ids(r, mv)
        pool += [(r, pk) for pk in d["picks"] if pk["roster_id"] == r and pk["id"] not in used and pk["value"] >= 200 and not (r == SAM and ":1:" in pk["id"])]
        pool += [(r, p) for p in roster[r] if p["id"] not in used and p["id"] not in l and p["value"] >= 250]
    pool.sort(key=lambda x: -x[1]["value"]); pool = pool[:18]
    samlu = lineup_ids(SAM, mv)
    found = []
    for k in range(0, 4):
        for combo in itertools.combinations(pool, k):
            for dest in itertools.product(TEAMS4, repeat=k):
                if any(o == t for (o, a), t in zip(combo, dest)): continue
                extra = [(o, t, a) for (o, a), t in zip(combo, dest)]
                if any(t == SAM and a["id"] in P for o, t, a in extra): continue
                rr = ev4(mv + extra)
                if all(abs(rr[x]["m"]) <= 0.05 and abs(rr[x]["t"]) <= 0.05 for x in rr):
                    sp = max(max(abs(rr[x]["m"]), abs(rr[x]["t"])) for x in rr)
                    found.append((k, sp, nm, [f"{teams[o]['owner']}:{lbl(a)}({a['value']})->{teams[t]['owner']}" for o, t, a in extra], rr))
        if found: break
    found.sort(key=lambda x: (x[0], x[1]))
    print("L4POOL", nm, [(teams[o]["owner"], lbl(a), a["value"]) for o, a in pool])
    for f in found[:4]:
        print("L4FIX", f[0], f"{f[1]*100:.1f}", f[2], f[3], "|", f4(f[4]), "| low", slot_after(f[4]))
    best += found[:4]
best.sort(key=lambda x: (x[0], x[1]))
for f in best[:6]:
    print("L4BEST", f[0], f"{f[1]*100:.1f}", f[2], f[3], "|", f4(f[4]), "| low", slot_after(f[4]))

# ---- L5: wider fill for the Lamb four-way ----
print("L5ME", [(lbl(a), a["value"], a.get("pos"), a.get("ros_ppg")) for a in sorted(roster[ME] + [pk for pk in d["picks"] if pk["roster_id"] == ME], key=lambda a: -a["value"])[:22]])
print("L5MAT", [(lbl(a), a["value"], a.get("pos"), a.get("ros_ppg")) for a in sorted(roster[MAT] + [pk for pk in d["picks"] if pk["roster_id"] == MAT], key=lambda a: -a["value"])[:16]])
V5 = {"W+D1": L4 + [OPTS["Williams>DES"], OPTS["DES1st>Sam"]],
      "A+W+D1": L4 + [OPTS["Addison>Matty"], OPTS["Williams>DES"], OPTS["DES1st>Sam"]]}
keep5 = {kc["id"], f"pick:2027:1:{SAM}", f"pick:2028:1:{SAM}"}
allbest = []
for nm, mv in []:
    used = {m[2]["id"] for m in mv} | keep5
    pool = [(ME, a) for a in roster[ME] + [pk for pk in d["picks"] if pk["roster_id"] == ME] if a["id"] not in used and a["value"] >= 500]
    pool.sort(key=lambda x: -x[1]["value"]); pool = pool[:14]
    for r in (SAM, MAT, DES):
        l = lineup_ids(r, mv)
        extra = [(r, pk) for pk in d["picks"] if pk["roster_id"] == r and pk["id"] not in used and pk["value"] >= 900 and not (r == SAM and ":1:" in pk["id"])]
        extra += [(r, p) for p in roster[r] if p["id"] not in used and p["id"] not in l and p["value"] >= 900]
        extra.sort(key=lambda x: -x[1]["value"]); pool += extra[:4]
    print("L5POOL", nm, [(teams[o]["owner"], lbl(a), a["value"]) for o, a in pool])
    found = []
    for k in range(1, 4):
        for combo in itertools.combinations(pool, k):
            for dest in itertools.product(TEAMS4, repeat=k):
                if any(o == t for (o, a), t in zip(combo, dest)): continue
                ex = [(o, t, a) for (o, a), t in zip(combo, dest)]
                if any(t == SAM and a["id"] in P for o, t, a in ex): continue
                rr = ev4(mv + ex)
                if all(abs(rr[x]["m"]) <= 0.05 and abs(rr[x]["t"]) <= 0.05 for x in rr):
                    sp = max(max(abs(rr[x]["m"]), abs(rr[x]["t"])) for x in rr)
                    found.append((k, -(rr[ME]["ppg1"]), sp, nm, [f"{teams[o]['owner']}:{lbl(a)}({a['value']})->{teams[t]['owner']}" for o, t, a in ex], rr))
        if len(found) >= 10: break
    found.sort(key=lambda x: (x[0], x[1], x[2]))
    for f in found[:10]:
        print("L5FIX", f[0], f[3], f[4], "|", f4(f[5]), "| low", slot_after(f[5]))
    allbest += found

# ---- L6: math for the even Lamb four-way ----
okon = fname("Chig Okonkwo")
d29_2b = next(pk for pk in d["picks"] if pk["roster_id"] == ME and pk["id"].startswith("pick:2029:2:"))
FINAL = L4 + [OPTS["Williams>DES"], OPTS["DES1st>Sam"], (ME, MAT, daniels), (ME, DES, d29_2b), (DES, ME, okon)]
rr = ev4(FINAL)
print("L6RES", f4(rr), "| low", slot_after(rr))
for r_ in TEAMS4:
    g = [a for fr, to, a in FINAL if to == r_]; v = [a for fr, to, a in FINAL if fr == r_]
    fl = lambda xs: "; ".join(f"{lbl(a)} {a['value']}/{round(a['value'] * fac[r_].get(a['id'], 1))}" for a in xs)
    eg, ev_ = trade.effective([a["value"] for a in g]), trade.effective([a["value"] for a in v])
    tg = trade.effective([a["value"] * fac[r_].get(a["id"], 1) for a in g]); tv = trade.effective([a["value"] * fac[r_].get(a["id"], 1) for a in v])
    print("L6MATH", teams[r_]["owner"], "| IN:", fl(g), "| OUT:", fl(v), f"| raw {sum(a['value'] for a in g)} vs {sum(a['value'] for a in v)} | adj {eg:.0f} vs {ev_:.0f} = {(eg-ev_)/max(eg,ev_)*100:+.1f}% | team {tg:.0f} vs {tv:.0f} = {(tg-tv)/max(tg,tv)*100:+.1f}%")

# ---- L7: Hurts to Derek; Corum (and maybe Okonkwo) to Matty ----
def mathlines(tag, mv):
    for r_ in TEAMS4:
        g = [a for fr, to, a in mv if to == r_]; v = [a for fr, to, a in mv if fr == r_]
        fl = lambda xs: "; ".join(f"{lbl(a)} {a['value']}/{round(a['value'] * fac[r_].get(a['id'], 1))}" for a in xs)
        eg, ev_ = trade.effective([a["value"] for a in g]), trade.effective([a["value"] for a in v])
        tg = trade.effective([a["value"] * fac[r_].get(a["id"], 1) for a in g]); tv = trade.effective([a["value"] * fac[r_].get(a["id"], 1) for a in v])
        print(tag, teams[r_]["owner"], "| IN:", fl(g), "| OUT:", fl(v), f"| raw {sum(a['value'] for a in g)} vs {sum(a['value'] for a in v)} | adj {eg:.0f} vs {ev_:.0f} = {(eg-ev_)/max(eg,ev_)*100:+.1f}% | team {tg:.0f} vs {tv:.0f} = {(tg-tv)/max(tg,tv)*100:+.1f}%")
core7 = [(MAT, ME, lamb), (MAT, ME, hurts), (ME, MAT, rice), (SAM, MAT, young), (SAM, ME, j27), (ME, SAM, s28),
         (DES, SAM, simpson), (SAM, MAT, corum), (MAT, DES, stroud), (SAM, DES, awil), (DES, SAM, des27)]
V7 = {"okonMat+dan": core7 + [(DES, MAT, okon), (ME, MAT, daniels)],
      "okonMat": core7 + [(DES, MAT, okon)],
      "noOkon+dan": core7 + [(ME, MAT, daniels)],
      "noOkon": core7}
for nm, mv in V7.items():
    rr = ev4(mv); print("L7VAR", nm, "|", f4(rr), "| low", slot_after(rr))
keep7 = {kc["id"], f"pick:2027:1:{SAM}", f"pick:2028:1:{SAM}", f"pick:2028:1:{MAT}", f"pick:2029:1:{MAT}"}
allf = []
for nm, mv in V7.items():
    used = {m[2]["id"] for m in mv} | keep7
    pool = [(ME, a) for a in roster[ME] + [pk for pk in d["picks"] if pk["roster_id"] == ME]
            if a["id"] not in used and 500 <= a["value"] < 7000]
    pool.sort(key=lambda x: -x[1]["value"]); pool = pool[:14]
    for r in (SAM, MAT, DES):
        l = lineup_ids(r, mv)
        ex = [(r, pk) for pk in d["picks"] if pk["roster_id"] == r and pk["id"] not in used and pk["value"] >= 900 and not (r == SAM and ":1:" in pk["id"])]
        ex += [(r, p) for p in roster[r] if p["id"] not in used and p["id"] not in l and p["value"] >= 900]
        ex.sort(key=lambda x: -x[1]["value"]); pool += ex[:4]
    found = []
    for k in range(0, 4):
        for combo in itertools.combinations(pool, k):
            for dest in itertools.product(TEAMS4, repeat=k):
                if any(o == t for (o, a), t in zip(combo, dest)): continue
                ex = [(o, t, a) for (o, a), t in zip(combo, dest)]
                if any(t == SAM and a["id"] in P for o, t, a in ex): continue
                rr = ev4(mv + ex)
                if all(abs(rr[x]["m"]) <= 0.05 and abs(rr[x]["t"]) <= 0.05 for x in rr):
                    found.append((k, -rr[ME]["ppg1"], nm, ex, rr))
        if len(found) >= 8: break
    found.sort(key=lambda x: (x[0], x[1]))
    for f in found[:6]:
        print("L7FIX", f[0], f[2], [f"{teams[o]['owner']}:{lbl(a)}({a['value']})->{teams[t]['owner']}" for o, t, a in f[3]], "|", f4(f[4]), "| low", slot_after(f[4]))
    allf += found[:6]
allf.sort(key=lambda x: (x[0], x[1]))
if allf:
    mathlines("L7MATH", V7[allf[0][2]] + allf[0][3])

# ---- L8: Derek gets Lamb + Hurts + Matty's 2027 1st; Matty keeps Stroud, gets Young + Jcarney 1.10; DES gets Daniels ----
def mathlines(tag, mv):
    for r_ in TEAMS4:
        g = [a for fr, to, a in mv if to == r_]; v = [a for fr, to, a in mv if fr == r_]
        fl = lambda xs: "; ".join(f"{lbl(a)} {a['value']}/{round(a['value'] * fac[r_].get(a['id'], 1))}" for a in xs)
        eg, ev_ = trade.effective([a["value"] for a in g]), trade.effective([a["value"] for a in v])
        tg = trade.effective([a["value"] * fac[r_].get(a["id"], 1) for a in g]); tv = trade.effective([a["value"] * fac[r_].get(a["id"], 1) for a in v])
        print(tag, teams[r_]["owner"], "| IN:", fl(g), "| OUT:", fl(v), f"| raw {sum(a['value'] for a in g)} vs {sum(a['value'] for a in v)} | adj {eg:.0f} vs {ev_:.0f} = {(eg-ev_)/max(eg,ev_)*100:+.1f}% | team {tg:.0f} vs {tv:.0f} = {(tg-tv)/max(tg,tv)*100:+.1f}%")
core8 = [(MAT, ME, lamb), (MAT, ME, hurts), (MAT, ME, m27), (ME, MAT, rice), (SAM, MAT, young), (SAM, MAT, j27),
         (ME, SAM, s28), (DES, SAM, simpson), (ME, DES, daniels)]
O8 = {"Corum>Matty": (SAM, MAT, corum), "Williams>DES": (SAM, DES, awil), "DES1st>Sam": (DES, SAM, des27)}
V8 = {}
for k in range(0, 4):
    for names in itertools.combinations(O8, k):
        V8["+".join(names) or "core"] = core8 + [O8[n] for n in names]
for nm, mv in V8.items():
    rr = ev4(mv); print("L8VAR", nm, "|", f4(rr), "| low", slot_after(rr))
keep8 = {kc["id"], caleb["id"], f"pick:2027:1:{SAM}", f"pick:2028:1:{SAM}", f"pick:2028:1:{MAT}", f"pick:2029:1:{MAT}", stroud["id"]}
allf = []
for nm, mv in []:
    used = {m[2]["id"] for m in mv} | keep8
    pool = [(ME, a) for a in roster[ME] + [pk for pk in d["picks"] if pk["roster_id"] == ME]
            if a["id"] not in used and 500 <= a["value"] < 7000]
    pool.sort(key=lambda x: -x[1]["value"]); pool = pool[:13]
    for r in (SAM, MAT, DES):
        l = lineup_ids(r, mv)
        ex = [(r, pk) for pk in d["picks"] if pk["roster_id"] == r and pk["id"] not in used and pk["value"] >= 900 and not (r == SAM and ":1:" in pk["id"])]
        ex += [(r, p) for p in roster[r] if p["id"] not in used and p["id"] not in l and p["value"] >= 900]
        ex.sort(key=lambda x: -x[1]["value"]); pool += ex[:4]
    found = []
    for k in range(0, 4):
        for combo in itertools.combinations(pool, k):
            for dest in itertools.product(TEAMS4, repeat=k):
                if any(o == t for (o, a), t in zip(combo, dest)): continue
                ex = [(o, t, a) for (o, a), t in zip(combo, dest)]
                if any(t == SAM and a["id"] in P for o, t, a in ex): continue
                rr = ev4(mv + ex)
                if all(abs(rr[x]["m"]) <= 0.05 and abs(rr[x]["t"]) <= 0.05 for x in rr):
                    found.append((k, -rr[ME]["ppg1"], nm, ex, rr))
        if len(found) >= 8: break
    found.sort(key=lambda x: (x[0], x[1]))
    for f in found[:5]:
        print("L8FIX", f[0], f[2], [f"{teams[o]['owner']}:{lbl(a)}({a['value']})->{teams[t]['owner']}" for o, t, a in f[3]], "|", f4(f[4]), "| low", slot_after(f[4]))
    allf += found[:5]
allf.sort(key=lambda x: (x[0], x[1]))
for i, f in enumerate([]):
    mathlines(f"L8MATH{i}", V8[f[2]] + f[3])

# ---- L9: simpler Lamb deal without Derek's 2029 1st ----
nix = fname("Bo Nix"); goff = fname("Jared Goff")
S9 = [(MAT, ME, lamb), (MAT, ME, hurts), (MAT, ME, m27), (ME, MAT, rice), (ME, MAT, goff), (SAM, MAT, young), (SAM, MAT, j27),
      (SAM, MAT, corum), (ME, SAM, s28), (DES, SAM, simpson), (ME, DES, daniels), (DES, MAT, nix)]
m2 = K[f"pick:2027:2:{MAT}"]
for nm, mv in (("NO29", S9), ("M2", S9 + [(MAT, SAM, m2)])):
    rr = ev4(mv); print("L9VAR", nm, lbl(m2), m2["value"], "|", f4(rr), "| low", slot_after(rr))
    mathlines("L9MATH_" + nm, mv)
# small fixes on top of the M2 version, Derek giving as little as possible
base = S9 + [(MAT, SAM, m2)]
used = {m[2]["id"] for m in base} | {kc["id"], caleb["id"], f"pick:2027:1:{SAM}", f"pick:2029:1:{ME}", f"pick:2028:1:{MAT}", f"pick:2029:1:{MAT}", stroud["id"]}
pool = []
for r in TEAMS4:
    l = lineup_ids(r, base)
    ex = [(r, pk) for pk in d["picks"] if pk["roster_id"] == r and pk["id"] not in used and pk["value"] >= 300 and not (r == SAM and ":1:" in pk["id"])]
    ex += [(r, p) for p in roster[r] if p["id"] not in used and p["id"] not in l and p["value"] >= 300]
    ex.sort(key=lambda x: -x[1]["value"]); pool += ex[:7]
found = []
for k in []:
    for combo in itertools.combinations(pool, k):
        for dest in itertools.product(TEAMS4, repeat=k):
            if any(o == t for (o, a), t in zip(combo, dest)): continue
            ex = [(o, t, a) for (o, a), t in zip(combo, dest)]
            if any(t == SAM and a["id"] in P for o, t, a in ex): continue
            rr = ev4(base + ex)
            if all(abs(rr[x]["m"]) <= 0.05 and abs(rr[x]["t"]) <= 0.05 for x in rr):
                found.append((k, -rr[ME]["m"], ex, rr))
    if found: break
found.sort(key=lambda x: (x[0], x[1]))
for f in found[:8]:
    print("L9FIX", f[0], [f"{teams[o]['owner']}:{lbl(a)}({a['value']})->{teams[t]['owner']}" for o, t, a in f[2]], "|", f4(f[3]), "| low", slot_after(f[3]))

# ---- L10: Derek keeps Willis; Matty gets no QB besides Young ----
B10 = [(MAT, ME, lamb), (MAT, ME, hurts), (MAT, ME, m27), (ME, MAT, rice), (SAM, MAT, young), (SAM, MAT, j27),
       (SAM, MAT, corum), (ME, SAM, s28), (DES, SAM, simpson), (ME, DES, daniels), (MAT, SAM, m2)]
rr = ev4(B10); print("L10BASE", f4(rr))
used = {m[2]["id"] for m in B10} | {kc["id"], caleb["id"], wil["id"], f"pick:2027:1:{SAM}", f"pick:2028:1:{SAM}",
                                    f"pick:2028:1:{MAT}", f"pick:2029:1:{MAT}", stroud["id"]}
pool = []
for r in TEAMS4:
    l = lineup_ids(r, B10) if r != ME else set()
    ex = [(r, pk) for pk in d["picks"] if pk["roster_id"] == r and pk["id"] not in used and pk["value"] >= 400 and not (r == SAM and ":1:" in pk["id"])]
    ex += [(r, p) for p in roster[r] if p["id"] not in used and p["id"] not in l and p["value"] >= 400 and p["value"] < 7000]
    ex.sort(key=lambda x: -x[1]["value"]); pool += ex[:12 if r in (ME, DES) else 5]
print("L10POOL", [(teams[o]["owner"], lbl(a), a["value"]) for o, a in pool])
found = []
for k in []:
    for combo in itertools.combinations(pool, k):
        for dest in itertools.product(TEAMS4, repeat=k):
            if any(o == t for (o, a), t in zip(combo, dest)): continue
            ex = [(o, t, a) for (o, a), t in zip(combo, dest)]
            if any(t == SAM and a["id"] in P for o, t, a in ex): continue
            if any(t == MAT and a.get("pos") == "QB" for o, t, a in ex): continue
            rr = ev4(B10 + ex)
            if all(abs(rr[x]["m"]) <= 0.05 and abs(rr[x]["t"]) <= 0.05 for x in rr):
                sp = max(max(abs(rr[x]["m"]), abs(rr[x]["t"])) for x in rr)
                found.append((k, -rr[ME]["ppg1"], sp, ex, rr))
    if len(found) >= 10: break
found.sort(key=lambda x: (x[0], x[1], x[2]))
for f in found[:10]:
    print("L10FIX", f[0], [f"{teams[o]['owner']}:{lbl(a)}({a['value']})->{teams[t]['owner']}" for o, t, a in f[3]], "|", f4(f[4]), "| low", slot_after(f[4]))
if False:
    mathlines("L10MATH", B10 + found[0][3])

# ---- L11: simple version. Derek: Lamb + Matty 1.04 for Rice + Sam's 2028 1st ----
B11 = [(MAT, ME, lamb), (MAT, ME, m27), (ME, MAT, rice), (SAM, MAT, young), (SAM, MAT, j27),
       (ME, SAM, s28), (DES, SAM, simpson), (MAT, DES, stroud)]
DUMP = {corum["id"], addison["id"]}
def sam_dump(mv):  # Sam's side with Corum/Addison counted at half (he wants them gone)
    g = [a["value"] for fr, to, a in mv if to == SAM]
    v = [a["value"] * (0.5 if a["id"] in DUMP else 1) for fr, to, a in mv if fr == SAM]
    eg, ev_ = trade.effective(g), trade.effective(v); return (eg - ev_) / max(eg, ev_, 1)
rr = ev4(B11); print("L11BASE", f4(rr), "| samdump", f"{sam_dump(B11)*100:+.1f}%")
dumpopts = [[]]
for dst in (MAT, DES, ME):
    dumpopts.append([(SAM, dst, corum)]); dumpopts.append([(SAM, dst, addison)])
    for dst2 in (MAT, DES, ME):
        dumpopts.append([(SAM, dst, corum), (SAM, dst2, addison)])
prot = {kc["id"], caleb["id"], wil["id"], goff["id"], f"pick:2029:1:{ME}", f"pick:2027:1:{SAM}", f"pick:2028:1:{SAM}",
        f"pick:2028:1:{MAT}", f"pick:2029:1:{MAT}", hurts["id"], daniels["id"]}
found = []
for dop in dumpopts:
    base = B11 + dop
    used = {m[2]["id"] for m in base} | prot
    pool = []
    for r in TEAMS4:
        l = lineup_ids(r, base) if r not in (ME,) else set()
        ex = [(r, pk) for pk in d["picks"] if pk["roster_id"] == r and pk["id"] not in used and pk["value"] >= 400 and not (r == SAM and ":1:" in pk["id"])]
        ex += [(r, p) for p in roster[r] if p["id"] not in used and p["id"] not in l and p["value"] >= 400 and p["value"] < 6000 and p["id"] not in DUMP]
        ex.sort(key=lambda x: -x[1]["value"]); pool += ex[:10 if r in (ME, DES) else 5]
    for k in range(0, 3):
        for combo in itertools.combinations(pool, k):
            for dest in itertools.product(TEAMS4, repeat=k):
                if any(o == t for (o, a), t in zip(combo, dest)): continue
                ex = [(o, t, a) for (o, a), t in zip(combo, dest)]
                if any(t == SAM and a["id"] in P for o, t, a in ex): continue
                mv = base + ex
                if any(t == MAT and a.get("pos") == "QB" and a is not young for o, t, a in mv): continue
                rr = ev4(mv)
                sd = sam_dump(mv)
                ok = all(abs(rr[x]["m"]) <= 0.05 and abs(rr[x]["t"]) <= 0.05 for x in rr if x != SAM) and (abs(rr[SAM]["m"]) <= 0.05 or abs(sd) <= 0.05)
                if ok:
                    mine_out = sum(a["value"] for o, t, a in mv if o == ME)
                    found.append((len(mv), mine_out, ex, dop, rr, sd))
found.sort(key=lambda x: (x[0], x[1]))
for f in found[:12]:
    print("L11FIX", f[0], "derek_out", f[1], [f"{teams[o]['owner']}:{lbl(a)}({a['value']})->{teams[t]['owner']}" for o, t, a in f[3] + f[2]], "|", f4(f[4]), f"| samdump {f[5]*100:+.1f}% | low", slot_after(f[4]))
found.sort(key=lambda x: (x[1], x[0]))
for f in found[:8]:
    print("L11CHEAP", f[0], "derek_out", f[1], [f"{teams[o]['owner']}:{lbl(a)}({a['value']})->{teams[t]['owner']}" for o, t, a in f[3] + f[2]], "|", f4(f[4]), f"| samdump {f[5]*100:+.1f}% | low", slot_after(f[4]))
if found:
    mathlines("L11MATH", B11 + found[0][3] + found[0][2])

import sys; sys.exit(0)
results = []
mpool = [(o, a) for o, a in pool if o == ME][:8]
for qb in [q for q in myqbs if q["name"] in ("Jayden Daniels", "Jared Goff")]:
    for k in range(0, 7):
        for combo in itertools.combinations(pool, k):
            used = {a["id"] for _, a in combo}
            rest = [x for x in mpool if x[1]["id"] not in used]
            for j in range(0, 3):
                for mc in itertools.combinations(rest, j):
                    moves = base_core["core"] + [(ME, MAT, qb)] + [(o, SAM, a) for o, a in combo] + [(ME, MAT, a) for _, a in mc]
                    r = evaluate(moves)
                    worst = max(abs(r[x]["t"]) for x in r)
                    score = worst + 0.005 * (k + j)
                    results.append((score, qb["name"], [f"{teams[o]['owner']}:{lbl(a)}" for o, a in combo] + [f"toMATTY:{lbl(a)}" for _, a in mc], r, moves))
results.sort(key=lambda x: x[0])
seen = 0
for score, qbn, combo, r, moves in results[:12]:
    print("CAND", round(score, 3), "QB->matty", qbn, "to sam", combo, "|",
          " ".join(f"{teams[x]['owner']} team {r[x]['t']*100:+.0f}% mkt {r[x]['m']*100:+.0f}% ppg {r[x]['ppg0']:.1f}->{r[x]['ppg1']:.1f}" for x in r),
          "| sam maxpf", r[SAM]["maxpf"], "ffbros", teams[FFB]["projection"]["max_pf"])
best = results[0]
print("BEST moves:")
for fr, to, a in best[4]:
    print("  MOVE", teams[fr]["owner"], "->", teams[to]["owner"], lbl(a), a["value"], "to receiver", round(a["value"] * fac[to].get(a["id"], 1)))
r = best[3]
for x in r:
    print("  SIDE", teams[x]["owner"], {k: (round(v, 3) if isinstance(v, float) else v) for k, v in r[x].items()})
# Best per QB choice too
for qb in [q for q in myqbs if q["name"] in ("Jayden Daniels", "Jared Goff")]:
    b = next(x for x in results if x[1] == qb["name"])
    print("PERQB", qb["name"], round(b[0], 3), b[2], " ".join(f"{teams[x]['owner']} {b[3][x]['t']*100:+.0f}%" for x in b[3]), "sam maxpf", b[3][SAM]["maxpf"])
