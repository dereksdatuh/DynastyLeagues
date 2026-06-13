import httpx

from . import storage

SLEEPER_BASE = "https://api.sleeper.app/v1"

# Sleeper's roster_positions slots that can be filled by a QB
QB_ELIGIBLE_FLEX_SLOTS = {"SUPER_FLEX"}


async def _get(client: httpx.AsyncClient, url: str) -> dict | list:
    resp = await client.get(url, timeout=20)
    resp.raise_for_status()
    return resp.json()


async def get_league(league_id: str) -> dict:
    async with httpx.AsyncClient() as client:
        return await _get(client, f"{SLEEPER_BASE}/league/{league_id}")


async def get_rosters(league_id: str) -> list:
    async with httpx.AsyncClient() as client:
        return await _get(client, f"{SLEEPER_BASE}/league/{league_id}/rosters")


async def get_users(league_id: str) -> list:
    async with httpx.AsyncClient() as client:
        return await _get(client, f"{SLEEPER_BASE}/league/{league_id}/users")


async def get_players_db() -> dict:
    """Full sleeper player dictionary, keyed by sleeper player id. Cached for 24h since it's huge."""
    cached = storage.read_cache("sleeper_players", max_age_seconds=60 * 60 * 24)
    if cached is not None:
        return cached
    async with httpx.AsyncClient() as client:
        data = await _get(client, f"{SLEEPER_BASE}/players/nfl")
    storage.write_cache("sleeper_players", data)
    return data


async def get_league_bundle(league_id: str) -> dict:
    """Fetch league settings, rosters, and users together."""
    async with httpx.AsyncClient() as client:
        league = await _get(client, f"{SLEEPER_BASE}/league/{league_id}")
        rosters = await _get(client, f"{SLEEPER_BASE}/league/{league_id}/rosters")
        users = await _get(client, f"{SLEEPER_BASE}/league/{league_id}/users")
    return {"league": league, "rosters": rosters, "users": users}


def derive_value_params(league: dict) -> dict:
    """Translate Sleeper league settings into the inputs needed for the value model."""
    roster_positions = league.get("roster_positions", [])
    scoring_settings = league.get("scoring_settings", {})
    num_teams = league.get("total_rosters", 12)

    qb_slots = roster_positions.count("QB")
    superflex_slots = sum(1 for p in roster_positions if p in QB_ELIGIBLE_FLEX_SLOTS)
    is_superflex = superflex_slots > 0
    num_qbs = 2 if (qb_slots + superflex_slots) >= 2 else 1

    te_slots = roster_positions.count("TE")
    wr_slots = roster_positions.count("WR")
    rb_slots = roster_positions.count("RB")
    flex_slots = roster_positions.count("FLEX") + roster_positions.count("WRRB_FLEX")

    ppr = round(float(scoring_settings.get("rec", 0)) * 2) / 2  # snap to nearest 0.5
    te_premium_bonus = float(scoring_settings.get("bonus_rec_te", 0))

    return {
        "num_teams": num_teams,
        "num_qbs": num_qbs,
        "is_superflex": is_superflex,
        "ppr": ppr,
        "te_premium_bonus": te_premium_bonus,
        "roster_counts": {
            "QB": qb_slots,
            "RB": rb_slots,
            "WR": wr_slots,
            "TE": te_slots,
            "FLEX": flex_slots,
            "SUPER_FLEX": superflex_slots,
        },
    }
