"""HTTP fetching with a small on-disk cache.

Every network read in the engine goes through `get_json` / `get_text`, keyed by a
stable cache name. Tests swap `TRANSPORT` for a fake so the whole pipeline runs
offline against fixtures.
"""

import json
import time
from pathlib import Path

import httpx

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "cache"
USER_AGENT = "Mozilla/5.0 (compatible; DynastyLeaguesEngine/1.0; +https://github.com/dereksdatuh/dynastyleagues)"


def _http_get(url: str, params: dict | None) -> httpx.Response:
    resp = httpx.get(
        url,
        params=params,
        timeout=45,
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT},
    )
    resp.raise_for_status()
    return resp


# Swappable for tests: (url, params) -> httpx.Response-like with .text and .json()
TRANSPORT = _http_get


def _cache_file(key: str, ext: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in key)
    return CACHE_DIR / f"{safe}.{ext}"


def _read_cache(path: Path, ttl: int):
    if ttl <= 0 or not path.exists():
        return None
    if time.time() - path.stat().st_mtime > ttl:
        return None
    return path.read_text()


def get_text(key: str, url: str, params: dict | None = None, ttl: int = 3600) -> str:
    path = _cache_file(key, "txt")
    cached = _read_cache(path, ttl)
    if cached is not None:
        return cached
    text = TRANSPORT(url, params).text
    if ttl > 0:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return text


def get_json(key: str, url: str, params: dict | None = None, ttl: int = 3600):
    path = _cache_file(key, "json")
    cached = _read_cache(path, ttl)
    if cached is not None:
        return json.loads(cached)
    data = TRANSPORT(url, params).json()
    if ttl > 0:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))
    return data
