"""Market value sources. Each `fetch(fmt, index)` returns a list of entries:

    {"source", "sleeper_id", "name", "group", "value", "kind": "player"|"pick",
     "pick": (year, round, tier) | None, "trend": float | None}

Values are in the source's own scale; `engine.market` puts them on one scale.
A source that fails is reported and skipped, never fatal.
"""

from . import dynastyprocess, fantasycalc, ktc

SOURCES = {
    "fantasycalc": fantasycalc.fetch,
    "ktc": ktc.fetch,
    "dynastyprocess": dynastyprocess.fetch,
}
