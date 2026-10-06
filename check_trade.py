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
xp = [(DES, pk) for pk in d["picks"] if pk["roster_id"] == DES and pk["id"] not in used and pk["value"] >= 300]
xp += [(DES, p) for p in roster[DES] if p["id"] not in used and p["id"] not in deslu and p["value"] >= 400]
xp += [(ME, a) for a in dp[:6]]
xp.sort(key=lambda x: -x[1]["value"]); xp = xp[:14]
print("XP", [(teams[o]["owner"], lbl(a), a["value"]) for o, a in xp])
res = []
for k in range(1, 5):
    for combo in itertools.combinations(xp, k):
        for dest in itertools.product((SAM, MAT), repeat=k):
            if any(t == SAM and a["id"] in P and ppg(sam_after + [simpson, a]) - sb > 0.5 for (o, a), t in zip(combo, dest)):
                continue
            rr = ev4(four + [(o, t, a) for (o, a), t in zip(combo, dest)])
            if all(rr[x]["t"] >= -0.05 for x in rr):
                res.append((k, sum(1 for o, _ in combo if o == ME), [f"{teams[o]['owner']}:{lbl(a)}->{teams[t]['owner']}" for (o, a), t in zip(combo, dest)], rr))
    if res: break
res.sort(key=lambda x: (x[0], x[1]))
for k, nme, c, rr in res[:8]:
    print("XFIX", k, c, "|", " ".join(f"{teams[x]['owner']} team {rr[x]['t']*100:+.1f}% mkt {rr[x]['m']*100:+.1f}% ppg {rr[x]['ppg1']:.1f} maxpf {rr[x]['maxpf']}" for x in rr))
print("NXFIX", len(res))
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
