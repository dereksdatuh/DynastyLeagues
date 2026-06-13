# Dynasty Leagues

Tracks your dynasty fantasy football leagues, formats, buy-ins/payouts, and produces
2026 dynasty player values customized to each league's scoring and roster settings.

## How it works

1. **League sync** — pulls live league settings, rosters, and standings from the
   [Sleeper API](https://docs.sleeper.com/) for each league you configure.
2. **Baseline values** — pulls public dynasty trade values from
   [FantasyCalc](https://fantasycalc.com), parameterized by your league's number of
   teams, QB format (1QB vs Superflex), and PPR scoring.
3. **League-specific adjustments** — applies further adjustments on top of the
   baseline (currently: TE premium bonus boosts TE values), then re-ranks all
   players to produce that league's own dynasty 2026 rankings.
4. **Dashboard** — a simple web UI shows each league's format, money details, team
   rosters with valuations, and full player rankings.

## Setup

```bash
pip install -r requirements.txt
uvicorn backend.main:app --reload
```

Then open http://localhost:8000

## Configuring your leagues

Edit `data/leagues.json`. For each league, fill in:

- `sleeper_league_id` — found in the URL when viewing your league on sleeper.com
  (e.g. `https://sleeper.com/leagues/<this number>/...`)
- `buy_in` — entry fee for the league
- `payouts` — object describing how money is distributed (1st, 2nd, 3rd place,
  regular season champ, last-place penalties, etc. — add whatever fields fit your
  league)
- `notes` — anything else worth remembering (side bets, rules quirks, etc.)

Example:

```json
{
  "id": "league-1",
  "name": "The Dynasty Dome",
  "sleeper_league_id": "1234567890123456789",
  "buy_in": 100,
  "currency": "USD",
  "payouts": {
    "1st": 500,
    "2nd": 250,
    "3rd": 100,
    "regular_season_champ": 50,
    "toilet_bowl_penalty": -50,
    "notes": "Last place pays $50 to 1st place winner of toilet bowl game"
  },
  "notes": "12-team superflex, TE premium (+0.5)"
}
```

You can add as many leagues as you want to the `leagues` array.

## How dynasty values adjust to your settings

- **QB format**: if your `roster_positions` include a `SUPER_FLEX` slot (or 2+ QB
  starting slots), values are pulled using FantasyCalc's 2-QB/Superflex value set,
  which significantly boosts QB values relative to 1-QB leagues.
- **PPR**: your league's `rec` scoring setting is rounded to the nearest 0.5 and
  passed to FantasyCalc (0 / 0.5 / 1 PPR value sets).
- **TE Premium**: if your league awards bonus points per TE reception
  (`bonus_rec_te`), TE values get an extra multiplier on top of the baseline, and
  the whole player pool is re-ranked.

This adjustment logic lives in `backend/values.py` (`apply_scoring_adjustments`) —
extend it if you want to account for other settings (e.g. 6pt passing TDs, IDP,
return yardage, etc.).

## API endpoints

- `GET /api/leagues` — list configured leagues (format/money metadata)
- `PUT /api/leagues/{id}` — update a league's config (buy-in, payouts, notes)
- `GET /api/leagues/{id}/sleeper` — raw Sleeper league/roster/user data
- `GET /api/leagues/{id}/values` — full player pool with this league's dynasty values
- `GET /api/leagues/{id}/rosters` — each team's roster valued under this league's settings

## Notes / next steps

- Player value cache (FantasyCalc) refreshes every 12 hours; Sleeper's full player
  database is cached for 24 hours (`data/cache/`, gitignored).
- The TE premium adjustment is a heuristic — tune the multiplier in
  `apply_scoring_adjustments` to match how your league actually plays out.
- To support a non-Sleeper league, add a client module similar to `sleeper.py` that
  produces the same `value_params` / roster shape consumed by `main.py`.
