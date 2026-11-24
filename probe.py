import re, json, urllib.request, urllib.parse
UA = {"User-Agent": "Mozilla/5.0"}
def get(u, h=None):
    r = urllib.request.urlopen(urllib.request.Request(u, headers={**UA, **(h or {})}), timeout=30)
    return r.read().decode("utf-8", "replace"), dict(r.headers)
out = []
html, _ = get("https://keeptradecut.com/devy-rankings?page=0&filters=QB|WR|RB|TE&format=2")
ver = re.search(r"playersVersion\s*=\s*'([^']+)'", html).group(1)
src = re.search(r'src="(/early/dataCache\.js[^"]*)"', html).group(1)
js, _ = get("https://keeptradecut.com" + src)
out.append(js[:12000])
for path in ("/devy-rankings/player-pool", "/dynasty-rankings/player-pool"):
    for q, h in ((f"?v={ver}", {}), ("", {"X-Players-Version": ver}), ("", {})):
        try:
            body, hd = get("https://keeptradecut.com" + path + q, h)
            try:
                j = json.loads(body); n = len(j) if isinstance(j, list) else list(j)[:8]
            except Exception: n = "notjson"
            out.append(f"{path}{q} {h}: {len(body)} bytes, {n}, ctype {hd.get('Content-Type')} first {body[:300]!r}")
        except Exception as e:
            out.append(f"{path}{q} {h}: ERR {e}")
open("scratch/devy_probe.txt", "w").write("\n".join(out))
