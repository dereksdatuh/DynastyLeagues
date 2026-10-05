# Dynasty Leagues

A self-running dynasty fantasy football engine. For every league in
`data/leagues.json` it pulls the league from Sleeper, prices every player and pick
for that league's exact roster and scoring settings, and publishes rankings, team
breakdowns and a trade calculator.

## What it does

- **Market values from several sites**: FantasyCalc (queried for the league's exact
  team count, QB format and PPR), KeepTradeCut, and DynastyProcess (FantasyPros
  consensus). Each source is quantile-mapped onto one value curve and averaged, and
  the spread between sites is kept so you can see where the market disagrees.
- **Exact-scoring fit**: every player's projected and recent stat lines are scored
  under your league's real settings (6pt pass TDs, TE premium, rush attempt and
  first-down points, IDP tackles and sacks, anything Sleeper supports) and compared
  with generic scoring. Players and positions your scoring favors move up.
- **League production model**: replacement level is found by filling every starting
  lineup in your league (flex slots last), then points over replacement are projected
  five years with positional age curves and year-to-year stability, and calibrated onto
  the market scale. Positions no market prices (IDP, K, DEF) are valued from this.
- **Final value** = 60% scoring-adjusted market + 40% model (tunable in
  `engine/valuation.py`).
- **Rankings**: overall and positional, with tiers, market vs. model, scoring fit,
  points per game, this week's projected points (Sleeper) and owner.
- **Trade calculator**: pick two teams, add players and picks, get a verdict with a
  consolidation premium (one great player beats two good ones with the same raw total)
  and suggested pieces to balance it.
- **Projected records**: each team's best lineup by rest-of-season points per game
  (injured players discounted) plays its real remaining Sleeper schedule, including a
  league-median game if the league uses one. Projected record = current record plus
  expected wins. The trade calculator shows how each team's projected record and
  standing change if the trade goes through.
- **Projected max PF**: max PF so far (Sleeper's potential points) plus the best
  lineup's projected points for each regular-season week left, with its league rank,
  on the Teams tab and before/after in the trade calculator.
- **Sorting**: every table sorts by clicking a column header (again to flip, a third
  time to restore the default order).
- **Owner messages**: for every other owner in a trade, the calculator writes a
  ready-to-send pitch that lists only the reasons that are true for them (value edge,
  needs filled, lineup rank, projected wins, picks, age, scoring fit), with a copy
  button. You send it yourself in Sleeper; nothing is sent automatically. Your own
  team is recognized from `sleeper_username` in `data/leagues.json`.
- **Teams**: power rankings by total value, optimal starting lineup value, pick
  capital, projected points this week, starter age and contender/rebuilding outlook.
- **Matchups**: this week's scores in every league. While the tab is open the page
  pulls live points from Sleeper and game clocks from ESPN every minute (falling back
  to the last build's snapshot if either is unreachable). Each card shows points so
  far, starters still to play, projected final (points so far + each starter's
  projection for the part of his game left) and win odds; open one for both lineups.
  Your matchup is first and open.
- **Players of the Week**: top scorers in your league's scoring, overall and by
  position, for this week so far (rostered players) and last week's final (everyone,
  free agents included).
- **Risers & Fallers**: biggest value changes over the last 7 days in each league's
  own values. The build keeps a daily snapshot per league for 21 days
  (`data/history/<id>.json` on the published site); until a week has built up the tab
  uses FantasyCalc's 30-day trend.
- **News**: an injury report for rostered players (Sleeper) and ESPN headlines about
  rostered players, with yours first.
- **Picks**: ownership comes from Sleeper (traded picks included); next year's picks
  are tiered early/mid/late by projected finish.

## Running it on its own

`.github/workflows/build-values.yml` runs the engine every hour and publishes the
site to GitHub Pages. One-time setup: **Settings → Pages → Source: GitHub Actions**.
Every run's summary page shows each league's source health and its top 25.

## Running locally

```bash
pip install -r requirements.txt
python -m engine.build              # writes site/data/*.json
uvicorn backend.main:app --reload   # serves the site at http://localhost:8000
```

The server also offers `POST /api/rebuild?league_id=...` and `POST /api/trade`
(`{"league_id", "a": [asset ids], "b": [asset ids]}`), and `PUT /api/leagues/{id}` to
edit buy-ins and payouts.

## Configuring leagues

Each entry in `data/leagues.json` needs an `id` and the `sleeper_league_id` (the number
in your sleeper.com league URL); `buy_in`, `payouts` and `notes` are shown on the
League tab.

## Tests

`python -m pytest -q` runs the whole pipeline offline against synthetic fixtures
(including one built on league-1's real 14-team superflex TE-premium IDP settings).

## Layout

- `engine/` — Sleeper client, market sources, scoring, model, valuation, picks, trade math, build CLI
- `site/` — static front end (reads `site/data/`)
- `backend/` — optional FastAPI server
- `.claude/skills/dynasty-engine/` — how a Claude session should use and extend the engine
