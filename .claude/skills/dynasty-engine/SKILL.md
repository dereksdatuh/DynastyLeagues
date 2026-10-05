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
3. Trades: `engine.trade.evaluate(side_a, side_b)` where each side is the list of
   assets that team *receives* (`[{"value": ...}]`). Report the verdict, the
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
- `engine/trade.py` and `site/app.js`: `CONSOLIDATION_POWER` (keep both in sync).
- `engine/record.py` and `site/app.js` (`projectRecords`): projected records from
  rest-of-season lineup ppg and the remaining schedule; `SIGMA_SHARE` (weekly score
  spread) and `AVAILABILITY` (injury discounts). Keep both in sync.
- `site/app.js` (`pitchFor`): owner trade messages; each reason is only included
  when it holds for that owner.
- `engine/weekly.py` and `site/app.js` (week block): matchup snapshot, ESPN game
  status (`game_status` mirrors JS `gameStatus`), players of the week, value history
  and movers, ESPN news and the injury report. The browser refreshes matchups live.
- New market source: add `engine/sources/<name>.py` with `fetch(fmt, index)` returning
  the entry shape documented in `engine/sources/__init__.py`, register it in `SOURCES`
  and `market.SOURCE_WEIGHTS`, and add a fake response in `tests/conftest.py`.

## Checks before pushing a change

`python -m pytest -q` (fully offline), then let CI's live build run and read its summary
table: every source should show `ok` with most players matched.
