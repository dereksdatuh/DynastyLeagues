import json, re, urllib.request
out = []
for fmt in (2, 1):
    url = f"https://keeptradecut.com/devy-rankings?page=0&filters=QB|WR|RB|TE&format={fmt}"
    try:
        html = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30).read().decode("utf-8", "replace")
    except Exception as e:
        out.append(f"{fmt} ERR {e}"); continue
    out.append(f"format {fmt}: {len(html)} bytes, playerName count {html.count('\"playerName\"')}")
    for m in re.finditer(r"(\w+)\s*=\s*\[", html):
        i = m.end() - 1
        try:
            rows, _ = json.JSONDecoder().raw_decode(html, i)
        except ValueError:
            continue
        if isinstance(rows, list) and rows and isinstance(rows[0], dict) and "playerName" in rows[0]:
            yrs = {}
            for r in rows: yrs[str(r.get("draftYear"))] = yrs.get(str(r.get("draftYear")), 0) + 1
            out.append(f"  var {m.group(1)} at {i}: {len(rows)} rows, draftYear {yrs}, first {[r.get('playerName') for r in rows[:5]]}")
    for m in re.finditer(r"playersArray", html):
        out.append("  ctx: " + html[max(m.start()-80,0):m.start()+160].replace("\n"," "))
    for k in ("devy-rankings?page=1", "page=1", "Load More", "pagination"):
        out.append(f"  has {k!r}: {k in html}")
open("scratch/devy_probe.txt", "w").write("\n".join(out))
