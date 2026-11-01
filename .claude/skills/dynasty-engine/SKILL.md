---
name: dynasty-engine
description: Use when evaluating a trade, ranking players, checking a team, or changing how player values are computed in Derek's dynasty leagues (this repo's engine/).
---

# Dynasty engine

Values are built per league by `python -m engine.build` into `site/data/<league-id>.json`
(leagues live in `data/leagues.json`). The GitHub Action `build-values.yml` runs it every
hour and publishes the site; its run summary and `site-data` artifact hold the latest JSON.

## Answering questions with real numbers

1. Get fresh data: run `python -m engine.build --league <id>` (needs network to
   api.sleeper.app, api.fantasycalc.com, keeptradecut.com, raw.githubusercontent.com).
   If those hosts are blocked here, download the `site-data` artifact from the latest
   successful `Build dynasty values` run instead. Never quote values from memory.
2. Load `site/data/<id>.json`. Players and picks share one value scale; `id` is the
   Sleeper player id or `pick:<year>:<round>:<original roster id>`.
3. Trades: `engine.trade.evaluate(side_a, side_b, scale)` where each side is the list of
   assets that team *receives* (`[{"value": ..., "kind": "player"|"pick"}]`) and `scale`
   is the league's top asset value. Report the verdict, the
   adjusted totals, and `to_balance` if uneven; name concrete balancing pieces from
   the shorter side's partner roster (`teams[].players` / `teams[].picks`).
4. Always say which league and when the data was built (`generated_at`).

## Where each piece of logic lives

- `engine/league.py`: slot eligibility, exact-scoring points (`fantasy_points`).
- `engine/market.py`: quantile-maps each site onto one scale; `SOURCE_WEIGHTS`.
- `engine/model.py`: replacement level (lineup fill), `AGE_CURVES`, `STABILITY`,
  `HORIZON_YEARS`, `DISCOUNT`.
- `engine/valuation.py`: scoring-fit premiums, model calibration, `MODEL_WEIGHT`,
  `UNPRICED_DISCOUNT` (IDP/K/DEF), tiers.
- `engine/trade.py` and `site/app.js` (`adjustTrade`, `evenOut`): the value adjustment
  (`DEPTH_EXP`, `STUD_SHARE`, roster-spot cost). Keep both in sync.
- `site/app.js` (`assignBuilds`): the eight builds re-run on post-trade rosters for the
  direction label; mirrors `engine/builds.py`, keep both in sync.
- `engine/record.py` and `site/app.js` (`projectRecords`): projected records from
  rest-of-season lineup ppg and the remaining schedule; `SIGMA_SHARE` (weekly score
  spread) and `AVAILABILITY` (injury discounts). Keep both in sync.
  Rest-of-season ppg leans on Sleeper's next `UPCOMING_WEEKS` weekly projections
  (`UPCOMING_WEIGHT`), so role changes from injuries show up right away.
- `site/app.js` (`login`, `loadLeague`, `buildLite`): the site opens on a Sleeper
  username login (nothing loads by default; `?user=name` logs straight in). A league in
  `data/leagues.json` opens its built JSON (matched by `sleeper_league_id` in
  `index.json`); any other league is valued in the browser: player values from the
  built league with the closest format (`closestBuilt`), rosters, picks, records,
  schedule and builds from Sleeper's public API. `?lite` forces that path on a built
  league to compare. Never write other users' Sleeper data into the repo.
- `site/app.js` (`pitchFor`): owner trade messages; each reason is only included
  when it holds for that owner.
- `engine/weekly.py` and `site/app.js` (week block): matchup snapshot, ESPN game
  status (`game_status` mirrors JS `gameStatus`), players of the week, value history
  and movers, ESPN news and the injury report. The browser refreshes matchups live.
- `engine/draft.py` and `site/app.js` (`runMock`): next year's draft order rule
  (`infer_rule`), projected order and board, KTC devy class valued by slot, and the
  mock itself (`NEED_BONUS`, `MOCK_LOOKAHEAD`).
- `engine/backtest.py` -> `data/model_tuning.json`: run `python -m engine.backtest` to refit
  age curves (by player type), STABILITY, availability carry-over, season weights and
  in-season role weights on nflverse history. `engine/model.py` loads the file; its own
  constants are the fallback. Commit the regenerated JSON.
- `engine/role.py` + `engine/nflverse.py`: usage shares, depth charts, contracts, coaching
  changes (nflverse releases, summaries cached as `data/cache/keep_nflv_*`).
- `engine/gamelog.py`: every game this season and last, scored by league rules (floor,
  ceiling, recent form).
- `engine/market_learn.py`: per-league position multipliers from that league's own trades
  (cautious: prior, decay, Huber loss, clamp). Shown as `league_market` in the league JSON.
- `engine/weeks.py` and `site/app.js` (`teamWeeks`, `seasonModel`): every team's best
  lineup for each week left, playoffs included, with byes (nflverse schedule,
  `nflverse.byes`) and injuries (`RETURN`) taken out; spread from starters' game logs
  (`SD_SCALE`) plus one season-long error per team (`BIAS_SHARE`). Records, strength of
  schedule, the landing sim and the Playoff Odds tab all play these weekly lineups.
  Ships `players[].wk` (lined up with `schedule.sim_weeks`), `players[].cv`, `teams[].weekly`.
- `engine/landing.py`: in-season Monte Carlo of the rest of the season and playoffs; the
  coming draft's picks are priced over every slot they land at (`picks[].landing`).
- The build workflow caches only `data/cache/keep_*` between runs (finished weeks, old
  trades, nflverse summaries); everything live is fetched fresh.
- New market source: add `engine/sources/<name>.py` with `fetch(fmt, index)` returning
  the entry shape documented in `engine/sources/__init__.py`, register it in `SOURCES`
  and `market.SOURCE_WEIGHTS`, and add a fake response in `tests/conftest.py`.

## Checks before pushing a change

`python -m pytest -q` (fully offline), then let CI's live build run and read its summary
table: every source should show `ok` with most players matched.
