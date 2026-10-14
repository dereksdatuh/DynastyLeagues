import json, os
from engine.fetch import get_json
V1="https://api.sleeper.app/v1"
u=get_json("u_ds107",f"{V1}/user/DS107")
out={"user":u,"leagues":{}}
for season in ("2026","2025"):
    ls=get_json(f"ul_{season}",f"{V1}/user/{u['user_id']}/leagues/nfl/{season}")
    for l in ls:
        out["leagues"][l["league_id"]]={"season":season,"name":l["name"],"total_rosters":l["total_rosters"],"status":l.get("status"),"previous":l.get("previous_league_id"),"settings":{k:l["settings"].get(k) for k in ("type","draft_rounds","taxi_slots","num_teams")},"scoring":{k:l["scoring_settings"].get(k) for k in ("rec","pass_td","bonus_rec_te")},"roster_positions":l["roster_positions"]}
for lid,l in out["leagues"].items():
    if "villain" in l["name"].lower():
        us=get_json(f"us_{lid}",f"{V1}/league/{lid}/users"); rs=get_json(f"rs_{lid}",f"{V1}/league/{lid}/rosters")
        tp=get_json(f"tp_{lid}",f"{V1}/league/{lid}/traded_picks"); dr=get_json(f"dr_{lid}",f"{V1}/league/{lid}/drafts")
        l["users"]={x["user_id"]:x["display_name"] for x in us}
        l["rosters"]=[{"roster_id":r["roster_id"],"owner":l["users"].get(r["owner_id"]),"n":len(r.get("players") or [])} for r in rs]
        l["traded_picks"]=tp; l["drafts"]=[{k:d.get(k) for k in ("draft_id","season","type","status","draft_order","slot_to_roster_id","settings")} for d in dr]
os.makedirs("scratch",exist_ok=True); json.dump(out,open("scratch/leagues_list.json","w"),indent=1)
