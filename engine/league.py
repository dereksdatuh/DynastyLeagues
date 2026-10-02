"""League format and exact-scoring math derived from Sleeper league settings."""

from dataclasses import dataclass, field

# Which player position groups can fill each Sleeper roster slot.
SLOT_ELIGIBILITY = {
    "QB": {"QB"},
    "RB": {"RB"},
    "WR": {"WR"},
    "TE": {"TE"},
    "K": {"K"},
    "DEF": {"DEF"},
    "DL": {"DL"},
    "LB": {"LB"},
    "DB": {"DB"},
    "FLEX": {"RB", "WR", "TE"},
    "WRRB_FLEX": {"RB", "WR"},
    "REC_FLEX": {"WR", "TE"},
    "SUPER_FLEX": {"QB", "RB", "WR", "TE"},
    "IDP_FLEX": {"DL", "LB", "DB"},
}
NON_STARTING = {"BN", "IR", "TAXI"}

# Map raw NFL positions onto the fantasy groups used by slots.
POSITION_GROUP = {
    "QB": "QB", "RB": "RB", "FB": "RB", "WR": "WR", "TE": "TE", "K": "K", "DEF": "DEF",
    "DL": "DL", "DE": "DL", "DT": "DL", "NT": "DL",
    "LB": "LB", "ILB": "LB", "OLB": "LB", "MLB": "LB",
    "DB": "DB", "CB": "DB", "S": "DB", "SS": "DB", "FS": "DB",
}


def position_group(player: dict) -> str | None:
    """Fantasy position group for a Sleeper player record."""
    for pos in player.get("fantasy_positions") or []:
        if pos in POSITION_GROUP:
            return POSITION_GROUP[pos]
    return POSITION_GROUP.get(player.get("position") or "")


@dataclass
class LeagueFormat:
    num_teams: int
    slots: list[str]
    scoring: dict
    roster_size: int
    taxi_slots: int = 0
    draft_rounds: int = 4
    positions: set = field(default_factory=set)

    @property
    def superflex(self) -> bool:
        return "SUPER_FLEX" in self.slots or self.slots.count("QB") >= 2

    @property
    def num_qbs(self) -> int:
        return 2 if self.superflex else 1

    @property
    def ppr(self) -> float:
        return round(float(self.scoring.get("rec", 0)) * 2) / 2

    @property
    def te_premium(self) -> float:
        return float(self.scoring.get("bonus_rec_te", 0) or 0)

    @property
    def idp(self) -> bool:
        return bool(self.positions & {"DL", "LB", "DB"})

    def summary(self) -> dict:
        return {
            "num_teams": self.num_teams,
            "superflex": self.superflex,
            "num_qbs": self.num_qbs,
            "ppr": self.ppr,
            "te_premium": self.te_premium,
            "pass_td": self.scoring.get("pass_td", 4),
            "idp": self.idp,
            "starting_slots": self.slots,
            "roster_size": self.roster_size,
            "taxi_slots": self.taxi_slots,
            "draft_rounds": self.draft_rounds,
        }


def format_from_sleeper(league: dict) -> LeagueFormat:
    roster_positions = league.get("roster_positions") or []
    slots = [s for s in roster_positions if s not in NON_STARTING and s in SLOT_ELIGIBILITY]
    positions = set()
    for s in slots:
        positions |= SLOT_ELIGIBILITY[s]
    settings = league.get("settings") or {}
    return LeagueFormat(
        num_teams=int(league.get("total_rosters") or 12),
        slots=slots,
        scoring=dict(league.get("scoring_settings") or {}),
        roster_size=len(roster_positions),
        taxi_slots=int(settings.get("taxi_slots") or 0),
        draft_rounds=int(settings.get("draft_rounds") or 4),
        positions=positions,
    )


def baseline_scoring(ppr: float) -> dict:
    """The generic scoring that public market values implicitly assume."""
    return {
        "pass_yd": 0.04, "pass_td": 4, "pass_int": -1, "pass_2pt": 2,
        "rush_yd": 0.1, "rush_td": 6, "rush_2pt": 2,
        "rec": ppr, "rec_yd": 0.1, "rec_td": 6, "rec_2pt": 2,
        "fum_lost": -2,
    }


_POS_REC_BONUS = {"TE": "bonus_rec_te", "RB": "bonus_rec_rb", "WR": "bonus_rec_wr"}


def fantasy_points(stats: dict | None, scoring: dict, group: str | None = None) -> float:
    """Points for a stat line under a league's exact scoring settings.

    Sleeper stat keys line up with scoring keys, so this is a dot product. Sleeper
    usually includes position-specific reception bonuses (e.g. `bonus_rec_te`) in
    the stat line already; when it doesn't, derive them from receptions.
    """
    if not stats:
        return 0.0
    total = 0.0
    for key, weight in scoring.items():
        val = stats.get(key)
        if isinstance(val, (int, float)) and weight:
            total += val * weight
    bonus_key = _POS_REC_BONUS.get(group or "")
    if bonus_key and bonus_key not in stats and scoring.get(bonus_key):
        total += float(stats.get("rec") or 0) * scoring[bonus_key]
    return total
