import httpx

from . import storage

FANTASYCALC_BASE = "https://api.fantasycalc.com/values/current"


async def fetch_fantasycalc_values(num_teams: int, num_qbs: int, ppr: float) -> list[dict]:
    """Pull baseline dynasty trade values from FantasyCalc for a given league shape.

    Cached per (num_teams, num_qbs, ppr) combo for 12h.
    """
    cache_key = f"fantasycalc_{num_teams}_{num_qbs}_{ppr}"
    cached = storage.read_cache(cache_key, max_age_seconds=60 * 60 * 12)
    if cached is not None:
        return cached

    params = {
        "isDynasty": "true",
        "numQbs": num_qbs,
        "numTeams": num_teams,
        "ppr": ppr,
        "includeAdp": "true",
    }
    async with httpx.AsyncClient() as client:
        resp = await client.get(FANTASYCALC_BASE, params=params, timeout=20)
        resp.raise_for_status()
        data = resp.json()

    storage.write_cache(cache_key, data)
    return data


def apply_scoring_adjustments(fc_values: list[dict], value_params: dict) -> list[dict]:
    """Apply league-specific adjustments on top of the FantasyCalc baseline.

    - TE premium: bump TE values based on the per-reception TE bonus in the league's
      scoring settings (heuristic multiplier).
    - Re-ranks players after adjustment to produce this league's own dynasty order.
    """
    te_bonus = value_params.get("te_premium_bonus", 0) or 0
    # Heuristic: each +0.5 PPR-equivalent bonus for TEs adds ~12% to a TE's value,
    # capped so we don't blow up low-end TE values disproportionately.
    te_multiplier = 1 + min(te_bonus, 2.0) * 0.24

    adjusted = []
    for entry in fc_values:
        player = entry.get("player", {})
        base_value = entry.get("value", 0)
        position = player.get("position")

        multiplier = 1.0
        if position == "TE" and te_bonus > 0:
            multiplier = te_multiplier

        league_value = round(base_value * multiplier)

        adjusted.append(
            {
                "sleeper_id": player.get("sleeperId"),
                "name": player.get("name"),
                "position": position,
                "team": player.get("maybeTeam"),
                "age": player.get("maybeAge"),
                "base_value": base_value,
                "league_value": league_value,
                "fantasycalc_overall_rank": entry.get("overallRank"),
                "fantasycalc_position_rank": entry.get("positionRank"),
            }
        )

    adjusted.sort(key=lambda p: p["league_value"], reverse=True)
    for i, p in enumerate(adjusted, start=1):
        p["league_rank"] = i
        p.pop("fantasycalc_overall_rank", None)

    # Recompute position ranks based on the new ordering
    pos_counters: dict[str, int] = {}
    for p in adjusted:
        pos = p["position"]
        pos_counters[pos] = pos_counters.get(pos, 0) + 1
        p["league_position_rank"] = pos_counters[pos]
        p.pop("fantasycalc_position_rank", None)

    return adjusted


async def get_league_values(value_params: dict) -> list[dict]:
    fc_values = await fetch_fantasycalc_values(
        num_teams=value_params["num_teams"],
        num_qbs=value_params["num_qbs"],
        ppr=value_params["ppr"],
    )
    return apply_scoring_adjustments(fc_values, value_params)
