"""Reddit buzz: what r/DynastyFF and r/fantasyfootball are saying about each player.

Reddit blocks unauthenticated reads from CI, so this runs only when the repo has
REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET secrets (a free "script" app from
reddit.com/prefs/apps, app-only OAuth). Without them `buzz` returns None and the
site simply hides the card.

Each hourly build reads the newest posts in each subreddit (a few pages, about a
week of r/DynastyFF) and, for every player it can name unambiguously, counts the
posts, sums their upvotes and comments, and scores the tone of the title and post
text with a small dynasty-flavoured word list. Output is shared across leagues:
{player_id: {posts, score, comments, tone, label, top: [...]}}.
"""

import os
import re
import time
from datetime import datetime, timezone

import httpx

SUBREDDITS = ("DynastyFF", "fantasyfootball")
PAGES = 4            # 100 posts a page
WINDOW_DAYS = 7
TOP_THREADS = 3
USER_AGENT = "linux:dynasty-leagues-engine:1.0 (by /u/dynastyleagues)"
TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
API = "https://oauth.reddit.com"

POSITIVE = ("buy", "buying", "league winner", "breakout", "smash", "elite", "stud", "riser", "rising",
            "undervalued", "steal", "target", "locked in", "alpha", "wr1", "rb1", "te1", "qb1", "ascending",
            "hype", "boom", "monster", "cornerstone", "untouchable")
NEGATIVE = ("sell", "selling", "bust", "overvalued", "injury", "injured", "ir", "out for", "torn", "acl",
            "concussion", "benched", "demoted", "faller", "falling", "declining", "washed", "cliff", "fade",
            "avoid", "suspended", "suspension", "holdout", "worried", "concern", "disappointing", "dud")


def _pat(words):
    return re.compile(r"\b(" + "|".join(re.escape(w) for w in words) + r")\b", re.I)


POS_RE, NEG_RE = _pat(POSITIVE), _pat(NEGATIVE)


def credentials():
    cid, secret = os.environ.get("REDDIT_CLIENT_ID"), os.environ.get("REDDIT_CLIENT_SECRET")
    return (cid, secret) if cid and secret else None


def _token(creds) -> str:
    r = httpx.post(TOKEN_URL, auth=creds, data={"grant_type": "client_credentials"},
                   headers={"User-Agent": USER_AGENT}, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def fetch_posts(creds, subreddits=SUBREDDITS, pages=PAGES, window_days=WINDOW_DAYS, now=None) -> list:
    """Newest posts from each subreddit inside the window (app-only OAuth, ~8 requests)."""
    token = _token(creds)
    headers = {"Authorization": f"bearer {token}", "User-Agent": USER_AGENT}
    cutoff = (now or time.time()) - window_days * 86400
    posts = []
    with httpx.Client(headers=headers, timeout=30) as client:
        for sub in subreddits:
            after = None
            for _ in range(pages):
                r = client.get(f"{API}/r/{sub}/new", params={"limit": 100, **({"after": after} if after else {})})
                r.raise_for_status()
                data = r.json()["data"]
                kids = [c["data"] for c in data["children"]]
                posts += [{"sub": sub, "title": k.get("title") or "", "text": (k.get("selftext") or "")[:4000],
                           "score": k.get("score") or 0, "comments": k.get("num_comments") or 0,
                           "url": "https://www.reddit.com" + (k.get("permalink") or ""), "created": k.get("created_utc") or 0}
                          for k in kids if (k.get("created_utc") or 0) >= cutoff]
                after = data.get("after")
                if not after or not kids or (kids[-1].get("created_utc") or 0) < cutoff:
                    break
    return posts


def name_patterns(players: dict) -> dict:
    """Player id -> regex of the names Reddit uses for him: full name always, last name
    only when no other listed player shares it (so "Smith" never matches anyone)."""
    last_count = {}
    for name in players.values():
        last = name.split()[-1].lower()
        last_count[last] = last_count.get(last, 0) + 1
    out = {}
    for pid, name in players.items():
        parts = name.split()
        forms = [name]
        last = parts[-1]
        if len(parts) > 1 and last_count[last.lower()] == 1 and len(last) >= 5 and last.lower() not in ("jones", "brown", "allen", "moore", "white", "johnson", "williams"):
            forms.append(last)
        out[pid] = re.compile(r"\b(" + "|".join(re.escape(f) for f in forms) + r")\b", re.I)
    return out


def tone(text: str) -> int:
    return len(POS_RE.findall(text)) - len(NEG_RE.findall(text))


def summarize(posts: list, players: dict) -> dict:
    pats = name_patterns(players)
    out = {}
    for p in posts:
        blob = f"{p['title']}\n{p['text']}"
        hits = [pid for pid, rx in pats.items() if rx.search(blob)]
        if not hits or len(hits) > 6:  # a rankings dump names everyone and says little about any one
            continue
        t = tone(blob)
        for pid in hits:
            b = out.setdefault(pid, {"posts": 0, "score": 0, "comments": 0, "tone_sum": 0, "threads": []})
            b["posts"] += 1
            b["score"] += max(p["score"], 0)
            b["comments"] += p["comments"]
            b["tone_sum"] += t * (1 + max(p["score"], 0) ** 0.5 / 10)
            b["threads"].append(p)
    result = {}
    for pid, b in out.items():
        top = sorted(b["threads"], key=lambda p: -(p["score"] + 2 * p["comments"]))[:TOP_THREADS]
        avg = b["tone_sum"] / b["posts"]
        label = "positive" if avg >= 0.5 else "negative" if avg <= -0.5 else "mixed"
        result[pid] = {"posts": b["posts"], "score": b["score"], "comments": b["comments"], "tone": round(avg, 2), "label": label,
                       "top": [{"title": t["title"][:160], "url": t["url"], "sub": t["sub"], "score": t["score"], "comments": t["comments"]} for t in top]}
    return result


def buzz(players: dict, now=None):
    """{player_id: buzz} for the named players, or None when there are no Reddit credentials."""
    creds = credentials()
    if not creds:
        return None
    posts = fetch_posts(creds, now=now)
    return {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "window_days": WINDOW_DAYS,
            "subreddits": list(SUBREDDITS), "posts_read": len(posts), "players": summarize(posts, players)}
