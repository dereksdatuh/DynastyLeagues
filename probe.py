import json, httpx
c = httpx.Client(timeout=30)
g = lambda u: c.get("https://api.sleeper.app/v1/" + u).json()
uid = g("user/ds107")["user_id"]
out = {"leagues": []}
for lg in g(f"user/{uid}/leagues/nfl/2026"):
    out["leagues"].append({k: lg.get(k) for k in ("league_id", "name", "status", "total_rosters", "draft_id")})
    if "mirage" in (lg.get("name") or "").lower():
        lid = lg["league_id"]
        m = {"league": lg, "users": g(f"league/{lid}/users"), "rosters": g(f"league/{lid}/rosters"), "drafts": g(f"league/{lid}/drafts")}
        for d in m["drafts"]:
            d["detail"] = g(f"draft/{d['draft_id']}")
            d["picks"] = g(f"draft/{d['draft_id']}/picks")
            d["traded_picks"] = g(f"draft/{d['draft_id']}/traded_picks")
        out["mirage"] = m
json.dump(out, open("scratch/probe.json", "w"), indent=1)
