import re, urllib.request, urllib.parse
UA = {"User-Agent": "Mozilla/5.0"}
get = lambda u: urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30).read().decode("utf-8", "replace")
out = []
html = get("https://keeptradecut.com/devy-rankings?page=0&filters=QB|WR|RB|TE&format=2")
i = html.find("function ktcFetchPlayerPool")
out.append(f"inline def at {i}")
if i != -1: out.append(html[i:i+2500])
srcs = re.findall(r'<script[^>]+src="([^"]+)"', html)
out.append("srcs: " + " | ".join(srcs))
for s in srcs:
    u = urllib.parse.urljoin("https://keeptradecut.com/", s)
    if "keeptradecut" not in u: continue
    try: js = get(u)
    except Exception as e: out.append(f"{u} ERR {e}"); continue
    j = js.find("ktcFetchPlayerPool")
    if j != -1:
        out.append(f"== {u} ({len(js)} bytes)"); out.append(js[max(j-200,0):j+3000])
d = get("https://keeptradecut.com/dynasty-rankings?page=0&filters=QB|WR|RB|TE|RDP&format=2")
k = d.find("playersArray")
out.append("dynasty page: " + d[max(k-100,0):k+300].replace("\n", " "))
open("scratch/devy_probe.txt", "w").write("\n".join(out))
