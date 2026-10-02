"""DynastyProcess: values derived from FantasyPros expert consensus rankings."""

import csv
import io

from ..fetch import get_text
from ..league import POSITION_GROUP
from ..picks import parse_pick

URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/values.csv"


def fetch(fmt, index) -> list[dict]:
    text = get_text("dp_values", URL, ttl=12 * 3600)
    col = "value_2qb" if fmt.superflex else "value_1qb"
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        try:
            value = float(row.get(col) or 0)
        except ValueError:
            continue
        if value <= 0:
            continue
        name = row.get("player") or ""
        if row.get("pos") == "PICK":
            pick = parse_pick(name, fmt.num_teams)
            if pick:
                out.append({"source": "dynastyprocess", "sleeper_id": None, "name": name, "group": "PICK",
                            "value": value, "kind": "pick", "pick": pick, "trend": None})
            continue
        group = POSITION_GROUP.get(row.get("pos") or "")
        sid = index.resolve(name, group, source="fantasypros", ext_id=row.get("fp_id"), team=row.get("team"))
        out.append({"source": "dynastyprocess", "sleeper_id": sid, "name": name, "group": group,
                    "value": value, "kind": "player", "pick": None, "trend": None})
    return out
