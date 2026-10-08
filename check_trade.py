"""Scratch: Gibbs trade with DES (Ultimate Dynasty). Not for merge."""
import json, pathlib, itertools, re
from engine.build import best_lineup
from engine import trade

d = json.loads(pathlib.Path("site/data/league-4.json").read_text())
slots = d["league"]["format"]["starting_slots"]
teams = {t["roster_id"]: t for t in d["teams"]}
own = lambda k: next(t for t in d["teams"] if k in (t.get("owner") or "").lower())["roster_id"]
ME, DES, SAM = own("ds107"), own("desmith99"), own("samsin123")
P = {p["id"]: p for p in d["players"]}
K = {p["id"]: p for p in d["picks"]}
fac = {int(k): v for k, v in d["team_values"]["factors"].items()}
ctx = {int(k): v for k, v in d["team_values"]["context"]["teams"].items()}
weeks = len(d["schedule"]["weeks"])
ppg = lambda ps: sum(x["ros_ppg"] for x in best_lineup(ps, slots, "ros_ppg"))
roster = {r: [P[i] for i in t["players"] if i in P] for r, t in teams.items()}
lbl = lambda a: a.get("name") or a.get("label")
on = lambda r: teams[r]["owner"]
def fname(n):
    key = re.sub(r"[^a-z]", "", n.lower())
    hits = sorted([p for p in d["players"] if key in re.sub(r"[^a-z]", "", p["name"].lower())], key=lambda p: -p["value"])
    return hits[0]

gibbs, arsb, daniels, hurts, nix = (fname(n) for n in ("Jahmyr Gibbs", "Amon-Ra St. Brown", "Jayden Daniels", "Jalen Hurts", "Bo Nix"))
for p in (gibbs, arsb, daniels, hurts, nix):
    r = p.get("roster_id")
    print("P", p["name"], p["pos"], "age", p["age"], "val", p["value"], "ros", p["ros_ppg"], "holder", on(r) if r in teams else "FA",
          "to DES", round(p["value"] * fac[DES].get(p["id"], 1)), "to me", round(p["value"] * fac[ME].get(p["id"], 1)))
H, N = hurts.get("roster_id"), nix.get("roster_id")
TEAMS = sorted({ME, DES} | {x for x in (H, N) if x in teams})
for r in TEAMS:
    qbs = sorted([p for p in roster[r] if p["pos"] == "QB"], key=lambda p: -p["ros_ppg"])
    print("CTX", on(r), ctx[r]["label"], "ppg", round(ppg(roster[r]), 1), "rec", teams[r]["record"].get("wins"), "-", teams[r]["record"].get("losses"),
          "QBs", [(q["name"], q["ros_ppg"], q["value"]) for q in qbs])
    top = sorted(roster[r], key=lambda p: -p["value"])[:22]
    print("  ROSTER", "; ".join(f"{p['name']} {p['pos']} {p['age']} v{p['value']} r{p['ros_ppg']}" for p in top))
    print("  PICKS", "; ".join(f"{k['label']} v{k['value']}" for k in d["picks"] if k["roster_id"] == r))

def ev(moves, dump=()):
    gets = {r: [] for r in TEAMS}; gives = {r: [] for r in TEAMS}
    for fr, to, a in moves:
        gets[to].append(a); gives[fr].append(a)
    res = {}
    for r in TEAMS:
        # A QB nobody wants counts at half for the team shedding it.
        gv = lambda a: a["value"] * (0.5 if a["id"] in dump and a.get("roster_id") == r else 1)
        mg = trade.effective([a["value"] for a in gets[r]]); mv = trade.effective([gv(a) for a in gives[r]])
        tg = trade.effective([a["value"] * fac[r].get(a["id"], 1) for a in gets[r]]); tv = trade.effective([gv(a) * fac[r].get(a["id"], 1) for a in gives[r]])
        out = {a["id"] for a in gives[r]}
        ps = [p for p in roster[r] if p["id"] not in out] + [a for a in gets[r] if a["id"] in P]
        res[r] = {"m": (mg - mv) / max(mg, mv, 1), "t": (tg - tv) / max(tg, tv, 1), "d": ppg(ps) - ppg(roster[r])}
    return res
fmt = lambda res: " | ".join(f"{on(r)} mkt {res[r]['m']*100:+.1f}% team {res[r]['t']*100:+.1f}% ppg {res[r]['d']:+.1f}" for r in res)
desc = lambda mv: "; ".join(f"{on(f)}->{on(t)} {lbl(a)}" for f, t, a in mv)

core = [(DES, ME, gibbs), (ME, DES, arsb), (ME, DES, daniels)]
print("CORE", fmt(ev(core)))
KEEP = {fname(n)["id"] for n in ("Caleb Williams", "Jeremiyah Love", "Ja'Marr Chase", "Tucker Kraft")} | {f"pick:2028:1:{SAM}"}
dumps = {hurts["id"], nix["id"]}
# Hurts to Derek (he'll take him); Nix to any other team in the deal.
qbmoves = []
for hd in ([ME] if H != ME else [None]):
    for nd in [t for t in TEAMS if t != N] + [None]:
        mv = []
        if H in teams and H != ME: mv.append((H, ME, hurts))
        if N in teams and nd is not None: mv.append((N, nd, nix))
        qbmoves.append(mv)
# Filler moves between any two teams in the deal.
pool = []
for fr in TEAMS:
    assets = [a for a in roster[fr] if a["value"] >= 300 and a["id"] not in KEEP | dumps | {gibbs["id"], arsb["id"], daniels["id"]}]
    assets += [k for k in d["picks"] if k["roster_id"] == fr and k["value"] >= 300 and k["id"] not in KEEP]
    for a in sorted(assets, key=lambda a: -a["value"])[:14]:
        for to in TEAMS:
            if to != fr: pool.append((fr, to, a))
print("POOL", len(pool), "moves")
found = []
for qm in qbmoves:
    base = core + qm
    for k in range(0, 4):
        for add in itertools.combinations(pool, k):
            if len({a["id"] for _, _, a in add}) < k: continue
            mv = base + list(add)
            res = ev(mv, dumps)
            if any(abs(res[r]["m"]) > 0.05 or res[r]["t"] < -0.05 for r in TEAMS): continue
            if res[ME]["d"] < 0 or res[DES]["d"] < 0: continue
            found.append((len(mv), -res[ME]["d"] - res[DES]["d"], mv, res))
found.sort(key=lambda x: (x[0], x[1]))
print("FOUND", len(found))
seen = set()
for n, _, mv, res in found:
    key = frozenset((f, t, a["id"]) for f, t, a in mv if t == ME or f == ME)
    if key in seen: continue
    seen.add(key)
    print("DEAL", desc(mv)); print("   ", fmt(res)); print("    raw", fmt(ev(mv)))
    if len(seen) >= 15: break
# Near misses if nothing fits: best by worst side.
if not found:
    near = []
    for qm in qbmoves:
        for k in range(0, 3):
            for add in itertools.combinations(pool, k):
                mv = core + qm + list(add); res = ev(mv, dumps)
                worst = max(max(abs(res[r]["m"]), -res[r]["t"]) for r in TEAMS) + 0.01 * max(0, -res[ME]["d"]) + 0.01 * max(0, -res[DES]["d"])
                near.append((worst, mv, res))
    near.sort(key=lambda x: x[0])
    for w, mv, res in near[:10]:
        print("NEAR", round(w, 3), desc(mv)); print("   ", fmt(res))
