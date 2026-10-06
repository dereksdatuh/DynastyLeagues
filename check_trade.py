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
             (ME, SAM, s28), (MAT, ME, hurts)],
}
# Pool to balance Sam with things that won't start for him: picks, and non-starters.
sam_line_now = ppg([p for p in roster[SAM] if p["id"] not in (corum["id"], young["id"], addison["id"])])
pool = []
for owner in (ME, MAT):
    for pk in d["picks"]:
        if pk["roster_id"] == owner and pk["id"] not in (s28["id"], s27["id"], j27["id"]) and pk["value"] >= 300:
            pool.append((owner, pk))
    for p in roster[owner]:
        if p["id"] in (hurts["id"],) or p["pos"] == "QB" or p["value"] < 400:
            continue
        add = ppg([q for q in roster[SAM] if q["id"] not in (corum["id"], young["id"], addison["id"])] + [p]) - sam_line_now
        if add <= 0.5:
            pool.append((owner, p))
pool.sort(key=lambda x: -x[1]["value"])
pool = pool[:12]
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

results = []
for qb in myqbs:
    for k in range(0, 6):
        for combo in itertools.combinations(pool, k):
            moves = base_core["core"] + [(ME, MAT, qb)] + [(o, SAM, a) for o, a in combo]
            r = evaluate(moves)
            worst = max(abs(r[x]["t"]) for x in r)
            score = worst + 0.005 * k
            results.append((score, qb["name"], [f"{teams[o]['owner']}:{lbl(a)}" for o, a in combo], r, moves))
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
for qb in myqbs:
    b = next(x for x in results if x[1] == qb["name"])
    print("PERQB", qb["name"], round(b[0], 3), b[2], " ".join(f"{teams[x]['owner']} {b[3][x]['t']*100:+.0f}%" for x in b[3]), "sam maxpf", b[3][SAM]["maxpf"])
