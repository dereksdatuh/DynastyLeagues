"""Scratch probe: can a GitHub runner reach Reddit? Writes status codes and counts only."""
import json, urllib.request
URLS = {
    "www search.json": "https://www.reddit.com/r/DynastyFF/search.json?q=Bijan%20Robinson&restrict_sr=1&sort=new&limit=25",
    "www new.json": "https://www.reddit.com/r/DynastyFF/new.json?limit=25",
    "old new.json": "https://old.reddit.com/r/DynastyFF/new.json?limit=25",
    "api.reddit.com": "https://api.reddit.com/r/DynastyFF/new?limit=25",
    "rss search": "https://www.reddit.com/r/DynastyFF/search.rss?q=Bijan&restrict_sr=1&sort=new",
    "pullpush": "https://api.pullpush.io/reddit/search/submission/?q=Bijan%20Robinson&subreddit=DynastyFF&size=25",
}
out = []
for k, u in URLS.items():
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "linux:dynasty-engine:0.1 (scratch probe)"}), timeout=20)
        body = r.read()
        n = None
        try:
            d = json.loads(body); n = len(d.get("data", {}).get("children", d.get("data", []) if isinstance(d.get("data"), list) else []))
        except Exception:
            n = body.count(b"<entry>")
        out.append(f"{k}: {r.status} items={n}")
    except Exception as e:
        out.append(f"{k}: ERR {getattr(e, 'code', '')} {type(e).__name__}")
open("scratch/reddit_probe.txt", "w").write("\n".join(out) + "\n")
print("\n".join(out))
