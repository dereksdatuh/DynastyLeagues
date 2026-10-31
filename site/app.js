// Dynasty Leagues: static front end over the JSON the engine builds (site/data/).

// Value adjustment constants; keep in sync with engine/trade.py.
const DEPTH_EXP = 0.2;
const STUD_SHARE = 0.35;
const ROSTER_SPOT_PCTL = 0.7; // a last-roster-spot player: this far down the rostered players by value
const FAIR_MARGIN = 0.05;
const POSITIONS = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "K", "DEF"];

const state = { index: null, data: null, pos: "ALL", trade: { a: [], b: [] }, teamOpen: null };
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (n == null ? "" : Math.round(n).toLocaleString());

// Sleeper headshots (players) and team logos (defenses), loaded straight from Sleeper's CDN.
// Picks get a round badge instead. Anything Sleeper has no picture for just drops out.
function face(id, cls = "") {
  const sid = String(id ?? "");
  const m = sid.match(/^pick:(\d+):(\d+)/);
  // The round goes in a CSS label, so the badge adds no text to the row it sits in.
  if (m) return `<span class="face pick-face ${cls}" data-round="${["", "1st", "2nd", "3rd"][m[2]] || m[2] + "th"}" aria-hidden="true"></span>`;
  const src = /^\d+$/.test(sid) ? `https://sleepercdn.com/content/nfl/players/thumb/${sid}.jpg`
    : /^[A-Z]{2,3}$/.test(sid) ? `https://sleepercdn.com/images/team_logos/nfl/${sid.toLowerCase()}.png` : "";
  return src ? `<img class="face ${cls}" src="${src}" alt="" loading="lazy" onerror="this.remove()">` : "";
}
// Every player link anywhere on the page gets its headshot, however it was rendered.
new MutationObserver(() => {
  document.querySelectorAll(".player-link[data-pid]:not([data-faced])").forEach((el) => {
    el.dataset.faced = "1";
    el.insertAdjacentHTML("afterbegin", face(el.dataset.pid));
  });
}).observe(document.body, { childList: true, subtree: true });
const setHeadHeight = () => document.documentElement.style.setProperty("--head-h", `${document.querySelector("header").offsetHeight}px`);
addEventListener("resize", setHeadHeight);
setHeadHeight();

async function getJSON(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// ---------- data helpers ----------
// Team name with its manager's Sleeper name, so trades can be matched to people.
const teamOf = (rid) => state.data.teams.find((t) => t.roster_id === rid);
const managerOf = (t) => (t && t.owner && t.owner !== t.name ? t.owner : "");
function teamName(rid) {
  const t = teamOf(rid);
  return t ? (managerOf(t) ? `${t.name} (${managerOf(t)})` : t.name) : "";
}
function pickOwner(rid) {
  const t = teamOf(rid);
  return t ? t.name + (managerOf(t) ? `, ${managerOf(t)}` : "") : "";
}
function teamHtml(rid) {
  const t = teamOf(rid);
  return t ? `${esc(t.name)}${managerOf(t) ? ` <span class="manager">${esc(managerOf(t))}</span>` : ""}` : "";
}
function assets() {
  const players = state.data.players.map((p) => ({ ...p, kind: "player", label: `${p.name} (${p.pos}${p.team ? ", " + p.team : ""})` }));
  const picks = state.data.picks.map((p) => ({
    ...p, kind: "pick", name: p.label, pos: "PICK",
    label: p.label.includes("(via") ? p.label : `${p.label} (${pickOwner(p.original_roster_id)})`,
  }));
  return players.concat(picks);
}
function assetById(id) {
  return state.assetMap.get(id);
}

// ---------- league loading ----------
// Stamped with the commit at deploy time (see build-values.yml), like index.json's
// "build". A browser holding an older app.js than the data reloads once with the
// new version in the URL, which skips its cached copies of the page and scripts.
const BUILD = "__BUILD__";

function reloadIfStale(latest) {
  if (!latest || BUILD.startsWith("__") || latest === BUILD) return false;
  const url = new URL(location.href);
  if (url.searchParams.get("v") === latest) return false; // already tried once
  url.searchParams.set("v", latest);
  location.replace(url);
  return true;
}

// ---------- account: a Sleeper username loads that user's leagues ----------
// Anyone can use the site: enter a Sleeper username and pick one of that user's
// leagues. A league the hourly build covers opens with its full data; any other league
// is valued right here in the browser (buildLite below), so nothing about other users
// is ever stored or built into this public site.
const SLEEPER_API = "https://api.sleeper.app/v1/";
async function sleeperGet(path) {
  const r = await fetch(SLEEPER_API + path);
  if (!r.ok) throw new Error(`Sleeper ${path.split("/")[0]} lookup failed (${r.status})`);
  return r.json();
}
const LEAGUE_KIND = { 2: 0, 1: 1 }; // Sleeper settings.type: 2 dynasty, 1 keeper, 0 redraft
const kindOf = (lg) => LEAGUE_KIND[(lg.settings || {}).type] ?? 2;

async function init() {
  try {
    state.index = await getJSON("data/index.json");
    if (reloadIfStale(state.index.build)) return;
  } catch (e) {
    $("#login-status").textContent = "No values built yet. Run python -m engine.build (the scheduled GitHub Action does this hourly).";
    return;
  }
  const last = localStorageGet("username");
  if (last) $("#username").value = last;
  $("#login").addEventListener("submit", (e) => { e.preventDefault(); login($("#username").value.trim()); });
  $("#logout").addEventListener("click", logout);
  $("#league-select").addEventListener("change", () => loadLeague($("#league-select").value));
  // ?user=name opens straight to that user's leagues (a link someone can share).
  const u = new URLSearchParams(location.search).get("user");
  if (u) { $("#username").value = u; login(u); }
}

async function login(name) {
  if (!name) return;
  const status = $("#login-status");
  status.classList.remove("error");
  status.textContent = `Looking up ${name} on Sleeper...`;
  try {
    const user = await sleeperGet(`user/${encodeURIComponent(name)}`);
    if (!user || !user.user_id) throw new Error(`Sleeper has no user named "${name}".`);
    const nfl = await sleeperGet("state/nfl");
    const season = nfl.league_season || nfl.season;
    const leagues = (await sleeperGet(`user/${user.user_id}/leagues/nfl/${season}`)) || [];
    if (!leagues.length) throw new Error(`${user.display_name || name} isn't in any ${season} leagues on Sleeper.`);
    const built = new Map((state.index.leagues || []).filter((l) => l.sleeper_league_id).map((l) => [String(l.sleeper_league_id), l]));
    state.user = user;
    state.nfl = nfl;
    state.leagues = leagues.sort((a, b) => kindOf(a) - kindOf(b) || String(a.name).localeCompare(String(b.name))).map((lg) => {
      const b = built.get(String(lg.league_id));
      return { key: b ? b.id : `sl-${lg.league_id}`, built: b ? b.id : null, sleeper: lg, name: lg.name || "League",
        season: lg.season, teams: lg.total_rosters, buy_in: b?.buy_in, payouts: b?.payouts, redraft: kindOf(lg) === 2 };
    });
    localStorageSet("username", name);
    const sel = $("#league-select");
    sel.innerHTML = state.leagues.map((l) => `<option value="${esc(l.key)}">${esc(l.name)}${l.redraft ? " (redraft)" : ""}</option>`).join("");
    const saved = localStorageGet(`league.${user.user_id}`);
    if (saved && state.leagues.some((l) => l.key === saved)) sel.value = saved;
    $("#who").textContent = user.display_name || name;
    $("#login").classList.add("hidden");
    $("#account").classList.remove("hidden");
    $("#welcome").classList.add("hidden");
    $("nav.tabs").classList.remove("hidden");
    $("main").classList.remove("hidden");
    status.textContent = "";
    renderBank();
    await loadLeague(sel.value);
  } catch (e) {
    status.textContent = e.message || String(e);
    status.classList.add("error");
  }
}

function logout() {
  if (state.live) clearTimeout(state.live.timer);
  state.user = null; state.leagues = []; state.data = null;
  $("#account").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#welcome").classList.remove("hidden");
  $("nav.tabs").classList.add("hidden");
  $("main").classList.add("hidden");
  $("#updated").textContent = "";
  $("#username").focus();
}

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

// The logged-in user's team, whoever that is (the build marks its own owner).
function markMe(data) {
  const u = state.user || {};
  const names = new Set([u.display_name, u.username].filter(Boolean).map((s) => s.toLowerCase()));
  for (const t of data.teams) t.is_me = t.owner_id ? t.owner_id === u.user_id : names.has(String(t.owner || "").toLowerCase());
}

// One tab failing to draw must not blank the others.
function safely(name, fn) {
  try { fn(); } catch (e) { console.error(`${name} failed: ${e.stack || e}`); }
}

async function loadLeague(key) {
  const entry = state.leagues.find((l) => l.key === key) || state.leagues[0];
  if (!entry) return;
  localStorageSet(`league.${state.user.user_id}`, entry.key);
  const forceLite = new URLSearchParams(location.search).has("lite");
  const note = $("#lite-note");
  $("#updated").textContent = "Loading...";
  let data;
  try {
    data = entry.built && !forceLite ? await getJSON(`data/${entry.built}.json`) : await buildLite(entry);
  } catch (e) {
    if ($("#league-select").value !== entry.key) return;
    $("#updated").textContent = "";
    note.textContent = `Couldn't load ${entry.name}: ${e.message || e}`;
    note.classList.remove("hidden");
    return;
  }
  if ($("#league-select").value !== entry.key) return; // switched while loading
  markMe(data);
  state.data = data;
  if (data.lite) finishLite(data);
  state.assetMap = new Map(assets().map((a) => [a.id, a]));
  state.adjScale = null;
  state.trade = freshTrade();
  state.teamOpen = null;
  const when = new Date(state.data.generated_at);
  $("#updated").textContent = `Values updated ${when.toLocaleString()}${state.data.league.week ? ` · Week ${state.data.league.week}` : ""}`;
  note.innerHTML = data.lite ? liteNote(data) : "";
  note.classList.toggle("hidden", !data.lite);
  safely("rankings", () => { renderPosFilter(); renderRankings(); });
  safely("trade", setupTrade);
  safely("teams", renderTeams);
  safely("league", renderLeague);
  safely("week", setupWeek);
  state.liveTrades = [];
  safely("trades", renderTrades);
  safely("schedule", renderSchedule);
  finder.me = null; finder.goal = null; finder.target = null; finder.last = null; finder.three = { teams: [null, null], goals: ["auto", "auto"] };
  safely("finder", renderFinder);
  safely("rookie", renderRookieMock);
  safely("formula", renderFormula);
  resetLab();
  safely("lineups", renderLab);
  safely("odds", renderOdds);
  pickProj.year = null;
  safely("picks", renderPickProj);
  devyView.year = null;
  renderDevy().catch((e) => console.error(`devy failed: ${e.stack || e}`));
}

// ---------- any Sleeper league, valued in the browser ----------
// A league the hourly build doesn't cover borrows player values from the built league
// whose format is closest (superflex, IDP, PPR, TE premium, pass TD points, size), then
// everything that depends on this league (rosters, picks, records, schedule, builds) is
// worked out here from Sleeper's public API. Players the template doesn't price come
// from the other built leagues; the rest stay unvalued and the note above the tabs says so.
function formatOf(lg) {
  const rp = lg.roster_positions || [], sc = lg.scoring_settings || {}, st = lg.settings || {};
  const slots = rp.filter((s) => SLOT_ELIGIBILITY[s] && !["BN", "IR", "TAXI"].includes(s));
  const groups = new Set(slots.flatMap((s) => SLOT_ELIGIBILITY[s]));
  const superflex = slots.includes("SUPER_FLEX") || slots.filter((s) => s === "QB").length >= 2;
  return {
    num_teams: Number(lg.total_rosters) || 12, superflex, num_qbs: superflex ? 2 : 1,
    ppr: Math.round(Number(sc.rec || 0) * 2) / 2, te_premium: Number(sc.bonus_rec_te || 0),
    pass_td: sc.pass_td ?? 4, idp: ["DL", "LB", "DB"].some((g) => groups.has(g)),
    starting_slots: slots, roster_size: rp.length, taxi_slots: Number(st.taxi_slots) || 0,
    draft_rounds: Number(st.draft_rounds) || 4,
  };
}

function closestBuilt(f) {
  const dist = (g) => (g.superflex !== f.superflex) * 100 + (g.idp !== f.idp) * 60 + Math.abs(g.ppr - f.ppr) * 10
    + Math.abs((g.te_premium || 0) - f.te_premium) * 6 + Math.abs((g.pass_td || 4) - f.pass_td) * 2 + Math.abs(g.num_teams - f.num_teams) * 0.5;
  return [...(state.index.leagues || [])].filter((l) => l.format).sort((a, b) => dist(a.format) - dist(b.format))[0];
}

function remainingWeeks(lg, nfl) {
  const st = lg.settings || {};
  const last = Number(st.playoff_week_start || 15) - 1, start = Number(st.start_week || 1);
  if (lg.status === "complete") return [];
  const same = String(lg.season) === String(nfl.league_season || nfl.season);
  const from = lg.status === "in_season" && same && ["regular", "post"].includes(nfl.season_type) ? Math.max(Number(nfl.week) || 1, start) : start;
  const out = [];
  for (let w = from; w <= last; w++) out.push(w);
  return out;
}

function schedulePairs(rows) {
  const by = {};
  for (const m of rows || []) if (m.matchup_id != null) (by[m.matchup_id] = by[m.matchup_id] || []).push(m.roster_id);
  return Object.values(by).filter((v) => v.length === 2).map((v) => v.sort((a, b) => a - b));
}

async function buildLite(entry) {
  const lg = entry.sleeper, lid = lg.league_id, nfl = state.nfl || {};
  const fmtL = formatOf(lg);
  const tmpl = closestBuilt(fmtL);
  if (!tmpl) throw new Error("no built league to borrow values from");
  const weeks = remainingWeeks(lg, nfl);
  const nowWeek = lg.status === "in_season" ? Number(nfl.week) || null : null;
  const [base, rosters, users, traded, ...weekRows] = await Promise.all([
    getJSON(`data/${tmpl.id}.json`), sleeperGet(`league/${lid}/rosters`), sleeperGet(`league/${lid}/users`),
    sleeperGet(`league/${lid}/traded_picks`).catch(() => []),
    ...weeks.map((w) => sleeperGet(`league/${lid}/matchups/${w}`).catch(() => [])),
  ]);
  const owner = new Map();
  for (const r of rosters) for (const pid of r.players || []) owner.set(pid, r.roster_id);
  const fits = new Set(fmtL.starting_slots.flatMap((s) => SLOT_ELIGIBILITY[s]));
  const byId = new Map(base.players.map((p) => [p.id, { ...p, roster_id: owner.get(p.id) ?? null }]));
  // Rostered players the template doesn't price: take them from another built league.
  let missing = [...owner.keys()].filter((id) => !byId.has(id));
  const borrowed = [];
  for (const other of state.index.leagues || []) {
    if (!missing.length) break;
    if (other.id === tmpl.id) continue;
    let od;
    try { od = await getJSON(`data/${other.id}.json`); } catch { continue; }
    const got = new Map(od.players.map((p) => [p.id, p]));
    missing = missing.filter((id) => {
      const p = got.get(id);
      if (!p || !fits.has(p.pos)) return true;
      byId.set(id, { ...p, roster_id: owner.get(id), formula: null, call: null });
      borrowed.push(id);
      return false;
    });
  }
  const players = [...byId.values()].sort((a, b) => b.value - a.value);
  const usersById = new Map(users.map((u) => [u.user_id, u]));
  const teams = rosters.map((r) => {
    const u = usersById.get(r.owner_id) || {}, st = r.settings || {};
    const mine = (r.players || []).filter((id) => byId.has(id)).map((id) => byId.get(id));
    return {
      roster_id: r.roster_id, name: (u.metadata || {}).team_name || u.display_name || `Team ${r.roster_id}`,
      owner: u.display_name || null, owner_id: r.owner_id || null, avatar: u.avatar || null, division: st.division || null,
      record: { wins: st.wins || 0, losses: st.losses || 0, ties: st.ties || 0, fpts: (st.fpts || 0) + (st.fpts_decimal || 0) / 100,
        max_pf: Math.round(((st.ppts || 0) + (st.ppts_decimal || 0) / 100) * 100) / 100 },
      players: mine.sort((a, b) => b.value - a.value).map((p) => p.id),
      taxi: r.taxi || [], reserve: r.reserve || [], player_value: mine.reduce((t, p) => t + p.value, 0), is_me: false,
    };
  });
  // Every future pick: three drafts, this league's rounds, after Sleeper's traded picks.
  let first = Number(lg.season) || Number(nfl.season);
  if (!["pre_draft", "drafting"].includes(lg.status)) first += 1;
  const years = [first, first + 1, first + 2];
  const own = new Map();
  for (const y of years) for (let rd = 1; rd <= fmtL.draft_rounds; rd++) for (const r of rosters) own.set(`${y}:${rd}:${r.roster_id}`, r.roster_id);
  for (const t of traded || []) { const k = `${t.season}:${t.round}:${t.roster_id}`; if (own.has(k)) own.set(k, t.owner_id); }
  const picks = [...own.entries()].map(([k, cur]) => {
    const [y, rd, orig] = k.split(":").map(Number);
    return { id: `pick:${y}:${rd}:${orig}`, year: y, round: rd, original_roster_id: orig, roster_id: cur, tier: null, slot: null, value: 0 };
  });
  const schedule = {};
  weeks.forEach((w, i) => (schedule[w] = schedulePairs(weekRows[i])));
  const current = nowWeek != null ? weekRows[weeks.indexOf(nowWeek)] || [] : [];
  const relabel = (list) => (Array.isArray(list) ? list : []).map((x) => ({ ...x, roster_id: owner.get(x.id) ?? null }));
  const potw = (w) => w && Object.fromEntries(Object.entries(w).map(([k, v]) => [k, relabel(v)]));
  const divs = [...new Set(teams.map((t) => t.division).filter(Boolean))].sort((a, b) => a - b);
  const st = lg.settings || {};
  return {
    generated_at: base.generated_at, lite: { template: tmpl.name, template_id: tmpl.id, borrowed: borrowed.length,
      unvalued: missing.length, base_picks: base.picks,
      builds: base.teams.map((t) => t.build).filter(Boolean) }, history_id: tmpl.id,
    league: { id: entry.key, name: lg.name, sleeper_league_id: lid, season: lg.season, status: lg.status,
      buy_in: null, currency: "USD", payouts: null, notes: "", format: fmtL, scoring: lg.scoring_settings || {},
      week: nowWeek, playoff_teams: Number(st.playoff_teams) || Math.max(Math.floor(teams.length / 2), 1),
      divisions: Object.fromEntries(divs.map((d) => [String(d), (lg.metadata || {})[`division_${d}`] || `Division ${d}`])) },
    week: { ...base.week, week: nowWeek, matchups: current.map((r) => ({ roster_id: r.roster_id, matchup_id: r.matchup_id, points: r.points,
      starters: r.starters, players_points: r.players_points })), potw: potw(base.week?.potw), potw_last: potw(base.week?.potw_last) },
    schedule: { weeks: schedule, median_game: !!st.league_average_match, sigma: 0, sigma_share: 0.21, strength: {} },
    sources: base.sources, model: base.model, formula: base.formula, players, picks,
    rookie_draft: null, next_draft: null, future_classes: base.future_classes || {}, teams, team_values: { context: { teams: {} }, factors: {} }, trades: [],
  };
}

// The parts that need the lineup helpers (state.data is this league by now).
function finishLite(data) {
  const teams = data.teams, n = teams.length, byId = new Map(data.players.map((p) => [p.id, p]));
  for (const t of teams) {
    const ps = t.players.map((id) => byId.get(id));
    const lineup = bestLineup(ps, "value");
    t.lineup = lineup.map(({ slot, p }) => ({ slot, id: p.id, value: p.value }));
    t.week_lineup = bestLineup(ps, "proj_week").map(({ slot, p }) => ({ slot, id: p.id, proj_week: p.proj_week }));
    t.ros_lineup = bestLineup(ps, "ros_ppg").map(({ slot, p }) => ({ slot, id: p.id, ros_ppg: p.ros_ppg }));
    t.starter_value = Math.round(lineup.reduce((s, x) => s + x.p.value, 0));
    t.proj_week_points = Math.round(t.week_lineup.reduce((s, x) => s + (x.proj_week || 0), 0) * 100) / 100;
    t.ros_ppg = Math.round(t.ros_lineup.reduce((s, x) => s + (x.ros_ppg || 0), 0) * 100) / 100;
    const aged = lineup.filter((x) => x.p.age);
    const w = aged.reduce((s, x) => s + x.p.value, 0);
    t.starter_age = w ? Math.round((aged.reduce((s, x) => s + x.p.age * x.p.value, 0) / w) * 10) / 10 : null;
  }
  const sch = data.schedule;
  const ppg = Object.fromEntries(teams.map((t) => [t.roster_id, t.ros_ppg]));
  const vals = Object.values(ppg).filter((v) => v > 0);
  sch.sigma = Math.round(sch.sigma_share * (vals.reduce((a, b) => a + b, 0) / (vals.length || 1)) * 100) / 100 || 1;
  const rec = projectRecords();
  for (const t of teams) {
    const r = rec[t.roster_id], left = Object.keys(sch.weeks).length;
    t.projection = { ppg: r.ppg, wins: r.wins, losses: r.losses, ties: r.ties, pf: r.pf, remaining_wins: r.wins - t.record.wins,
      remaining_games: r.games, max_pf: r.maxPF, rank: r.rank, max_pf_rank: r.maxPFRank, weeks_left: left };
  }
  const now = seedOrder(Object.fromEntries(teams.map((t) => [t.roster_id, { ...t.record, pf: t.record.fpts }])));
  const byMax = [...teams].sort((a, b) => b.record.max_pf - a.record.max_pf);
  for (const t of teams) { t.record.seed = now.indexOf(String(t.roster_id)) + 1; t.record.max_pf_rank = byMax.indexOf(t) + 1; }
  pricePicks(data, rec);
  const pv = {};
  for (const p of data.picks) pv[p.roster_id] = (pv[p.roster_id] || 0) + p.value;
  for (const t of teams) {
    t.picks = data.picks.filter((p) => p.roster_id === t.roster_id).map((p) => p.id);
    t.pick_value = Math.round(pv[t.roster_id] || 0);
    t.total_value = t.player_value + t.pick_value;
  }
  const starterRank = new Map([...teams].sort((a, b) => b.starter_value - a.starter_value).map((t, i) => [t.roster_id, i + 1]));
  [...teams].sort((a, b) => b.total_value - a.total_value).forEach((t, i) => {
    t.power_rank = i + 1;
    t.starter_rank = starterRank.get(t.roster_id);
    t.outlook = t.starter_rank <= n / 3 ? "contender" : t.starter_rank > (2 * n) / 3 ? "rebuilding" : "middle";
  });
  teams.sort((a, b) => a.power_rank - b.power_rank);
  liteBuilds(data);
  scheduleStrength(data);
}

// Builds: the JS mirror of engine/builds.py, with each build's write-up from the template.
function liteBuilds(data) {
  const n = data.teams.length, builds = assignBuilds();
  const known = Object.fromEntries((data.lite.builds || []).map((b) => [b.key, b]));
  for (const t of data.teams) {
    const b = builds[t.roster_id], k = known[b.key] || {};
    const pr = t.projection || {};
    t.build = { ...b, about: k.about || "", plan: k.plan || [],
      reasons: [`${ordinal(b.nowRank)} of ${n} in points a week the rest of the way (${(t.ros_ppg || 0).toFixed(1)})`,
        `${ordinal(b.valueRank)} in total dynasty value`, `projected ${ordinal(pr.rank || n)}, playoff line is ${data.league.playoff_teams}`] };
  }
}

// Strength of schedule (mirrors engine/record.py strength_of_schedule).
function scheduleStrength(data) {
  const sch = data.schedule, sigma = sch.sigma;
  const ppg = Object.fromEntries(data.teams.map((t) => [t.roster_id, t.ros_ppg]));
  const out = {};
  for (const t of data.teams) {
    const rid = t.roster_id;
    const weeks = [], opp = [];
    let exp = 0, avg = 0, med = 0;
    for (const wk of Object.keys(sch.weeks).sort((a, b) => a - b)) {
      const m = sch.weeks[wk].find((p) => p.includes(rid));
      const o = m ? (m[0] === rid ? m[1] : m[0]) : null;
      const field = vsField(rid, ppg, sigma);
      const has = o != null && ppg[o] != null;
      const p = has ? winProb(ppg[rid], ppg[o], sigma) : field;
      weeks.push({ week: Number(wk), opp: has ? o : null, opp_ppg: has ? Math.round(ppg[o] * 10) / 10 : null, win: Math.round(p * 1000) / 1000 });
      if (has) opp.push(ppg[o]);
      exp += p; avg += field;
      if (sch.median_game) med += vsMedian(rid, ppg, sigma);
    }
    const r2 = (x) => Math.round(x * 100) / 100;
    out[rid] = { weeks, opp_ppg: opp.length ? Math.round((opp.reduce((a, b) => a + b, 0) / opp.length) * 10) / 10 : null,
      exp_wins: r2(exp), avg_wins: r2(avg), vs_average: r2(exp - avg), median_wins: sch.median_game ? r2(med) : null };
  }
  Object.keys(out).filter((r) => out[r].opp_ppg != null).sort((a, b) => out[b].opp_ppg - out[a].opp_ppg).forEach((r, i) => (out[r].rank = i + 1));
  sch.strength = out;
}

// Picks priced off the template's pick table by draft year, round and tier. Next
// year's tier and slot follow the projected record (worst first); the year after
// splits early/mid/late only at the ends; later years are untiered.
function pricePicks(data, rec) {
  const base = data.lite.base_picks || [];
  const baseYears = [...new Set(base.map((p) => p.year))].sort();
  const years = [...new Set(data.picks.map((p) => p.year))].sort();
  const table = {}, any = {};
  for (const p of base) {
    const k = `${p.year}:${p.round}:${p.tier}`, a = `${p.year}:${p.round}`;
    (table[k] = table[k] || []).push(p.value); (any[a] = any[a] || []).push(p.value);
  }
  const avg = (xs) => (xs && xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  const TIER_MULT = { early: 1.15, mid: 1, late: 0.87 };
  const priceOf = (yi, round, tier) => {
    const y = baseYears[Math.min(yi, baseYears.length - 1)];
    for (let r = round; r >= 1; r--) {
      const v = avg(table[`${y}:${r}:${tier}`]) ?? (avg(any[`${y}:${r}`]) != null ? avg(any[`${y}:${r}`]) * (TIER_MULT[tier] || 1) : null);
      if (v != null) return v * Math.pow(0.45, round - r);
    }
    return 0;
  };
  const order = Object.keys(rec).map(Number).sort((a, b) => rec[b].rank - rec[a].rank); // worst first
  const n = order.length;
  const name = new Map(data.teams.map((t) => [t.roster_id, t.name + (t.owner && t.owner !== t.name ? `, ${t.owner}` : "")]));
  for (const p of data.picks) {
    const yi = years.indexOf(p.year), i = order.indexOf(p.original_roster_id);
    p.tier = yi === 0 ? (i < n / 3 ? "early" : i < (2 * n) / 3 ? "mid" : "late")
      : yi === 1 ? (i < n / 6 ? "early" : i >= n - n / 6 ? "late" : "mid") : null;
    p.slot = yi === 0 ? i + 1 : null;
    p.overall = p.slot ? (p.round - 1) * n + p.slot : null;
    p.value = Math.round(priceOf(yi, p.round, p.tier));
    const via = p.roster_id !== p.original_roster_id ? ` (via ${name.get(p.original_roster_id) || "Team " + p.original_roster_id})` : "";
    p.label = (yi === 0 ? `${p.year} ${p.round}.${String(p.slot).padStart(2, "0")}`
      : p.tier ? `${p.year} ${p.tier[0].toUpperCase() + p.tier.slice(1)} ${ordinal(p.round)}` : `${p.year} ${ordinal(p.round)}`) + via;
  }
  data.picks.sort((a, b) => b.value - a.value);
}

function liteNote(data) {
  const L = data.lite;
  const gaps = [L.borrowed ? `${L.borrowed} rostered players priced from another league` : "",
    L.unvalued ? `${L.unvalued} rostered players with no value anywhere (deep bench, kickers or defenses)` : ""].filter(Boolean).join("; ");
  return `<b>Quick values.</b> This league isn't in the hourly build, so player values come from <b>${esc(L.template)}</b>, the built league with the closest settings,
    and everything else (rosters, picks, records, schedule, builds) is worked out live from Sleeper.${gaps ? ` ${esc(gaps)}.` : ""}
    Picks are priced by projected finish; the rookie mock and future rankings need the full build.`;
}

// ---------- tabs ----------
document.querySelectorAll(".tabs button").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== `tab-${btn.dataset.tab}`));
    // Coming back to Matchups after a while: refresh scores now rather than at the next poll.
    const L = state.live;
    if (btn.dataset.tab === "trades") refreshTrades();
    if (btn.dataset.tab === "lineups") safely("lineups", renderLab);
    if (btn.dataset.tab === "matchups" && L && L.week && (!L.at || Date.now() - L.at > LIVE_MS)) refreshLive();
  })
);

// ---------- rankings ----------
function renderPosFilter() {
  const present = new Set(state.data.players.map((p) => p.pos));
  const opts = ["ALL", ...POSITIONS.filter((p) => present.has(p)), "PICKS"];
  if (!opts.includes(state.pos)) state.pos = "ALL";
  $("#pos-filter").innerHTML = opts.map((p) => `<button class="chip ${p === state.pos ? "active" : ""}" data-pos="${p}">${p === "ALL" ? "Overall" : p}</button>`).join("");
  $("#pos-filter").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { state.pos = b.dataset.pos; renderPosFilter(); renderRankings(); })
  );
}
$("#search").addEventListener("input", () => renderRankings());
$("#owner-filter").addEventListener("change", () => renderRankings());

function fitBadge(premium) {
  if (!premium || Math.abs(premium - 1) < 0.02) return "";
  const pct = Math.round((premium - 1) * 100);
  return `<span class="fit ${pct > 0 ? "up" : "down"}" title="Scoring fit vs. generic market scoring">${pct > 0 ? "+" : ""}${pct}%</span>`;
}

function renderRankings() {
  const table = $("#rankings");
  const q = $("#search").value.trim().toLowerCase();
  const owner = $("#owner-filter").value;
  if (state.pos === "PICKS") {
    const picks = [...state.data.picks].sort((a, b) => b.value - a.value);
    table.innerHTML = `<thead><tr><th>#</th><th>Pick</th><th>Owner</th><th class="num">Value</th></tr></thead><tbody>${picks
      .filter((p) => !q || p.label.toLowerCase().includes(q) || teamName(p.roster_id).toLowerCase().includes(q))
      .map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.label)}</td><td>${teamHtml(p.roster_id)}</td><td class="num strong">${fmt(p.value)}</td></tr>`)
      .join("")}</tbody>`;
    return;
  }
  const byPos = state.pos !== "ALL";
  let rows = state.data.players.filter((p) => (!byPos || p.pos === state.pos) && p.value > 0);
  if (owner === "rostered") rows = rows.filter((p) => p.roster_id);
  if (owner === "fa") rows = rows.filter((p) => !p.roster_id);
  if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q) || (p.team || "").toLowerCase().includes(q));
  rows = rows.slice(0, 400);
  const tierKey = byPos ? "pos_tier" : "tier";
  let lastTier = null;
  const body = rows
    .map((p) => {
      const sep = p[tierKey] !== lastTier ? `<tr class="tier-row"><td colspan="12">Tier ${p[tierKey]}</td></tr>` : "";
      lastTier = p[tierKey];
      const src = Object.entries(p.sources || {}).map(([k, v]) => `${k}: ${fmt(v)}${(p.sources_raw || {})[k] != null ? ` (site's own ${fmt(p.sources_raw[k])})` : ""}`).join("\n");
      return `${sep}<tr>
        <td>${byPos ? p.pos_rank : p.rank}</td>
        <td><span class="name player-link" data-pid="${esc(p.id)}">${esc(p.name)}</span>${p.injury ? ` <span class="inj">${esc(p.injury)}</span>` : ""}</td>
        <td><span class="pos pos-${p.pos}">${p.pos}${p.pos_rank}</span></td>
        <td>${esc(p.team || "FA")}</td>
        <td class="num">${p.age ?? ""}</td>
        <td class="num strong">${fmt(p.value)}</td>
        <td class="num muted" title="Plain average of each site's own number">${p.sites_avg ? fmt(p.sites_avg) : "–"}</td>
        <td class="num muted" title="${esc(src)}">${p.market ? fmt(p.market) : "–"}</td>
        <td class="num muted">${p.model ? fmt(p.model) : "–"}</td>
        <td>${fitBadge(p.premium)}</td>
        <td class="num">${p.ppg ?? ""}${p.proj_week != null ? ` <span class="muted">/ ${p.proj_week}</span>` : ""}</td>
        <td class="muted">${p.roster_id ? teamHtml(p.roster_id) : "FA"}</td>
      </tr>`;
    })
    .join("");
  table.innerHTML = `<thead><tr><th>#</th><th>Player</th><th>Pos</th><th>Team</th><th class="num">Age</th>
    <th class="num" title="League value: what trades and verdicts use">League value</th><th class="num" title="Plain average of each site's own number (KTC, FantasyCalc, DynastyProcess)">Sites avg</th><th class="num" title="Consensus across sites on our shared scale">Market</th>
    <th class="num" title="League scoring production model">Model</th><th title="Scoring fit">Fit</th>
    <th class="num" title="Points per game in this league's scoring / projected this week">PPG / Wk</th><th>Owner</th></tr></thead><tbody>${body}</tbody>`;
}

// ---------- player page ----------
// Click any player name with data-pid to open everything known about him: how his
// value is built, every site's price, his value over the last weeks, what each team
// in the league would pay given its own situation, and his formula score and call.
const historyCache = {};
async function loadHistory(id) {
  if (historyCache[id] !== undefined) return historyCache[id];
  try { historyCache[id] = await getJSON(`data/history/${id}.json`); } catch { historyCache[id] = null; }
  return historyCache[id];
}

function sparkline(points) {
  if (points.length < 2) return "";
  const w = 320, h = 70, pad = 4;
  const vs = points.map((p) => p[1]), lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const xy = points.map(([, v], i) => [pad + (i * (w - 2 * pad)) / (points.length - 1), h - pad - ((v - lo) * (h - 2 * pad)) / span]);
  const up = vs[vs.length - 1] >= vs[0];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Value over time">
    <polyline fill="none" stroke="var(--${up ? "good" : "bad"})" stroke-width="2" points="${xy.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")}" />
    ${xy.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="var(--${up ? "good" : "bad"})"><title>${esc(points[i][0])}: ${fmt(points[i][1])}</title></circle>`).join("")}
  </svg><div class="spark-axis muted"><span>${esc(points[0][0])} · ${fmt(vs[0])}</span><span>${esc(points[points.length - 1][0])} · ${fmt(vs[vs.length - 1])}</span></div>`;
}

async function openPlayer(id) {
  const p = state.data.players.find((x) => x.id === id);
  if (!p) return;
  let modal = $("#player-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "player-modal";
    modal.className = "modal hidden";
    modal.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true"><button class="modal-close" aria-label="Close">×</button><div id="player-body"></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest(".modal-close")) modal.classList.add("hidden"); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") modal.classList.add("hidden"); });
  }
  const mine = myTeam();
  const pct = (x) => `${x > 0 ? "+" : ""}${Math.round(x * 100)}%`;
  const raw = p.sources_raw || {};
  const srcRows = Object.entries(p.sources || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${raw[k] != null ? fmt(raw[k]) : "–"}</td><td class="num">${fmt(v)}</td></tr>`).join("");
  // What each team would pay: league value times that team's own multiplier.
  const buyers = state.data.teams.map((t) => ({ t, v: p.value * teamFactor(t.roster_id, p.id), c: teamCtx(t.roster_id) }))
    .sort((a, b) => b.v - a.v);
  const buyRows = buyers.map(({ t, v, c }) => `<tr class="${p.roster_id === t.roster_id ? "mine-row" : ""}"><td>${teamHtml(t.roster_id)}${p.roster_id === t.roster_id ? ' <span class="muted">(owner)</span>' : ""}</td>
    <td class="muted">${esc(t.build ? t.build.name : c ? c.label : "")}</td><td class="num">${fmt(v)}</td><td class="num ${v > p.value * 1.02 ? "up" : v < p.value * 0.98 ? "down" : ""}">${pct(v / p.value - 1)}</td></tr>`).join("");
  const f = p.formula, c = p.call;
  const formulaHtml = f ? `<h3>Formula <span class="muted">#${f.rank} · score ${f.score}</span></h3>
    <div class="parts">${Object.entries(f.parts).map(([k, v]) => `<div><label>${esc(k)}</label><span class="pbar"><span style="width:${Math.max(2, v)}%"></span></span> ${Math.round(v)}</div>`).join("")}</div>
    ${c ? `<p>${typeof callBadge === "function" ? callBadge(c.signal) : `<b>${c.signal}</b>`} ${esc(c.why)}.</p>` : ""}` : "";
  const ownerTxt = p.roster_id ? teamHtml(p.roster_id) : "Free agent";
  $("#player-body").innerHTML = `
    <div class="player-hero">${face(p.id, "big")}<div>
    <h2>${esc(p.name)} <span class="pos pos-${p.pos}">${p.pos}${p.pos_rank ?? ""}</span></h2>
    <p class="muted">${esc(p.team || "FA")}${p.age ? ` · age ${p.age}` : ""}${p.exp != null ? ` · year ${p.exp + 1}` : ""}${p.injury ? ` · <span class="inj">${esc(p.injury)}</span>` : ""} · ${ownerTxt}</p>
    </div></div>
    <div class="stats">
      <div><label>Value</label><b>${fmt(p.value)}</b></div>
      <div><label>Overall</label><b>#${p.rank ?? "–"}</b></div>
      <div><label>Tier</label><b>${p.tier ?? "–"} / ${p.pos} ${p.pos_tier ?? "–"}</b></div>
      <div><label>PPG</label><b>${p.ppg ?? "–"}</b></div>
      <div><label>Rest of season</label><b>${p.ros_ppg ?? "–"}</b></div>
      <div><label>This week</label><b>${p.proj_week ?? "–"}</b></div>
    </div>
    <h3>How his value is built</h3>
    <table class="net"><tbody>
      <tr><td>Sites average</td><td class="num">${p.sites_avg ? fmt(p.sites_avg) : "–"}</td><td class="muted">plain average of each site's own number, for reference; not used in trades</td></tr>
      <tr><td>Market consensus</td><td class="num">${p.market ? fmt(p.market) : "–"}</td><td class="muted">average of the sites below${p.spread != null ? `, ${Math.round(p.spread * 100)}% spread between them` : ""}</td></tr>
      <tr><td>× scoring fit</td><td class="num">${p.premium ? p.premium.toFixed(2) : "–"}</td><td class="muted">this league's scoring vs generic</td></tr>
      <tr><td>= adjusted market</td><td class="num">${p.market_adj ? fmt(p.market_adj) : "–"}</td><td></td></tr>
      <tr><td>Points model</td><td class="num">${p.model ? fmt(p.model) : "–"}</td><td class="muted">points over replacement here, aged forward</td></tr>
      ${p.value_before_league_market ? `<tr><td>× this league's trade market</td><td class="num">${(p.value / p.value_before_league_market).toFixed(2)}</td><td class="muted">what this league's own trades pay for ${esc(p.pos)}s against the values</td></tr>` : ""}
      <tr><td><b>Final value</b></td><td class="num"><b>${fmt(p.value)}</b></td><td class="muted">60% adjusted market, 40% model${p.value_before_league_market ? ", then the league's market" : ""}</td></tr>
    </tbody></table>
    ${situationHtml(p)}
    ${srcRows ? `<table class="net"><thead><tr><th>Site</th><th class="num">Site's own number</th><th class="num">On our scale</th></tr></thead><tbody>${srcRows}</tbody></table>` : ""}
    <h3>Value trend</h3><div id="player-history"><p class="muted">Loading…</p></div>
    ${p.trend ? `<p class="muted">FantasyCalc 30-day move: <span class="${p.trend > 0 ? "up" : "down"}">${p.trend > 0 ? "+" : ""}${fmt(p.trend)}</span></p>` : ""}
    ${formulaHtml}
    <h3>What each team would pay <span class="muted">(his value through each team's own situation; best buyers first)</span></h3>
    <div class="table-wrap"><table class="buyers"><thead><tr><th>Team</th><th>Build</th><th class="num">Their price</th><th class="num">vs value</th></tr></thead><tbody>${buyRows}</tbody></table></div>
    <div class="toolbar" style="margin-top:12px">
      <button class="chip active" id="player-shop">${mine && p.roster_id === mine.roster_id ? "Shop him in the Trade Finder" : p.roster_id ? "Find a deal for him" : "Free agent"}</button>
    </div>`;
  modal.classList.remove("hidden");
  const shop = $("#player-shop");
  if (!p.roster_id) shop.disabled = true;
  shop.onclick = () => {
    if (!mine) return;
    finder.me = mine.roster_id; finder.goal = null;
    if (p.roster_id === mine.roster_id) { finder.send = [p.id]; finder.get = []; finder.partners = []; }
    else { finder.get = [p.id]; finder.send = []; finder.partners = [p.roster_id]; }
    finder.offer = []; finder.last = null;
    modal.classList.add("hidden");
    document.querySelector('.tabs button[data-tab="finder"]').click();
    renderFinder();
  };
  const hist = await loadHistory(state.data.history_id || state.data.league.id);
  const pts = Object.entries((hist && hist.days) || {}).sort(([a], [b]) => a.localeCompare(b)).filter(([, d]) => d[p.id] != null).map(([day, d]) => [day.slice(5), d[p.id]]);
  const el = $("#player-history");
  if (el) el.innerHTML = pts.length >= 2 ? sparkline(pts) : `<p class="muted">Not enough daily snapshots yet${pts.length ? ` (one on ${esc(pts[0][0])})` : ""}.</p>`;
}
// What the points model knows beyond the stat line (engine/role.py, engine/gamelog.py).
const ARCHETYPE = { QB_rush: "Rushing QB", QB_pocket: "Pocket QB", RB_rec: "Receiving back", RB_early: "Early-down back",
  WR_deep: "Deep threat", WR_short: "Short-area receiver" };
function situationHtml(p) {
  const s = p.situation || {}, g = p.games || {};
  const pc = (x) => `${Math.round(x * 100)}%`;
  const rows = [];
  if (p.vor != null) rows.push(["Points over replacement", `${p.vor > 0 ? "+" : ""}${p.vor} a game`, "against what you'd start in his place in this league (half the theoretical level, half the best free agents)"]);
  if (s.archetype) rows.push(["Player type", ARCHETYPE[s.archetype] || s.archetype, s.archetype === "QB_rush" ? "ages on the rushing-QB curve the backtest fitted (peak to 28, then about 9% a year)" : "same age curve as his position"]);
  if (s.tgt_share != null || s.car_share != null) rows.push(["Role", [s.tgt_share ? `${pc(s.tgt_share)} of targets` : "", s.car_share ? `${pc(s.car_share)} of carries` : "", s.snap ? `${pc(s.snap)} of snaps lately` : ""].filter(Boolean).join(", "),
    s.role_trend ? `share ${s.role_trend > 1 ? "up" : "down"} ${pc(Math.abs(s.role_trend - 1))} over the last four games; this season's line counts ×${s.role ?? 1} (role swings mostly fade, per the backtest)` : ""]);
  if (s.depth) rows.push(["Depth chart", s.depth, ""]);
  if (s.contract_years_left != null) rows.push(["Contract", s.contract_years_left ? `${s.contract_years_left} more year${s.contract_years_left > 1 ? "s" : ""}` : "ends after this season", ""]);
  if (s.availability) rows.push(["Availability", `×${s.availability} next year`, "games he's missed, marked down by how much missed time carries over (backtested)"]);
  if (s.new_coach) rows.push(["Coaching", "new head coach this season", "shown, not priced"]);
  if (s.later) rows.push(["Later years", `×${s.later}`, (s.notes || []).join("; ")]);
  if (g.games || g.games_last) rows.push(["Game log", `${g.games || 0} games this season${g.ppg != null ? `, ${g.ppg} a game` : ""}${g.games_last ? `; ${g.games_last} last season${g.ppg_last != null ? ` at ${g.ppg_last}` : ""}` : ""}`,
    g.floor != null ? `every game scored with this league's rules: floor ${g.floor}, ceiling ${g.ceiling}, last four ${g.recent}` : ""]);
  if (!rows.length) return "";
  return `<h3>Situation and history</h3><table class="net"><tbody>${rows.map(([a, b, c]) => `<tr><td>${esc(a)}</td><td class="num">${esc(String(b))}</td><td class="muted">${esc(c || "")}</td></tr>`).join("")}</tbody></table>`;
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-pid]");
  if (a && !e.target.closest("#player-modal")) openPlayer(a.dataset.pid);
});

// ---------- trade calculator ----------
// Each side lists what that team receives. An asset is sent by the team that
// owns it; in a two-team trade with no teams picked, by the other side.
const LETTERS = "ABCD";

// Value adjustment (mirrors engine/trade.py): trading is more than addition.
// depth: each piece counts at v·(v/T)^e, T the best piece in the trade, e = DEPTH_EXP·T/scale.
// stud: the side getting the best piece gains t·STUD_SHARE·(t/scale)²·(1 − t_other/t).
// roster: each extra player a team takes in costs min(v, R) of its smallest extras.
// Items are {value, kind}; picks take no roster spot.
function adjScale() {
  if (state.adjScale == null) {
    const all = [...state.assetMap.values()].map((a) => a.value || 0);
    const rostered = state.data.players.filter((p) => p.roster_id != null && p.value > 0).map((p) => p.value).sort((a, b) => b - a);
    state.adjScale = Math.max(...all, 1);
    state.rosterSpot = rostered.length ? rostered[Math.min(rostered.length - 1, Math.floor(rostered.length * ROSTER_SPOT_PCTL))] : 300;
  }
  return state.adjScale;
}
const asItems = (xs) => xs.map((x) => (typeof x === "number" ? { value: x, kind: "player" } : { value: x.value || 0, kind: x.kind || "player" })).filter((x) => x.value > 0);
function adjustTrade(getsIn, givesIn) {
  const scale = adjScale(), R = state.rosterSpot;
  const gets = asItems(getsIn), gives = asItems(givesIn);
  const top = Math.max(0, ...gets.map((x) => x.value), ...gives.map((x) => x.value));
  const e = (DEPTH_EXP * top) / scale;
  const part = (side) => {
    const raw = side.reduce((t, x) => t + x.value, 0);
    const depth = top ? side.reduce((t, x) => t + x.value * Math.pow(x.value / top, e), 0) - raw : 0;
    return { raw, depth, stud: 0, roster: 0 };
  };
  const g = part(gets), v = part(gives);
  const tg = Math.max(0, ...gets.map((x) => x.value)), tv = Math.max(0, ...gives.map((x) => x.value));
  if (tg > tv) g.stud = tg * STUD_SHARE * Math.pow(tg / scale, 2) * (1 - tv / tg);
  else if (tv > tg) v.stud = tv * STUD_SHARE * Math.pow(tv / scale, 2) * (1 - tg / tv);
  const pin = gets.filter((x) => x.kind === "player").map((x) => x.value).sort((a, b) => a - b);
  const pout = gives.filter((x) => x.kind === "player").map((x) => x.value).sort((a, b) => a - b);
  const extra = pin.length - pout.length;
  if (extra > 0) g.roster = -pin.slice(0, extra).reduce((t, x) => t + Math.min(x, R), 0);
  else if (extra < 0) v.roster = -pout.slice(0, -extra).reduce((t, x) => t + Math.min(x, R), 0);
  for (const x of [g, v]) x.total = Math.max(x.raw + x.depth + x.stud + x.roster, 0);
  return { g, v, pct: (g.total - v.total) / (Math.max(g.total, v.total) || 1) };
}
// The value of the one player to add to `gets` that makes this team even: the
// adjustment reverse engineered, so it moves as pieces are added to either side.
function evenOut(gets, gives) {
  if (adjustTrade(gets, gives).pct >= 0) return 0;
  const scale = adjScale();
  let lo = 0, hi = 3 * scale;
  const with_ = (x) => adjustTrade([...asItems(gets), { value: x, kind: "player" }], gives).pct;
  if (with_(hi) < 0) return hi;
  for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (with_(mid) < 0) lo = mid; else hi = mid; }
  return hi;
}
// Shorthand for the many places that only need the net: values × an optional factor.
const netOf = (gets, gives, f = () => 1) => adjustTrade(gets.map((a) => ({ value: a.value * f(a), kind: a.kind })), gives.map((a) => ({ value: a.value * f(a), kind: a.kind }))).pct;

const newSide = () => ({ team: null, assets: [] });
// A new trade starts with the logged-in user's team as Team A, when they have one here.
const freshTrade = () => ({ sides: [{ ...newSide(), team: myTeam()?.roster_id ?? null }, newSide()] });
const sides = () => state.trade.sides;
const sideName = (i) => (sides()[i].team ? teamName(sides()[i].team) : `Team ${LETTERS[i]}`);

// ---------- team-specific values ----------
// The engine (engine/team_value.py) gives every team a multiplier on each player's
// and pick's league value, from that team's own situation: tanking teams prize early
// picks, a superflex team short at QB pays more for one who'd start, contenders pay
// for players who'd start for them now. Values without a multiplier are 1.
function teamCtx(rid) {
  const tv = state.data.team_values;
  return tv && rid != null ? tv.context.teams[String(rid)] : null;
}
function teamFactor(rid, id) {
  const tv = state.data.team_values;
  const f = tv && rid != null ? tv.factors[String(rid)] : null;
  return (f && f[id]) || 1;
}
const SITUATION = {
  tanking: "tanking: early picks and young players count most, veterans least",
  rebuilding: "rebuilding: picks and young players count more, veterans less",
  contending: "contending: players who'd start now count more, picks less",
  middle: "in the middle: close to market value",
};
function situationText(rid) {
  const c = teamCtx(rid);
  if (!c) return "";
  const bits = [SITUATION[c.label]];
  if (c.qb && c.qb.superflex) bits.push(`${c.qb.startable} startable QB${c.qb.startable === 1 ? "" : "s"} for ${c.qb.slots} QB spots`);
  // In superflex the QB count above is what decides QB need, not the room's value.
  const thin = Object.entries(c.needs || {}).filter(([pos, v]) => v >= 0.5 && !(pos === "QB" && c.qb && c.qb.superflex)).map(([pos]) => pos);
  if (thin.length) bits.push(`thin at ${thin.join(", ")}`);
  return bits.join("; ");
}
// The team on a side: picked, or in a two-team deal the one owner of everything the
// other side receives.
function teamOfSide(i) {
  const s = sides();
  if (s[i].team != null) return s[i].team;
  if (s.length !== 2) return null;
  const owners = new Set(s[1 - i].assets.map(assetById).filter(Boolean).map((a) => a.roster_id).filter((r) => r != null));
  return owners.size === 1 ? [...owners][0] : null;
}

function senderOf(asset, i) {
  const s = sides();
  if (asset.roster_id != null) {
    const j = s.findIndex((x, k) => k !== i && x.team === asset.roster_id);
    if (j >= 0) return j;
  }
  return s.length === 2 ? 1 - i : -1;
}

function setupTrade() {
  if (!state.trade || !state.trade.sides) state.trade = freshTrade();
  renderTeamCount();
  renderSides();
}

function renderTeamCount() {
  const n = sides().length;
  $("#team-count").innerHTML = [2, 3, 4].map((k) => `<button class="chip ${k === n ? "active" : ""}" data-n="${k}">${k} teams</button>`).join("");
  $("#team-count").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      const k = Number(b.dataset.n);
      const s = sides().slice(0, k);
      // Drop anything that was coming from a team that's no longer in the deal.
      const gone = new Set(sides().slice(k).map((x) => x.team).filter((t) => t != null));
      s.forEach((x) => (x.assets = x.assets.filter((id) => !gone.has((assetById(id) || {}).roster_id))));
      while (s.length < k) s.push(newSide());
      state.trade.sides = s;
      renderTeamCount();
      renderSides();
    })
  );
}

function renderSides() {
  const s = sides();
  const multi = s.length > 2;
  const teamOpts = (sel) =>
    (multi ? `<option value="">Pick a team</option>` : `<option value="">Any team</option>`) +
    state.data.teams.map((t) => `<option value="${t.roster_id}" ${t.roster_id === sel ? "selected" : ""}>${esc(teamName(t.roster_id))}</option>`).join("");
  $("#trade-sides").innerHTML = s
    .map((side, i) => `<div class="trade-side" data-i="${i}">
        <h3>Team ${LETTERS[i]} gets</h3>
        <select class="team-pick" aria-label="Team ${LETTERS[i]}">${teamOpts(side.team)}</select>
        <input class="asset-search" type="search" placeholder="Add player or pick" list="assets-${i}" />
        <datalist id="assets-${i}"></datalist>
        <ul class="assets"></ul>
        <div class="side-total"></div>
      </div>`)
    .join("");
  document.querySelectorAll("#trade-sides .trade-side").forEach((el) => {
    const i = Number(el.dataset.i);
    el.querySelector(".team-pick").onchange = (e) => {
      sides()[i].team = e.target.value ? Number(e.target.value) : null;
      renderTrade();
    };
    const input = el.querySelector(".asset-search");
    input.onchange = () => {
      const a = [...state.assetMap.values()].find((x) => x.label === input.value || x.name === input.value);
      const taken = s.some((x) => x.assets.includes(a && a.id));
      if (a && !taken) sides()[i].assets.push(a.id);
      input.value = "";
      renderTrade();
    };
  });
  renderTrade();
}

function fillDatalists() {
  // A team can only receive what the other teams in the deal own.
  const s = sides();
  s.forEach((side, i) => {
    const givers = s.filter((x, k) => k !== i && x.team != null).map((x) => x.team);
    const list = [...state.assetMap.values()]
      .filter((x) => x.value > 0 && (givers.length === 0 || givers.includes(x.roster_id)) && (side.team == null || x.roster_id !== side.team))
      .sort((x, y) => y.value - x.value)
      .slice(0, 600);
    document.getElementById(`assets-${i}`).innerHTML = list
      .map((x) => `<option value="${esc(x.label)}">${fmt(x.value)}${s.length > 2 && x.roster_id ? " · " + esc(teamName(x.roster_id)) : ""}</option>`)
      .join("");
  });
}

function renderTrade() {
  const s = sides();
  const multi = s.length > 2;
  fillDatalists();
  const gets = s.map(() => []), gives = s.map(() => []);
  // The same trade valued by each team's own situation: what it receives, by its
  // multipliers, against what it sends, by its multipliers.
  const tm = s.map((_, i) => teamOfSide(i));
  const tGets = s.map(() => []), tGives = s.map(() => []);
  const unassigned = [];
  const base = leagueStrength();
  const baseRanks = base.ranks;
  s.forEach((side, i) => {
    side.assets.map(assetById).filter(Boolean).forEach((a) => {
      gets[i].push({ value: a.value, kind: a.kind });
      tGets[i].push({ value: a.value * teamFactor(tm[i], a.id), kind: a.kind });
      const from = senderOf(a, i);
      if (from >= 0) { gives[from].push({ value: a.value, kind: a.kind }); tGives[from].push({ value: a.value * teamFactor(tm[from], a.id), kind: a.kind }); }
      else unassigned.push(a);
    });
  });
  // Each team's adjusted value received and sent, market and by its own situation.
  const adj = s.map((_, i) => adjustTrade(gets[i], gives[i]));
  const tAdj = s.map((_, i) => adjustTrade(tGets[i], tGives[i]));
  s.forEach((side, i) => {
    const el = document.querySelector(`.trade-side[data-i="${i}"]`);
    const items = side.assets.map(assetById).filter(Boolean);
    el.querySelector(".assets").innerHTML = items
      .map((x) => {
        const from = senderOf(x, i);
        const tag = multi ? `<span class="muted from">${from >= 0 ? "from " + esc(sideName(from)) : "sender not in trade"}</span>` : "";
        const f = teamFactor(tm[i], x.id);
        const toThem = tm[i] != null && f !== 1
          ? `<span class="muted tv" title="What ${esc(teamName(tm[i]))} would pay, given its situation">${fmt(x.value * f)} to them</span>` : "";
        const sites = x.sites_avg ? `<span class="muted tv" title="Plain average of each site's own number">sites avg ${fmt(x.sites_avg)}</span>` : "";
        return `<li><span>${face(x.id)}${esc(x.label)}${tag}</span><span class="num">${fmt(x.value)}${sites}${toThem}</span><button data-id="${esc(x.id)}" aria-label="Remove">×</button></li>`;
      })
      .join("");
    el.querySelectorAll(".assets button").forEach((b) =>
      b.addEventListener("click", () => { side.assets = side.assets.filter((id) => id !== b.dataset.id); renderTrade(); })
    );
    const raw = gets[i].reduce((t, x) => t + x.value, 0);
    let needLine = "";
    if (side.team != null) {
      const nd = needsOf(side.team, baseRanks);
      needLine = `<div class="needs">Needs: ${nd.needs.map((p) => `<span class="pos pos-${p}">${p}</span>`).join(" ") || "none"}${nd.strengths.length ? ` · Strong at ${nd.strengths.join(", ")}` : ""}</div>`;
    }
    const sit = tm[i] != null ? `<div class="needs muted">${esc(situationText(tm[i]))}</div>` : "";
    const toThemTotal = items.length && tm[i] != null ? ` · To them <strong>${fmt(tAdj[i].g.total)}</strong>` : "";
    const sitesTotal = items.some((x) => x.sites_avg) ? ` · Sites avg ${fmt(items.reduce((t, x) => t + (x.sites_avg || 0), 0))}${items.some((x) => x.kind === "pick") ? " (players only)" : ""}` : "";
    el.querySelector(".side-total").innerHTML = (items.length ? `Total ${fmt(raw)}${sitesTotal} · Adjusted <strong>${fmt(adj[i].g.total)}</strong>${toThemTotal}` : "") + needLine + sit;
  });

  const out = $("#trade-result");
  if (!s.some((x) => x.assets.length)) {
    out.innerHTML = `<p class="muted">Add what each team receives${multi ? " (pick each team first, so the calculator knows who sends what)" : ""}. Values are this league's, and the adjusted total applies the value adjustment: a stud is worth more than a pile of lesser pieces that add up to the same raw total, and every extra player a team takes in costs it a roster spot. Once the teams are known, the trade is also judged by each team's own situation: a tanking team prizes early picks, a team short at QB pays more for one who'd start, a contender pays for players who start now.</p>`;
    return;
  }
  if (multi && s.some((x) => x.team == null)) {
    out.innerHTML = `<p class="error">Pick a team for every side in a ${s.length}-team trade.</p>`;
    return;
  }
  // Net for each team: adjusted value received minus adjusted value sent.
  const rows = s.map((_, i) => ({ i, g: adj[i].g.total, v: adj[i].v.total, pct: adj[i].pct }));
  const fair = rows.every((r) => Math.abs(r.pct) <= FAIR_MARGIN);
  const winner = rows.reduce((a, b) => (b.pct > a.pct ? b : a));
  const loser = rows.reduce((a, b) => (b.pct < a.pct ? b : a));
  let verdict;
  if (fair) verdict = "Fair trade at market value";
  else if (!multi) verdict = `${esc(sideName(winner.i))} wins by ${Math.round(winner.pct * 100)}% at market value`;
  else verdict = `${esc(sideName(winner.i))} wins most (+${Math.round(winner.pct * 100)}%), ${esc(sideName(loser.i))} loses most (${Math.round(loser.pct * 100)}%)`;

  let detail;
  if (multi) {
    detail = `<table class="net"><thead><tr><th>Team</th><th class="num">Gets</th><th class="num">Gives</th><th class="num">Net</th></tr></thead><tbody>${rows
      .map((r) => `<tr><td>${esc(sideName(r.i))}</td><td class="num">${fmt(r.g)}</td><td class="num">${fmt(r.v)}</td>
        <td class="num ${Math.abs(r.pct) <= FAIR_MARGIN ? "" : r.pct > 0 ? "up" : "down"}">${r.pct > 0 ? "+" : ""}${Math.round(r.pct * 100)}%</td></tr>`)
      .join("")}</tbody></table>`;
  } else {
    const ea = rows[0].g, eb = rows[1].g;
    detail = `<div class="bar"><div style="width:${ea + eb ? (ea / (ea + eb)) * 100 : 50}%"></div></div>`;
  }
  // Second opinion: each team judged by its own situation. A deal can be fair at
  // market and still a win for both sides, when each gets what it needs more.
  if (tm.every((t) => t != null)) {
    const tr = s.map((_, i) => ({ i, g: tAdj[i].g.total, v: tAdj[i].v.total, pct: tAdj[i].pct }));
    const ahead = tr.filter((r) => r.pct > FAIR_MARGIN), behind = tr.filter((r) => r.pct < -FAIR_MARGIN);
    const marketNote = fair ? "" : "At market value this isn't even, and team situations don't change that. ";
    const summary = marketNote + (!behind.length && ahead.length
      ? `Every team gets at least what it gives by its own needs${ahead.length === tr.length ? ", and all of them come out ahead" : ""}.`
      : !behind.length ? "Even for every team by its own needs."
      : `By its own needs, ${behind.map((r) => esc(sideName(r.i))).join(" and ")} ${behind.length > 1 ? "give" : "gives"} up more than ${behind.length > 1 ? "they get" : "it gets"}.`);
    detail += `<h4>By each team's own situation</h4><p class="muted">${summary}</p>
      <table class="net"><thead><tr><th>Team</th><th>Situation</th><th class="num">Gets</th><th class="num">Gives</th><th class="num">Net</th></tr></thead><tbody>${tr
      .map((r) => `<tr><td>${esc(sideName(r.i))}</td><td class="muted">${esc(situationText(tm[r.i]))}</td><td class="num">${fmt(r.g)}</td><td class="num">${fmt(r.v)}</td>
        <td class="num ${Math.abs(r.pct) <= FAIR_MARGIN ? "" : r.pct > 0 ? "up" : "down"}">${r.pct > 0 ? "+" : ""}${Math.round(r.pct * 100)}%</td></tr>`)
      .join("")}</tbody></table>`;
  }
  if (unassigned.length) {
    detail += `<p class="error">Not counted as sent by anyone: ${unassigned.map((a) => esc(a.label)).join(", ")}. Their owner isn't one of the teams in this trade.</p>`;
  }

  let suggest = "";
  if (!fair) {
    // Close the biggest gap: the biggest loser gets more from the biggest winner.
    const need = evenOut(gets[loser.i], gives[loser.i]);
    const giver = s[winner.i].team;
    const taken = new Set(s.flatMap((x) => x.assets));
    const cands = [...state.assetMap.values()]
      .filter((x) => !taken.has(x.id) && x.value > 0 && (giver == null || x.roster_id === giver))
      .sort((x, y) => Math.abs(x.value - need) - Math.abs(y.value - need))
      .slice(0, 6)
      .sort((x, y) => y.value - x.value);
    suggest = `<p>To even it out, ${esc(sideName(loser.i))} should also get about <strong>${fmt(need)}</strong> in value${multi ? ` from ${esc(sideName(winner.i))}` : ""}. Closest fits:</p>
      <ul class="suggest">${cands.map((x) => `<li><button data-i="${loser.i}" data-id="${esc(x.id)}">+ ${esc(x.label)} <span class="muted">${fmt(x.value)}</span></button></li>`).join("")}</ul>`;
  }
  const overrides = tradeOverrides(s);
  const after = leagueStrength(overrides);
  const recBefore = projectRecords(), recAfter = projectRecords(overrides);
  const ctx = { s, rows, gets, before: base, after, recBefore, recAfter };
  out.innerHTML = `<div class="verdict ${fair ? "fair" : "uneven"}">${verdict}</div>${adjustmentHtml(s, adj, gets, gives, loser.i)}${detail}${suggest}`
    + `<p><button id="to-lab" class="chip active">See the lineups after this trade</button></p>`
    + tradeImpact(s, overrides, ctx.before, after, recBefore, recAfter) + renderPitches(ctx);
  $("#to-lab").onclick = () => {
    const mine = myTeam(), inDeal = s.map((_, i) => teamOfSide(i)).filter((x) => x != null);
    lab.team = mine && inDeal.includes(mine.roster_id) ? mine.roster_id : inDeal[0] ?? lab.team;
    lab.trade = true; lab.adds = []; lab.drops = [];
    document.querySelector('.tabs button[data-tab="lineups"]').click();
  };
  out.querySelectorAll(".suggest button").forEach((b) =>
    b.addEventListener("click", () => { s[Number(b.dataset.i)].assets.push(b.dataset.id); renderTrade(); })
  );
  out.querySelectorAll(".pitch button.copy").forEach((b) =>
    b.addEventListener("click", async () => {
      const ta = b.closest(".pitch").querySelector("textarea");
      try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand("copy"); }
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = "Copy"), 1500);
    })
  );
}

// ---------- offer grader ----------
// Reads the text of Sleeper's Trade Summary (each manager's RECEIVES / SENDS list,
// every piece followed by "From X" or "To X"), loads the deal into the calculator,
// and grades it for each team: market value, its own needs and weekly points.
const normName = (s) => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");
const ROUND_WORD = { "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5, "6th": 6, "7th": 7 };

function parseOffer(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const moves = [];   // { item: [lines], to, from }
  let owner = null, buf = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^trade summary$/i.test(l)) continue;
    if (lines[i + 1] && /^receives$/i.test(lines[i + 1])) { owner = l; buf = []; i++; continue; }
    if (/^(receives|sends)$/i.test(l)) { buf = []; continue; }
    const m = l.match(/^(from|to)\s+(.+)$/i);
    if (m && buf.length && owner) {
      const other = m[2];
      moves.push(m[1].toLowerCase() === "from" ? { item: buf, to: owner, from: other } : { item: buf, to: other, from: owner });
      buf = [];
      continue;
    }
    buf.push(l);
  }
  // Each piece shows up twice (once per manager); keep one.
  const seen = new Set();
  return moves.filter((x) => { const k = `${x.item.join("|")}>${x.to}`.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function teamByOwner(name) {
  const n = normName(name);
  return state.data.teams.find((t) => normName(t.owner) === n) || state.data.teams.find((t) => normName(t.name) === n) || null;
}

function resolveOfferItem(item, fromRid) {
  if (item.some((l) => /^draft pick$/i.test(l))) {
    const year = Number((item.find((l) => /^\d{4}$/.test(l)) || (item.join(" ").match(/\b(20\d\d)\b/) || [])[1]));
    const rw = (item.join(" ").match(/\b(1st|2nd|3rd|4th|5th|6th|7th)\b/i) || [])[1];
    const round = rw ? ROUND_WORD[rw.toLowerCase()] : null;
    const cands = state.data.picks.filter((p) => p.year === year && p.round === round && p.roster_id === fromRid);
    // Sleeper's summary doesn't say whose pick it is when a team owns two; take its own first.
    const pick = cands.find((p) => p.original_roster_id === fromRid) || cands[0];
    return pick ? { id: pick.id, guess: cands.length > 1 } : null;
  }
  const name = normName(item[0]);
  const pos = ((item[1] || "").split(/[•·]/)[0] || "").trim().toUpperCase();
  const hits = state.data.players.filter((p) => normName(p.name) === name);
  const p = hits.find((x) => x.roster_id === fromRid) || hits.find((x) => !pos || x.pos === pos) || hits[0];
  return p ? { id: p.id } : null;
}

function offerGrade(pct) {
  return pct >= 0.1 ? "A+" : pct >= 0.05 ? "A" : pct >= 0 ? "B+" : pct >= -FAIR_MARGIN ? "B" : pct >= -0.1 ? "C" : pct >= -0.2 ? "D" : "F";
}

function gradeOffer() {
  const out = $("#offer-out");
  const moves = parseOffer($("#offer-text").value);
  if (!moves.length) { out.innerHTML = `<p class="error">I couldn't find any pieces. Paste the whole Trade Summary, from the first manager's name through the last "From" or "To" line.</p>`; return; }
  const missing = [], guessed = [], byTeam = new Map();
  for (const mv of moves) {
    const to = teamByOwner(mv.to), from = teamByOwner(mv.from);
    if (!to || !from) { missing.push(`${mv.item[0]} (${!to ? mv.to : mv.from} isn't in this league)`); continue; }
    const r = resolveOfferItem(mv.item, from.roster_id);
    if (!r) { missing.push(`${mv.item.slice(0, 3).join(" ")} from ${mv.from}`); continue; }
    if (r.guess) guessed.push(assetById(r.id)?.label || r.id);
    if (!byTeam.has(to.roster_id)) byTeam.set(to.roster_id, []);
    byTeam.get(to.roster_id).push(r.id);
    if (!byTeam.has(from.roster_id)) byTeam.set(from.roster_id, []);
  }
  if (byTeam.size < 2) { out.innerHTML = `<p class="error">That doesn't look like a trade in ${esc(state.data.league.name)}. Switch to the league the offer is in and try again.</p>`; return; }
  if (byTeam.size > 4) { out.innerHTML = `<p class="error">The calculator handles up to 4 teams.</p>`; return; }
  const mine = myTeam();
  const order = [...byTeam.keys()].sort((a, b) => (mine && b === mine.roster_id) - (mine && a === mine.roster_id));
  state.trade = { sides: order.map((rid) => ({ team: rid, assets: byTeam.get(rid) })) };
  setupTrade();
  renderTrade();
  const s = sides();
  const overrides = tradeOverrides(s);
  const rows = s.map((side, i) => {
    const gets = side.assets.map(assetById).filter(Boolean);
    const gives = s.flatMap((x, j) => (j === i ? [] : x.assets.map(assetById).filter((a) => a && senderOf(a, j) === i)));
    const mkt = netOf(gets, gives), lens = netOf(gets, gives, (a) => teamFactor(side.team, a.id));
    const p0 = teamPPG(rosterOf(side.team)), p1 = teamPPG(overrides[side.team] || rosterOf(side.team));
    return { i, rid: side.team, mkt, lens, p0, p1 };
  });
  const pct = (x) => `${x > 0 ? "+" : ""}${Math.round(x * 100)}%`;
  const me = rows.find((r) => mine && r.rid === mine.roster_id);
  const best = rows.reduce((a, b) => (b.mkt > a.mkt ? b : a));
  let call = "";
  if (me) {
    if (me.mkt >= 0.05) call = `You win this one by ${Math.round(me.mkt * 100)}% at market. Accept it if the lineup change works for you.`;
    else if (me.mkt >= -FAIR_MARGIN) call = me.lens >= 0 ? "It's fair, and by your own needs you come out even or ahead. Fine to accept." : "It's fair at market, but by your own needs you give up a little. Accept only if you like the fit.";
    else call = `You're short by ${Math.round(-me.mkt * 100)}% at market. Counter by asking ${esc(teamName(best.rid))} for one more piece: the closest fits are listed under the verdict below.`;
  }
  out.innerHTML = `${call ? `<p class="offer-call ${me && me.mkt >= -FAIR_MARGIN ? "up" : "down"}">Your grade: ${offerGrade(me.mkt)}. ${call}</p>` : ""}
    <table class="net"><thead><tr><th>Team</th><th>Grade</th><th class="num">Market</th><th class="num">Own needs</th><th class="num">Points a week</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${teamHtml(r.rid)}</td><td><b>${offerGrade(r.mkt)}</b></td>
      <td class="num ${r.mkt > FAIR_MARGIN ? "up" : r.mkt < -FAIR_MARGIN ? "down" : ""}">${pct(r.mkt)}</td><td class="num">${pct(r.lens)}</td><td class="num">${r.p0.toFixed(1)} → ${r.p1.toFixed(1)}</td></tr>`).join("")}</tbody></table>
    ${guessed.length ? `<p class="muted">The summary doesn't say whose pick it is, and the sender owns more than one in that round, so I used: ${guessed.map(esc).join(", ")}. Swap it in the calculator below if that's wrong.</p>` : ""}
    ${missing.length ? `<p class="error">Couldn't match: ${missing.map(esc).join("; ")}.</p>` : ""}
    <p class="muted">Grades are by market value with the value adjustment: A+ wins by 10% or more, A by 5%, B+ and B are fair, C is short by up to 10%, D up to 20%, F more. The full breakdown is below.</p>`;
}
document.addEventListener("click", (e) => { if (e.target && e.target.id === "offer-grade") gradeOffer(); });

// The value adjustment, KTC style: how far the adjusted totals move from the raw
// ones, and the one player the short side needs added to even it (reverse
// engineered, so it changes as pieces go on either side).
function adjustmentHtml(s, adj, gets, gives, li) {
  const sign = (x) => `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x))}`;
  const parts = (a, who) => {
    const bits = [];
    if (a.stud > 0.5) bits.push(`stud ${sign(a.stud)}`);
    if (Math.abs(a.depth) > 0.5) bits.push(`depth ${sign(a.depth)}`);
    if (Math.abs(a.roster) > 0.5) bits.push(`roster spots ${sign(a.roster)}`);
    return bits.length ? `${esc(who)} gets ${fmt(a.raw)} raw, ${fmt(a.total)} adjusted (${bits.join(", ")})` : "";
  };
  const lines = s.map((_, i) => parts(adj[i].g, sideName(i))).filter(Boolean);
  let head = "";
  const L = adj[li];
  if (L.pct < -FAIR_MARGIN / 5) {
    const add = evenOut(gets[li], gives[li]);
    const rawGap = L.v.raw - L.g.raw;
    const credit = add - rawGap;
    const winner = s.length === 2 ? 1 - li : adj.reduce((b, a, i) => (a.pct > adj[b].pct ? i : b), 0);
    const to = credit >= 0 ? sideName(winner) : sideName(li);
    head = `<p><strong>Value adjustment: ${fmt(Math.abs(credit))} to ${esc(to)}.</strong> To even it, ${esc(sideName(li))} needs one more player worth about <strong>${fmt(add)}</strong>${rawGap > 0 ? `, not just the ${fmt(rawGap)} raw gap` : ""}.</p>`;
  }
  return lines.length ? `<div class="card adjust">${head}<p class="muted">${lines.join(". ")}.</p>
    <p class="muted">The best piece in the deal sets the scale: smaller pieces count for less next to it, more so the bigger the stud. The team getting the best piece gets a stud premium. Every extra player a team takes in costs it a roster spot (a player worth about ${fmt(state.rosterSpot)} gets cut). Picks take no roster spot.</p></div>` : "";
}

// ---------- roster strength: starters, position rooms, needs ----------
// Mirrors engine/league.py SLOT_ELIGIBILITY.
const SLOT_ELIGIBILITY = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"], DL: ["DL"], LB: ["LB"], DB: ["DB"],
  FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"], IDP_FLEX: ["DL", "LB", "DB"],
};
const DEPTH_WEIGHT = 0.25; // bench players count a little toward a room (injury/bye cover)
const DEPTH_COUNT = 2;

function bestLineup(players, key = "value") {
  const slots = [...state.data.league.format.starting_slots].sort((a, b) => SLOT_ELIGIBILITY[a].length - SLOT_ELIGIBILITY[b].length);
  const pool = players.filter((p) => p[key] > 0).sort((a, b) => b[key] - a[key]);
  const used = new Set(), lineup = [];
  for (const slot of slots) {
    const p = pool.find((x) => !used.has(x.id) && SLOT_ELIGIBILITY[slot].includes(x.pos));
    if (p) { used.add(p.id); lineup.push({ slot, p }); }
  }
  return lineup;
}

function roomPositions() {
  const groups = new Set();
  state.data.league.format.starting_slots.forEach((s) => SLOT_ELIGIBILITY[s].forEach((g) => groups.add(g)));
  return POSITIONS.filter((p) => groups.has(p));
}

// Strength of one roster: starter value plus, per position, its starters' value
// and a little credit for depth.
function rosterStrength(players) {
  const lineup = bestLineup(players);
  const starters = new Set(lineup.map((x) => x.p.id));
  const rooms = {};
  for (const pos of roomPositions()) {
    const atPos = players.filter((p) => p.pos === pos).sort((a, b) => b.value - a.value);
    const start = atPos.filter((p) => starters.has(p.id));
    const bench = atPos.filter((p) => !starters.has(p.id)).slice(0, DEPTH_COUNT);
    rooms[pos] = start.reduce((t, p) => t + p.value, 0) + DEPTH_WEIGHT * bench.reduce((t, p) => t + p.value, 0);
  }
  return { starters: lineup.reduce((t, x) => t + x.p.value, 0), rooms };
}

function rosterOf(rid) {
  return state.data.players.filter((p) => p.roster_id === rid);
}

// Rank every team by starters and by each room; `overrides` swaps in post-trade rosters.
function leagueStrength(overrides = {}) {
  const by = {};
  for (const t of state.data.teams) by[t.roster_id] = rosterStrength(overrides[t.roster_id] || rosterOf(t.roster_id));
  const rank = (key) => {
    const order = Object.keys(by).sort((a, b) => key(by[b]) - key(by[a]));
    const r = {};
    order.forEach((rid, i) => (r[rid] = i + 1));
    return r;
  };
  const ranks = { starters: rank((x) => x.starters) };
  for (const pos of roomPositions()) ranks[pos] = rank((x) => x.rooms[pos] || 0);
  return { by, ranks };
}

function needsOf(rid, ranks) {
  const n = state.data.teams.length;
  const needs = [], strengths = [];
  for (const pos of roomPositions()) {
    const r = ranks[pos][rid];
    if (r > (2 * n) / 3) needs.push(pos);
    else if (r <= n / 3) strengths.push(pos);
  }
  return { needs, strengths };
}

function rankCell(r, n) {
  const cls = r <= n / 3 ? "up" : r > (2 * n) / 3 ? "down" : "";
  return `<td class="num ${cls}">${r}</td>`;
}

function renderRooms() {
  const { ranks } = leagueStrength();
  const n = state.data.teams.length;
  const pos = roomPositions();
  const rows = [...state.data.teams]
    .sort((a, b) => ranks.starters[a.roster_id] - ranks.starters[b.roster_id])
    .map((t) => {
      const { needs } = needsOf(t.roster_id, ranks);
      return `<tr><td class="name">${teamHtml(t.roster_id)}</td>${rankCell(ranks.starters[t.roster_id], n)}${pos.map((p) => rankCell(ranks[p][t.roster_id], n)).join("")}
        <td>${needs.map((p) => `<span class="pos pos-${p}">${p}</span>`).join(" ") || '<span class="muted">none</span>'}</td></tr>`;
    })
    .join("");
  $("#rooms").innerHTML = `<thead><tr><th>Team</th><th class="num">Starters</th>${pos.map((p) => `<th class="num">${p}</th>`).join("")}<th>Needs</th></tr></thead><tbody>${rows}</tbody>`;
}

// ---------- projected records (mirrors engine/record.py) ----------
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const winProb = (a, b, sigma) => 0.5 * (1 + erf((a - b) / (sigma * 2)));
const teamPPG = (players) => bestLineup(players, "ros_ppg").reduce((t, x) => t + x.p.ros_ppg, 0);

function vsField(rid, ppg, sigma) {
  const others = Object.keys(ppg).filter((k) => k != rid).map((k) => ppg[k]);
  return others.length ? others.reduce((t, v) => t + winProb(ppg[rid], v, sigma), 0) / others.length : 0.5;
}
function vsMedian(rid, ppg, sigma) {
  const o = Object.keys(ppg).filter((k) => k != rid).map((k) => ppg[k]).sort((a, b) => a - b);
  if (!o.length) return 0.5;
  const h = Math.floor(o.length / 2);
  const mid = o.length % 2 ? o[h] : (o[h - 1] + o[h]) / 2;
  return 0.5 * (1 + erf((ppg[rid] - mid) / (sigma * Math.SQRT2)));
}

// Projected record for every team; `overrides` swaps in post-trade rosters.
// The weekly spread stays at the league's pre-trade value so a trade moves only the means.
function projectRecords(overrides = {}) {
  const sch = state.data.schedule || { weeks: {}, median_game: false, sigma: 0 };
  const ppg = {};
  for (const t of state.data.teams) ppg[t.roster_id] = teamPPG(overrides[t.roster_id] || rosterOf(t.roster_id));
  const vals = Object.values(ppg).filter((v) => v > 0);
  const sigma = sch.sigma || (sch.sigma_share || 0.21) * (vals.reduce((a, b) => a + b, 0) / (vals.length || 1)) || 1;
  const out = {};
  for (const t of state.data.teams) {
    const rid = t.roster_id;
    let w = 0, g = 0;
    for (const pairs of Object.values(sch.weeks)) {
      const m = pairs.find((p) => p.includes(rid));
      const opp = m ? (m[0] === rid ? m[1] : m[0]) : null;
      w += opp != null && ppg[opp] != null ? winProb(ppg[rid], ppg[opp], sigma) : vsField(rid, ppg, sigma);
      g += 1;
      if (sch.median_game) { w += vsMedian(rid, ppg, sigma); g += 1; }
    }
    // Max PF to date plus the best lineup's projected points for each week left.
    const maxPF = (t.record.max_pf || 0) + ppg[rid] * Object.keys(sch.weeks).length;
    const pf = (t.record.fpts || 0) + ppg[rid] * Object.keys(sch.weeks).length;
    out[rid] = { ppg: ppg[rid], wins: t.record.wins + w, losses: t.record.losses + g - w, ties: t.record.ties || 0, games: g, maxPF, pf };
  }
  seedOrder(out).forEach((rid, i) => (out[rid].rank = i + 1));
  Object.keys(out).sort((a, b) => out[b].maxPF - out[a].maxPF).forEach((rid, i) => (out[rid].maxPFRank = i + 1));
  return out;
}
// Playoff seeding the league's way (engine/record.py seed): each division's best
// record wins it and takes a top seed, wildcards follow; ties go to most points for.
function seedOrder(stats) {
  const lg = state.data.league;
  const div = new Map(state.data.teams.map((t) => [String(t.roster_id), t.division]));
  const winsOf = (r) => (stats[r].wins || 0) + 0.5 * (stats[r].ties || 0);
  const ranked = Object.keys(stats).sort((a, b) => winsOf(b) - winsOf(a) || (stats[b].pf || 0) - (stats[a].pf || 0));
  const divs = new Set(ranked.map((r) => div.get(String(r))));
  const playoff = lg.playoff_teams || ranked.length;
  if (divs.has(null) || divs.has(undefined) || divs.size < 2 || divs.size > playoff) return ranked;
  const champs = [...divs].map((d) => ranked.find((r) => div.get(String(r)) === d));
  champs.sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b));
  return [...champs, ...ranked.filter((r) => !champs.includes(r))];
}
const recordText = (r) => `${Math.round(r.wins)}-${Math.round(r.losses)}${r.ties ? "-" + r.ties : ""}`;
const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");

// Rosters for the teams in a trade, after it goes through.
function tradeOverrides(s) {
  const overrides = {};
  s.forEach((side) => { if (side.team != null) overrides[side.team] = rosterOf(side.team).slice(); });
  s.forEach((side, i) => {
    side.assets.map(assetById).filter((a) => a && a.kind === "player").forEach((a) => {
      const from = senderOf(a, i);
      const fromTeam = from >= 0 ? s[from].team : null;
      if (fromTeam != null && overrides[fromTeam]) overrides[fromTeam] = overrides[fromTeam].filter((p) => p.id !== a.id);
      if (side.team != null) overrides[side.team].push(a);
    });
  });
  return overrides;
}

// ---------- lineup lab ----------
// Any team's best lineup now and after the trade built in the calculator, plus what-ifs:
// add anyone, drop anyone, and tap two players to swap them by hand.
const lab = { team: null, key: "ros_ppg", trade: true, adds: [], drops: [], manual: null, sig: "", pick: null };
const SLOT_SHORT = { SUPER_FLEX: "SF", WRRB_FLEX: "W/R", REC_FLEX: "W/T", IDP_FLEX: "IDP" };
const LAB_KEYS = { ros_ppg: "Rest of season", proj_week: "This week" };

function resetLab() {
  Object.assign(lab, { team: myTeam()?.roster_id ?? state.data.teams[0]?.roster_id ?? null, adds: [], drops: [], manual: null, sig: "", pick: null });
}

// Players and picks each team gains and loses in the calculator's trade.
function labTradeMoves() {
  const s = sides(), moves = {};
  const at = (rid) => (moves[rid] = moves[rid] || { in: [], out: [] });
  s.forEach((side, i) => {
    const to = teamOfSide(i);
    side.assets.map(assetById).filter(Boolean).forEach((a) => {
      const j = senderOf(a, i);
      const from = j >= 0 ? teamOfSide(j) : a.roster_id ?? null;
      if (to != null) at(to).in.push(a);
      if (from != null) at(from).out.push(a);
    });
  });
  return moves;
}

function labRoster(rid, moves, edits) {
  const m = moves[rid] || { in: [], out: [] };
  const outIds = new Set(m.out.map((a) => a.id));
  let ps = rosterOf(rid).filter((p) => !outIds.has(p.id));
  m.in.filter((a) => a.kind === "player").forEach((a) => { if (!ps.some((p) => p.id === a.id)) ps.push(a); });
  if (edits) {
    ps = ps.filter((p) => !lab.drops.includes(p.id));
    lab.adds.map(assetById).filter((a) => a && a.kind === "player" && !ps.some((p) => p.id === a.id)).forEach((a) => ps.push(a));
  }
  return ps;
}

const labPts = (p) => Number(p[lab.key]) || 0;
const lineupPts = (lu) => lu.reduce((t, x) => t + labPts(x.p), 0);
const slotOrder = () => state.data.league.format.starting_slots;

// bestLineup fills the pickiest slots first; show it in Sleeper's slot order.
function inSlotOrder(lu) {
  const left = lu.slice();
  return slotOrder().map((slot) => {
    const k = left.findIndex((x) => x.slot === slot);
    return k >= 0 ? left.splice(k, 1)[0] : { slot, p: null };
  });
}
const labBest = (ps) => inSlotOrder(bestLineup(ps.map((p) => ({ ...p, _k: labPts(p) })), "_k").map(({ slot, p }) => ({ slot, p: ps.find((x) => x.id === p.id) })));

function renderLab() {
  const el = $("#lab");
  if (!el || !state.data) return;
  if (lab.team == null || !teamOf(lab.team)) resetLab();
  const rid = lab.team;
  const moves = lab.trade ? labTradeMoves() : {};
  const before = rosterOf(rid), after = labRoster(rid, moves, true);
  const sig = after.map((p) => p.id).sort().join(",") + lab.key;
  if (sig !== lab.sig) { lab.manual = null; lab.pick = null; lab.sig = sig; }
  const luB = labBest(before);
  const luA = lab.manual ? lab.manual.map(({ slot, id }) => ({ slot, p: after.find((p) => p.id === id) || null })) : labBest(after);
  const ptsB = lineupPts(luB.filter((x) => x.p)), ptsA = lineupPts(luA.filter((x) => x.p));
  // League rank before and after: every team in the trade moves, this team also gets the edits.
  const rankOf = (after) => {
    const tot = state.data.teams.map((t) => ({ rid: t.roster_id, v: t.roster_id === rid ? (after ? ptsA : ptsB)
      : lineupPts(labBest(after ? labRoster(t.roster_id, moves, false) : rosterOf(t.roster_id)).filter((x) => x.p)) }));
    tot.sort((a, b) => b.v - a.v);
    return tot.findIndex((x) => x.rid === rid) + 1;
  };
  const rB = rankOf(false), rA = rankOf(true), diff = ptsA - ptsB;
  const beforeIds = new Set(before.map((p) => p.id)), afterIds = new Set(after.map((p) => p.id));
  const t = teamOf(rid);
  const tagOf = (p, col) => (col === "b" && !afterIds.has(p.id) ? `<span class="tag out">OUT</span>` : col === "a" && !beforeIds.has(p.id) ? `<span class="tag new">NEW</span>` : "");
  const status = (p) => (t.taxi || []).includes(p.id) ? ' <span class="tag dim">TAXI</span>' : (t.reserve || []).includes(p.id) ? ' <span class="tag dim">IR</span>' : "";
  const row = (x, col) => {
    const p = x.p, slot = SLOT_SHORT[x.slot] || x.slot;
    if (!p) return `<div class="lab-row empty"><span class="slot slot-${esc(x.slot)}">${esc(slot)}</span><span class="who muted">Empty</span><span class="pts">0.0</span></div>`;
    const cls = [col === "a" && !beforeIds.has(p.id) ? "new" : "", col === "b" && !afterIds.has(p.id) ? "out" : "", col === "a" && lab.pick === p.id ? "picked" : ""].join(" ");
    return `<div class="lab-row ${cls}" ${col === "a" ? `data-swap="${esc(p.id)}"` : ""}><span class="slot slot-${esc(x.slot)}">${esc(slot)}</span>${face(p.id)}
      <span class="who"><b>${esc(p.name)}</b> <span class="muted">${p.pos}${p.team ? " · " + esc(p.team) : ""}</span> ${tagOf(p, col)}${p.injury ? ` <span class="inj">${esc(p.injury)}</span>` : ""}</span>
      <span class="pts">${labPts(p).toFixed(1)}</span></div>`;
  };
  const startersA = new Set(luA.filter((x) => x.p).map((x) => x.p.id));
  const bench = after.filter((p) => !startersA.has(p.id)).sort((a, b) => labPts(b) - labPts(a));
  const benchRow = (p) => `<div class="lab-row bench ${!beforeIds.has(p.id) ? "new" : ""} ${lab.pick === p.id ? "picked" : ""}" data-swap="${esc(p.id)}"><span class="slot slot-BN">BN</span>${face(p.id)}
      <span class="who"><b>${esc(p.name)}</b> <span class="muted">${p.pos}${p.team ? " · " + esc(p.team) : ""}</span> ${tagOf(p, "a")}${status(p)}</span>
      <span class="pts">${labPts(p).toFixed(1)}</span><button class="drop" data-drop="${esc(p.id)}" aria-label="Drop ${esc(p.name)}" title="Drop">×</button></div>`;
  const m = moves[rid] || { in: [], out: [] };
  const pickLine = (xs) => xs.filter((a) => a.kind === "pick").map((a) => esc(a.label)).join(", ");
  const pin = pickLine(m.in), pout = pickLine(m.out);
  const tradeTxt = m.in.length || m.out.length
    ? `Players in: ${m.in.filter((a) => a.kind === "player").map((a) => esc(a.name)).join(", ") || "none"}. Players out: ${m.out.filter((a) => a.kind === "player").map((a) => esc(a.name)).join(", ") || "none"}.`
    : sides().some((x) => x.assets.length) ? `${esc(t.name)} isn't in the calculator's trade.` : "The calculator is empty. Build a trade there and it shows up here.";
  const roster = after.length, limit = state.data.league.format.roster_size || null;
  const edits = lab.adds.length || lab.drops.length || lab.manual;
  el.innerHTML = `
    <div class="toolbar">
      <select id="lab-team" aria-label="Team">${state.data.teams.map((x) => `<option value="${x.roster_id}" ${x.roster_id === rid ? "selected" : ""}>${esc(teamName(x.roster_id))}</option>`).join("")}</select>
      <div class="chips">${Object.entries(LAB_KEYS).map(([k, v]) => `<button class="chip ${lab.key === k ? "active" : ""}" data-key="${k}">${v}</button>`).join("")}</div>
      <label class="chip ${lab.trade ? "active" : ""}"><input type="checkbox" id="lab-trade" ${lab.trade ? "checked" : ""} hidden>Apply the calculator's trade</label>
      <input id="lab-add" type="search" list="lab-add-list" placeholder="Add a player (what if)" /><datalist id="lab-add-list"></datalist>
      ${edits ? `<button id="lab-reset" class="chip">Reset edits</button>` : ""}
    </div>
    <p class="muted lab-trade">${lab.trade ? tradeTxt : "Showing the roster without the calculator's trade."}${pin ? ` Picks in: ${pin}.` : ""}${pout ? ` Picks out: ${pout}.` : ""}
      <button id="lab-edit" class="link">Edit the trade</button></p>
    <div class="lab-head">
      <div><p class="kicker">${esc(t.name)}${managerOf(t) ? " · " + esc(managerOf(t)) : ""}</p><h2>Lineup, before and after</h2></div>
      <div class="lab-score"><b class="${diff > 0.05 ? "up" : diff < -0.05 ? "down" : ""}">${ptsB.toFixed(1)} → ${ptsA.toFixed(1)}</b>
        <span>${diff >= 0 ? "+" : ""}${diff.toFixed(1)} a week · ${ordinal(rB)} → ${ordinal(rA)} in the league</span></div>
    </div>
    <div class="lab-cols">
      <div class="lab-col"><div class="lab-colhead"><span>BEFORE</span><b>${ptsB.toFixed(1)}</b></div>${luB.map((x) => row(x, "b")).join("")}</div>
      <div class="lab-col after"><div class="lab-colhead"><span>AFTER</span><b>${ptsA.toFixed(1)}</b></div>${luA.map((x) => row(x, "a")).join("")}
        <div class="lab-colhead bench"><span>BENCH</span><span class="muted">${roster}${limit ? ` of ${limit}` : ""} on the roster</span></div>${bench.map(benchRow).join("") || '<p class="muted">Nobody</p>'}
        ${lab.drops.length ? `<p class="muted">Dropped: ${lab.drops.map(assetById).filter(Boolean).map((a) => `${esc(a.name)} <button class="link" data-undrop="${esc(a.id)}">undo</button>`).join(", ")}</p>` : ""}
      </div>
    </div>
    <p class="muted">${lab.manual ? "Your hand-set lineup. " : "Best lineup by projected points. "}Tap a player in the After column, then another, to swap them. Points are ${lab.key === "ros_ppg" ? "rest-of-season points a week (mostly Sleeper's projections for the next three weeks)" : "Sleeper's projection for this week"} in this league's scoring. League rank counts every team's best lineup, with the trade applied to everyone in it.</p>`;

  $("#lab-team").onchange = (e) => { lab.team = Number(e.target.value); lab.adds = []; lab.drops = []; renderLab(); };
  el.querySelectorAll("[data-key]").forEach((b) => (b.onclick = () => { lab.key = b.dataset.key; renderLab(); }));
  $("#lab-trade").onchange = (e) => { lab.trade = e.target.checked; renderLab(); };
  $("#lab-edit").onclick = () => document.querySelector('.tabs button[data-tab="trade"]').click();
  if ($("#lab-reset")) $("#lab-reset").onclick = () => { lab.adds = []; lab.drops = []; lab.manual = null; lab.sig = ""; renderLab(); };
  const dl = $("#lab-add-list"), taken = new Set(after.map((p) => p.id));
  dl.innerHTML = state.data.players.filter((p) => !taken.has(p.id) && (p.ros_ppg || p.proj_week || p.value)).slice(0, 600)
    .map((p) => `<option value="${esc(p.name)} (${p.pos}${p.team ? ", " + esc(p.team) : ""})${p.roster_id ? " · " + esc(teamOf(p.roster_id)?.name || "") : " · FA"}"></option>`).join("");
  $("#lab-add").onchange = (e) => {
    const name = e.target.value.split(" (")[0];
    const p = state.data.players.find((x) => x.name === name && !taken.has(x.id));
    if (p) { lab.adds.push(p.id); lab.drops = lab.drops.filter((d) => d !== p.id); renderLab(); }
  };
  el.querySelectorAll("[data-drop]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); lab.drops.push(b.dataset.drop); lab.adds = lab.adds.filter((a) => a !== b.dataset.drop); renderLab(); }));
  el.querySelectorAll("[data-undrop]").forEach((b) => (b.onclick = () => { lab.drops = lab.drops.filter((d) => d !== b.dataset.undrop); renderLab(); }));
  el.querySelectorAll("[data-swap]").forEach((r) => (r.onclick = (e) => {
    if (e.target.closest("button")) return;
    e.stopPropagation();
    const id = r.dataset.swap;
    if (lab.pick == null || lab.pick === id) { lab.pick = lab.pick === id ? null : id; renderLab(); return; }
    const cur = luA.map((x) => ({ slot: x.slot, id: x.p ? x.p.id : null }));
    const i = cur.findIndex((x) => x.id === lab.pick), j = cur.findIndex((x) => x.id === id);
    const ok = (k, pid) => SLOT_ELIGIBILITY[cur[k].slot].includes(after.find((p) => p.id === pid).pos);
    let done = false;
    if (i >= 0 && j >= 0 && ok(i, id) && ok(j, lab.pick)) { cur[i].id = id; cur[j].id = lab.pick; done = true; }
    else if (i >= 0 && j < 0 && ok(i, id)) { cur[i].id = id; done = true; }
    else if (i < 0 && j >= 0 && ok(j, lab.pick)) { cur[j].id = lab.pick; done = true; }
    lab.pick = null;
    if (done) lab.manual = cur;
    renderLab();
    if (!done) $("#lab .lab-trade").insertAdjacentHTML("beforeend", ` <span class="error">Those two can't swap: a slot can only take the positions it allows.</span>`);
  }));
}

// ---------- pick projections ----------
// Where every team's picks should land, year by year. Next year's slots come from the
// projected standings under this league's draft rule; the year after from the engine's
// simulated finishes (rosters a year older plus the rookies each team's picks bring);
// the third year from each team's projected lineup that season, weakest picking first.
const pickProj = { year: null };
const teamAvatar = (t) => (t && t.avatar ? `<img class="face" src="https://sleepercdn.com/avatars/thumbs/${esc(t.avatar)}" alt="" loading="lazy" onerror="this.remove()">` : "");
const roundWord = (r) => ["", "1st", "2nd", "3rd"][r] || `${r}th`;

function pickYearOrder(year) {
  const n = state.data.teams.length;
  const firsts = state.data.picks.filter((p) => p.year === year && p.round === 1);
  if (firsts.length === n && firsts.every((p) => p.slot)) {
    return { how: "exact", order: firsts.slice().sort((a, b) => a.slot - b.slot).map((p) => ({ rid: p.original_roster_id, exp: p.slot })) };
  }
  if (firsts.length === n && firsts.every((p) => p.proj_slot != null)) {
    return { how: "sim", order: firsts.slice().sort((a, b) => a.proj_slot - b.proj_slot).map((p) => ({ rid: p.original_roster_id, exp: p.proj_slot })) };
  }
  const ppg = (t) => {
    const f = t.future || {};
    // The draft follows the season before it.
    const y = (f.years || []).find((x) => x.year === year - 1);
    return y ? y.ppg : f.now ? f.now.ppg : t.ros_ppg || 0;
  };
  return { how: "lineup", order: state.data.teams.slice().sort((a, b) => ppg(a) - ppg(b)).map((t) => ({ rid: t.roster_id, exp: null, ppg: ppg(t) })) };
}

// ---------- playoff and draft-slot odds ----------
// Simulates the rest of the regular season thousands of times: each week every team
// scores around its rest-of-season lineup points (spread = the league's weekly sigma),
// against its real opponent and the median when the league plays one. Seeds follow
// the league's way (division winners first, ties to points for), then the bracket
// plays out the same way, with placement games for teams knocked out in the same
// round. The coming rookie draft's first round is ordered by this league's rule:
// non-playoff teams by max PF or record, playoff teams by finish (or the league's
// fixed slots for each finish).
const ODDS_SIMS = 10000;
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Standard bracket order for a power-of-two field: 1v8, 4v5, 3v6, 2v7 and so on.
function bracketOrder(size) {
  let order = [1];
  while (order.length < size) { const n = order.length * 2; order = order.flatMap((s) => [s, n + 1 - s]); }
  return order;
}
function simulateOdds(sims = ODDS_SIMS) {
  const teams = state.data.teams, n = teams.length;
  const sch = state.data.schedule || { weeks: {}, median_game: false };
  const ppg = {};
  teams.forEach((t) => (ppg[t.roster_id] = teamPPG(rosterOf(t.roster_id))));
  const vals = Object.values(ppg).filter((v) => v > 0);
  const sigma = sch.sigma || 0.21 * (vals.reduce((a, b) => a + b, 0) / (vals.length || 1)) || 1;
  const P = Math.min(state.data.league.playoff_teams || 0, n);
  const rd = state.data.rookie_draft || {};
  const rule = (rd.rule && rd.rule.rule) || "record";
  const fixed = !!(rd.rule && rd.rule.fixed);
  const slotsFor = rd.rule && Array.isArray(rd.rule.playoff_slots) && rd.rule.playoff_slots.length === P ? rd.rule.playoff_slots : null;
  const rand = seededRandom(20261031 + n);
  let spare = null;
  const gauss = () => { if (spare != null) { const g = spare; spare = null; return g; } let u = 0, v = 0; while (u === 0) u = rand(); v = rand(); const r = Math.sqrt(-2 * Math.log(u)); spare = r * Math.sin(2 * Math.PI * v); return r * Math.cos(2 * Math.PI * v); };
  const score = (rid) => ppg[rid] + sigma * gauss();
  const ids = teams.map((t) => t.roster_id);
  const acc = {};
  ids.forEach((r) => (acc[r] = { wins: 0, playoff: 0, bye: 0, title: 0, final: 0, slot: new Array(n + 1).fill(0), slotSum: 0 }));
  const weeks = Object.values(sch.weeks || {});
  const size = P > 1 ? 2 ** Math.ceil(Math.log2(P)) : 0;
  const bOrder = size ? bracketOrder(size) : [];
  for (let s = 0; s < sims; s++) {
    const st = {};
    teams.forEach((t) => (st[t.roster_id] = { wins: t.record.wins || 0, ties: t.record.ties || 0, pf: t.record.fpts || 0, maxPF: t.record.max_pf || 0 }));
    for (const pairs of weeks) {
      const pts = {};
      ids.forEach((r) => { pts[r] = score(r); st[r].pf += pts[r]; st[r].maxPF += pts[r]; });
      for (const [a, b] of pairs) { if (pts[a] > pts[b]) st[a].wins++; else st[b].wins++; }
      if (sch.median_game) {
        const sorted = ids.map((r) => pts[r]).sort((x, y) => x - y), h = Math.floor(n / 2);
        const med = n % 2 ? sorted[h] : (sorted[h - 1] + sorted[h]) / 2;
        ids.forEach((r) => { if (pts[r] > med) st[r].wins++; });
      }
    }
    const seeds = seedOrder(st).map(Number);
    ids.forEach((r) => (acc[r].wins += st[r].wins - (teams.find((t) => t.roster_id === r).record.wins || 0)));
    // Playoffs: finish places 1..P (1 = champion).
    const place = {};
    if (P > 1) {
      seeds.slice(0, P).forEach((r, i) => { acc[r].playoff++; if (size > P && i < size - P) acc[r].bye++; });
      let alive = bOrder.map((sd) => (sd <= P ? seeds[sd - 1] : null));
      const outByRound = [];
      while (alive.length > 1) {
        const next = [], out = [];
        for (let i = 0; i < alive.length; i += 2) {
          const a = alive[i], b = alive[i + 1];
          if (a == null || b == null) { next.push(a ?? b); continue; }
          const w = score(a) >= score(b) ? a : b;
          next.push(w); out.push(w === a ? b : a);
        }
        outByRound.push(out);
        alive = next;
      }
      place[alive[0]] = 1;
      let nextPlace = 2;
      for (const out of outByRound.reverse()) {
        // Teams knocked out in the same round play for place, two at a time, best seed first.
        const grp = out.slice().sort((a, b) => seeds.indexOf(a) - seeds.indexOf(b));
        const ordered = [];
        for (let i = 0; i < grp.length; i += 2) {
          if (i + 1 >= grp.length) { ordered.push(grp[i]); continue; }
          const a = grp[i], b = grp[i + 1];
          const aw = score(a) >= score(b);
          ordered.push(aw ? a : b, aw ? b : a);
        }
        ordered.forEach((r) => (place[r] = nextPlace++));
      }
      acc[alive[0]].title++;
      Object.keys(place).forEach((r) => { if (place[r] === 2) acc[r].final++; });
      acc[alive[0]].final++;
    }
    // First-round draft order.
    if (!fixed) {
      const playoff = seeds.slice(0, P), rest = seeds.slice(P);
      rest.sort(rule === "max_pf" ? (a, b) => st[a].maxPF - st[b].maxPF : (a, b) => st[a].wins - st[b].wins || st[a].maxPF - st[b].maxPF);
      const order = new Array(n).fill(null);
      if (slotsFor) {
        playoff.forEach((r) => (order[slotsFor[place[r] - 1] - 1] = r));
        let k = 0;
        for (let i = 0; i < n; i++) if (order[i] == null) order[i] = rest[k++];
      } else {
        const po = playoff.slice().sort((a, b) => (place[b] || 0) - (place[a] || 0));
        [...rest, ...po].forEach((r, i) => (order[i] = r));
      }
      order.forEach((r, i) => { if (r != null) { acc[r].slot[i + 1]++; acc[r].slotSum += i + 1; } });
    }
  }
  return { acc, sims, P, sigma, fixed, rule, slotsFor, size, year: rd.year, weeksLeft: weeks.length };
}

function renderOdds() {
  const el = $("#odds");
  if (!el || !state.data) return;
  const teams = state.data.teams, n = teams.length;
  if (!teams.some((t) => t.players && t.players.length)) { el.innerHTML = `<p class="muted">Odds start once the league has drafted.</p>`; return; }
  const r = simulateOdds();
  const pct = (x) => { const v = (100 * x) / r.sims; return v >= 99.5 && v < 100 ? ">99%" : v > 0 && v < 0.5 ? "<1%" : `${Math.round(v)}%`; };
  const mine = myTeam();
  const rows = teams.map((t) => ({ t, a: r.acc[t.roster_id] })).sort((x, y) => y.a.playoff - x.a.playoff || y.a.title - x.a.title || x.a.slotSum - y.a.slotSum);
  const heat = (x) => `style="background:rgba(111,227,164,${Math.min(0.55, x / r.sims * 0.9).toFixed(2)})"`;
  const year = r.year || (state.data.picks || []).reduce((m, p) => Math.min(m, p.year), 9999);
  const firstOf = (rid) => (state.data.picks || []).find((p) => p.year === year && p.round === 1 && p.original_roster_id === rid);
  const holder = (rid) => { const pk = firstOf(rid); return pk ? teamOf(pk.roster_id) : null; };
  const top = Math.min(3, n);
  const ruleText = r.fixed ? `The ${year} draft order is fixed by the league, so there are no draft-slot odds here.`
    : `${year} first-round order: non-playoff teams ${r.rule === "max_pf" ? "by max PF, lowest first" : "by record, worst first (max PF breaks ties)"}, then playoff teams ${r.slotsFor ? `in the league's slots for each finish (champion ${r.slotsFor[0]}, runner-up ${r.slotsFor[1]})` : "by finish, champion last"}.`;
  const myFirsts = mine ? (state.data.picks || []).filter((p) => p.year === year && p.round === 1 && p.roster_id === mine.roster_id) : [];
  el.innerHTML = `
    <div class="lab-head"><div><p class="kicker">${fmt(r.sims)} simulated seasons</p><h2>Playoff and draft odds</h2></div></div>
    <p class="muted">${r.weeksLeft} regular-season weeks left. Each sim plays every remaining game from each team's rest-of-season lineup points (weekly swing of ±${r.sigma.toFixed(1)}), seeds the ${r.P}-team playoff the league's way${r.size > r.P ? ` with byes for the top ${r.size - r.P}` : ""}, and plays it out. ${ruleText}</p>
    ${myFirsts.length && !r.fixed ? `<div class="my-picks">${myFirsts.map((p) => { const a = r.acc[p.original_roster_id]; return `<div class="my-pick on">${face(p.id)}<div><b>${year} 1st${p.original_roster_id !== p.roster_id ? ` via ${esc(teamOf(p.original_roster_id)?.name || "")}` : " (your own)"}</b><span class="muted">avg slot ${(a.slotSum / r.sims).toFixed(1)} · top ${top}: ${pct(a.slot.slice(1, top + 1).reduce((x, y) => x + y, 0))}</span></div></div>`; }).join("")}</div>` : ""}
    <div class="table-wrap"><table class="odds-table"><thead><tr><th>Team</th><th>Record</th><th class="num">Proj. wins</th><th class="num">Playoffs</th>${r.size > r.P ? '<th class="num">Bye</th>' : ""}<th class="num">Final</th><th class="num">Title</th>${r.fixed ? "" : `<th class="num">Avg ${year} slot</th><th class="num">Top ${top} pick</th><th>Their 1st belongs to</th>`}</tr></thead><tbody>
    ${rows.map(({ t, a }) => { const h = holder(t.roster_id); return `<tr class="${mine && t.roster_id === mine.roster_id ? "me" : ""}"><td>${teamHtml(t.roster_id)}</td><td>${t.record.wins}-${t.record.losses}${t.record.ties ? "-" + t.record.ties : ""}</td>
      <td class="num">${((t.record.wins || 0) + a.wins / r.sims).toFixed(1)}</td><td class="num" ${heat(a.playoff)}>${pct(a.playoff)}</td>${r.size > r.P ? `<td class="num" ${heat(a.bye)}>${pct(a.bye)}</td>` : ""}<td class="num" ${heat(a.final)}>${pct(a.final)}</td><td class="num" ${heat(a.title)}>${pct(a.title)}</td>
      ${r.fixed ? "" : `<td class="num">${(a.slotSum / r.sims).toFixed(1)}</td><td class="num" ${heat(a.slot.slice(1, top + 1).reduce((x, y) => x + y, 0))}>${pct(a.slot.slice(1, top + 1).reduce((x, y) => x + y, 0))}</td><td>${h ? (mine && h.roster_id === mine.roster_id ? "<b>You</b>" : esc(h.name)) : ""}</td>`}</tr>`; }).join("")}
    </tbody></table></div>
    ${r.fixed ? "" : `<h3>${year} first-round slot odds</h3><p class="muted">Each row is a team's own 1st; each column is the slot it lands in. Rows you own are marked.</p>
    <div class="table-wrap"><table class="odds-table slots"><thead><tr><th>Pick</th>${Array.from({ length: n }, (_, i) => `<th class="num">1.${String(i + 1).padStart(2, "0")}</th>`).join("")}</tr></thead><tbody>
    ${teams.slice().sort((x, y) => r.acc[x.roster_id].slotSum - r.acc[y.roster_id].slotSum).map((t) => { const a = r.acc[t.roster_id], h = holder(t.roster_id); const own = mine && h && h.roster_id === mine.roster_id;
      return `<tr class="${own ? "me" : ""}"><td>${esc(t.name)}${own ? ' <span class="tag new">YOURS</span>' : ""}</td>${a.slot.slice(1).map((c) => `<td class="num" ${heat(c)}>${c ? pct(c) : ""}</td>`).join("")}</tr>`; }).join("")}
    </tbody></table></div>`}`;
}

function renderPickProj() {
  const el = $("#pickproj");
  if (!el || !state.data) return;
  const picks = state.data.picks || [];
  const years = [...new Set(picks.map((p) => p.year))].sort();
  if (!years.length) { el.innerHTML = `<p class="muted">No tradable picks in this league.</p>`; return; }
  if (!years.includes(pickProj.year)) pickProj.year = years[0];
  const year = pickProj.year, n = state.data.teams.length;
  const rd = state.data.rookie_draft || {};
  const rounds = Math.max(...picks.filter((p) => p.year === year).map((p) => p.round));
  const snake = rd.type === "snake";
  const { how, order } = pickYearOrder(year);
  const mine = myTeam();
  const pickOf = (r, rid) => picks.find((p) => p.year === year && p.round === r && p.original_roster_id === rid);
  const card = (r, i) => {
    const k = snake && r % 2 === 0 ? n - 1 - i : i;
    const o = order[k], slot = i + 1, pk = pickOf(r, o.rid), orig = teamOf(o.rid);
    const holder = pk ? teamOf(pk.roster_id) : orig;
    const isMine = mine && holder && holder.roster_id === mine.roster_id;
    const moved = pk && pk.roster_id !== pk.original_roster_id;
    const land = pk && pk.landing;
    const range = how === "sim" && r === 1 ? `<span class="muted">avg ${Number(o.exp).toFixed(1)}</span>`
      : land && land.range ? `<span class="muted" title="Where this pick lands across simulated finishes to the season (10th to 90th percentile); its value is the average over all of them">${land.range[0] === land.range[1] ? `${r}.${String(land.range[0]).padStart(2, "0")}` : `${land.range[0]}-${land.range[1]}`}${r === 1 && land.top3 >= 0.01 ? ` · top 3 ${Math.round(land.top3 * 100)}%` : ""}</span>` : "";
    return `<div class="pick-card ${isMine ? "yours" : ""}" style="animation-delay:${(i * 0.025).toFixed(3)}s">
      <div class="pick-slot">${r}.${String(slot).padStart(2, "0")}</div>
      <div class="pick-team">${teamAvatar(orig)}<span><b>${esc(orig ? orig.name : "")}</b>${moved ? `<span class="muted">owned by ${esc(holder.name)}</span>` : managerOf(orig) ? `<span class="muted">${esc(managerOf(orig))}</span>` : ""}</span></div>
      <div class="pick-foot"><span class="num strong">${pk ? fmt(pk.value) : ""}</span>${range}${isMine ? '<span class="tag new">YOURS</span>' : ""}</div>
    </div>`;
  };
  const myRows = mine ? picks.filter((p) => p.roster_id === mine.roster_id).sort((a, b) => a.year - b.year || a.round - b.round) : [];
  const where = (p) => {
    const yo = pickYearOrder(p.year), i = yo.order.findIndex((o) => o.rid === p.original_roster_id);
    if (i < 0) return "";
    const slot = snake && p.round % 2 === 0 ? n - i : i + 1;
    const third = slot <= n / 3 ? "Early" : slot > (2 * n) / 3 ? "Late" : "Mid";
    return { label: `${p.round}.${String(slot).padStart(2, "0")}`, third, how: yo.how };
  };
  const howText = {
    exact: `${year} slots are where each pick lands if the season ends the way it's projected now, under this league's draft rule${rd.rule && rd.rule.rule === "max_pf" ? " (non-playoff teams ordered by max PF, playoff teams by finish)" : ""}.${picks.some((p) => p.year === year && p.landing) ? " Each pick's value is the average over every slot it lands at when the rest of the season is played out thousands of times (the range under it), so a pick that could slide into the top three carries that chance." : ""}`,
    sim: `${year} slots come from thousands of simulated ${year - 1} seasons: every roster a year older, plus the rookies its ${year - 1} picks bring. "avg" is the average first-round slot across those runs; the farther out, the wider the real range.`,
    lineup: `${year} slots order teams by their projected ${year - 1} lineup (players aged a year, no rookies added yet), weakest picking first. This far out it's a rough guide.`,
  }[how];
  el.innerHTML = `
    <div class="lab-head"><div><p class="kicker">Pick projections</p><h2>Where every pick lands</h2></div>
      <div class="chips">${years.map((y) => `<button class="chip ${y === year ? "active" : ""}" data-year="${y}">${y}</button>`).join("")}</div></div>
    ${myRows.length ? `<div class="my-picks">${myRows.map((p) => { const w = where(p); return `<div class="my-pick ${p.year === year ? "on" : ""}">
      ${face(p.id)}<div><b>${p.year} ${w ? w.label : roundWord(p.round)}</b><span class="muted">${w ? `${w.third} ${roundWord(p.round)}` : ""}${p.original_roster_id !== p.roster_id ? ` · via ${esc(teamOf(p.original_roster_id)?.name || "")}` : " · your own"}</span></div><span class="num strong">${fmt(p.value)}</span></div>`; }).join("")}</div>` : ""}
    <p class="muted">${howText} ${picks.some((p) => p.year === year && p.tier) ? "Values are this league's pick values, which already price in the projected slot." : `${year} picks are still valued as a plain round, the same for every team.`}</p>
    ${Array.from({ length: rounds }, (_, r) => `<h3>${year} round ${r + 1}${snake ? (r % 2 ? " · snake, order reverses" : "") : ""}</h3>
      <div class="pick-board">${Array.from({ length: n }, (_, i) => card(r + 1, i)).join("")}</div>`).join("")}`;
  el.querySelectorAll("[data-year]").forEach((b) => (b.onclick = () => { pickProj.year = Number(b.dataset.year); renderPickProj(); }));
}

// ---------- future rookie classes ----------
// The 2027, 2028 and 2029 superflex classes: our research (site/devy.json, scouting notes,
// stats and a superflex rank) joined with KTC's devy values on this league's scale.
const devyView = { year: null, sort: "ours", pos: "ALL" };
const devyKey = (s) => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "").replace(/[^a-z]/g, "");
let devyNotes;

async function renderDevy() {
  const el = $("#devy");
  if (!el || !state.data) return;
  if (devyNotes === undefined) {
    devyNotes = null;
    try { devyNotes = await getJSON("devy.json"); } catch (e) { console.error(`devy notes: ${e.message || e}`); }
  }
  const market = state.data.future_classes || {};
  const research = (devyNotes && devyNotes.classes) || {};
  const years = [...new Set([...Object.keys(market), ...Object.keys(research)])].sort();
  if (!years.length) { el.innerHTML = `<p class="muted">No future class data for this league yet.</p>`; return; }
  if (!years.includes(devyView.year)) devyView.year = years[0];
  const year = devyView.year;
  const byKey = new Map();
  (research[year] || []).forEach((r) => byKey.set(devyKey(r.name), { r }));
  (market[year] || []).forEach((m) => { const k = devyKey(m.name); byKey.set(k, { ...(byKey.get(k) || {}), m }); });
  const ktcOrder = (market[year] || []).map((m) => devyKey(m.name));
  let rows = [...byKey.values()].map((x) => ({ ...x, name: (x.r || x.m).name, pos: (x.r || x.m).pos, value: x.m ? x.m.value : null,
    ours: x.r ? x.r.rank : null, ktcRank: x.m ? ktcOrder.indexOf(devyKey(x.m.name)) + 1 : null }));
  const counts = rows.reduce((c, x) => ((c[x.pos] = (c[x.pos] || 0) + 1), c), {});
  if (devyView.pos !== "ALL") rows = rows.filter((x) => x.pos === devyView.pos);
  const big = 1e9;
  rows.sort(devyView.sort === "ours" ? (a, b) => (a.ours ?? big) - (b.ours ?? big) || (b.value || 0) - (a.value || 0)
    : (a, b) => (b.value || 0) - (a.value || 0) || (a.ours ?? big) - (b.ours ?? big));
  const tierName = ["", "Cornerstone", "Future starter", "High upside", "Developmental", "Long shot"];
  const src = (devyNotes && devyNotes.sources) || [];
  const card = (x, i) => {
    const r = x.r || {}, m = x.m || {};
    const meta = [r.school || m.school, r.class_year, r.height && r.weight ? `${r.height}, ${r.weight}` : r.height, r.hs_rank].filter(Boolean).map(esc).join(" · ");
    const links = (r.sources || []).map((k) => src[k]).filter((s) => s && s.url).slice(0, 3)
      .map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || "source")}</a>`).join(" · ");
    return `<article class="devy-card" style="animation-delay:${Math.min(i, 20) * 0.03}s">
      <div class="devy-rank">${i + 1}</div>
      <div class="devy-main">
        <div class="devy-name"><span class="pos pos-${esc(x.pos)}">${esc(x.pos)}</span> <b>${esc(x.name)}</b>${r.tier ? ` <span class="devy-tier t${r.tier}">${tierName[r.tier] || "Tier " + r.tier}</span>` : ""}</div>
        <p class="muted">${meta}</p>
        ${r.stats_2026 ? `<p class="devy-stats"><b>2026</b> ${esc(r.stats_2026)}${r.stats_2025 ? ` <span class="muted">· 2025 ${esc(r.stats_2025)}</span>` : ""}</p>` : ""}
        ${r.notes ? `<p>${esc(r.notes)}</p>` : ""}
        ${r.nfl_comp || r.class_note || links ? `<p class="muted small">${r.nfl_comp ? `Comp: ${esc(r.nfl_comp)}. ` : ""}${r.class_note ? `${esc(r.class_note)} ` : ""}${links}</p>` : ""}
      </div>
      <div class="devy-nums">
        <div><label>Our SF rank</label><b>${x.ours ?? "–"}</b></div>
        <div><label>KTC SF rank</label><b>${x.ktcRank || "–"}</b></div>
        <div><label>League value</label><b>${x.value ? fmt(x.value) : "–"}</b></div>
      </div>
    </article>`;
  };
  el.innerHTML = `
    <div class="lab-head"><div><p class="kicker">Superflex · future rookies</p><h2>The ${year} class</h2></div>
      <div class="chips">${years.map((y) => `<button class="chip ${y === year ? "active" : ""}" data-year="${y}">${y}</button>`).join("")}</div></div>
    <div class="toolbar">
      <div class="chips">${["ALL", "QB", "RB", "WR", "TE"].map((p) => `<button class="chip ${devyView.pos === p ? "active" : ""}" data-pos="${p}">${p === "ALL" ? "All" : p}${p !== "ALL" && counts[p] ? ` <span class="muted">${counts[p]}</span>` : ""}</button>`).join("")}</div>
      <div class="chips">${[["ours", "Our rank"], ["value", "League value"]].map(([k, v]) => `<button class="chip ${devyView.sort === k ? "active" : ""}" data-sort="${k}">Sort: ${v}</button>`).join("")}</div>
    </div>
    <details class="muted"><summary>How these are ranked (research as of ${esc((devyNotes && devyNotes.as_of) || "–")})</summary>${devyNotes && devyNotes.method_by_year && devyNotes.method_by_year[year] ? `${esc(devyNotes.method_by_year[year])} ` : devyNotes && devyNotes.method ? `${esc(devyNotes.method)} ` : ""} League value is KTC's ${state.data.league.format && state.data.league.format.superflex === false ? "1QB" : "superflex"} devy value mapped onto this league's scale and adjusted for how this league scores each position; it refreshes every build. Class years follow NFL draft eligibility (three years out of high school), so a player can slide a year if he stays in school.</details>
    <div class="devy-list">${rows.map(card).join("") || '<p class="muted">Nobody at this position yet.</p>'}</div>`;
  el.querySelectorAll("[data-year]").forEach((b) => (b.onclick = () => { devyView.year = b.dataset.year; renderDevy(); }));
  el.querySelectorAll("[data-pos]").forEach((b) => (b.onclick = () => { devyView.pos = b.dataset.pos; renderDevy(); }));
  el.querySelectorAll("[data-sort]").forEach((b) => (b.onclick = () => { devyView.sort = b.dataset.sort; renderDevy(); }));
}

// ---------- team direction (mirrors engine/builds.py assign) ----------
// The eight builds re-run on post-trade rosters, so a trade shows whether it moves a
// team from, say, Playoff Bubble to Young Contender. Keep in sync with builds.py.
const BUILD_INFO = {
  juggernaut: ["Dynasty Juggernaut", "contender"], all_in: ["All-In Veterans", "contender"],
  young_contender: ["Young Contender", "contender"], bubble: ["Playoff Bubble", "middle"],
  stuck: ["Stuck in the Middle", "middle"], youth: ["Youth Movement", "rebuilding"],
  pick_hoarder: ["Pick Hoarder", "rebuilding"], teardown: ["Full Teardown", "rebuilding"],
};
const BUILD_CORE = 12, BUILD_YOUNG = 24, BUILD_OLD_Z = 0.5, BUILD_YOUNG_Z = -0.5;
function assignBuilds(overrides = {}, pickDelta = {}) {
  const teams = state.data.teams, n = teams.length;
  const rec = projectRecords(overrides);
  const playoff = state.data.league.playoff_teams || Math.ceil(n / 2);
  const m = teams.map((t) => {
    const rid = t.roster_id;
    const ps = overrides[rid] || rosterOf(rid);
    const pv = ps.reduce((a, p) => a + (p.value || 0), 0);
    const pk = (t.pick_value || 0) + (pickDelta[rid] || 0);
    const core = ps.filter((p) => p.age).sort((a, b) => b.value - a.value).slice(0, BUILD_CORE);
    const w = core.reduce((a, p) => a + p.value, 0);
    const age = w ? Math.round((core.reduce((a, p) => a + p.age * p.value, 0) / w) * 10) / 10 : null;
    const youth = ps.filter((p) => (p.age || 99) <= BUILD_YOUNG).reduce((a, p) => a + p.value, 0) / Math.max(pv, 1);
    return { rid, ppg: rec[rid].ppg, total: pv + pk, age, youth, pshare: pk / Math.max(pv + pk, 1), proj: rec[rid].rank || n };
  });
  const rank = (key) => { const r = {}; [...m].sort((a, b) => key(b) - key(a)).forEach((x, i) => (r[x.rid] = i + 1)); return r; };
  const now = rank((x) => x.ppg), val = rank((x) => x.total), ys = rank((x) => x.youth), psr = rank((x) => x.pshare);
  const known = m.map((x) => x.age).filter((a) => a != null);
  const mu = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 26;
  const sd = known.length ? Math.sqrt(known.reduce((a, b) => a + (b - mu) ** 2, 0) / known.length) || 1 : 1;
  const medPick = m.map((x) => x.pshare).sort((a, b) => a - b)[Math.floor(n / 2)];
  const pct = (r) => (n > 1 ? (r - 1) / (n - 1) : 0);
  const out = {};
  for (const x of m) {
    const P = pct(now[x.rid]), V = pct(val[x.rid]), Y = pct(ys[x.rid]);
    const z = ((x.age ?? mu) - mu) / sd;
    const old = z >= BUILD_OLD_Z, young = z <= BUILD_YOUNG_Z;
    const hoard = psr[x.rid] <= Math.max(2, Math.floor(n / 6)) && x.pshare >= Math.max(1.5 * medPick, 0.15);
    const key = P <= 1 / 3 && V <= 1 / 3 && !old ? "juggernaut"
      : P <= 1 / 3 && (z <= 0.25 || (x.youth >= 0.35 && !old)) ? "young_contender"
      : P <= 1 / 3 ? "all_in"
      : hoard ? "pick_hoarder"
      : P < 2 / 3 && x.proj <= playoff ? "bubble"
      : young || Y <= 1 / 3 ? "youth"
      : P >= 2 / 3 ? "teardown" : "stuck";
    out[x.rid] = { key, name: BUILD_INFO[key][0], tone: BUILD_INFO[key][1], nowRank: now[x.rid], valueRank: val[x.rid],
      m: { P, V, Y, z, H: pct(psr[x.rid]) } };
  }
  return out;
}
// ---------- aiming for a build ----------
// How far a team sits from each build, from the same parts assignBuilds uses (0 = best:
// P points-a-week rank, V value rank, Y youth rank, H pick-share rank as 0..1 percentiles,
// z core age against the league). A deal "moves you toward" a build when this drops.
const BUILD_AIM = {
  juggernaut: (m) => m.P + m.V,
  young_contender: (m) => m.P + 0.5 * Math.max(0, m.z + 0.25),
  all_in: (m) => m.P,
  bubble: (m) => Math.abs(m.P - 0.45),
  stuck: (m) => Math.abs(m.P - 0.5),
  youth: (m) => m.Y + 0.5 * Math.max(0, m.z + 0.5),
  pick_hoarder: (m) => m.H,
  teardown: (m) => 1 - m.P + 0.5 * m.Y,
};
const aimTone = (key) => ({ contender: "contend", rebuilding: "rebuild" })[BUILD_INFO[key][1]] || "balanced";
// Progress toward `key` from build b0 to b1: hit = lands on it, closer = distance saved.
function aimProgress(b0, b1, key) {
  if (!key || !b0 || !b1) return { hit: false, closer: 0 };
  return { hit: b1.key === key, closer: BUILD_AIM[key](b0.m) - BUILD_AIM[key](b1.m) };
}
// Rosters and pick totals after a deal, from each team's gets and gives.
function dealAfter(side) {
  const overrides = {}, pd = {};
  for (const [rid, x] of Object.entries(side)) {
    const out = new Set(x.gives.map((a) => a.id));
    overrides[rid] = rosterOf(Number(rid)).filter((p) => !out.has(p.id)).concat(x.gets.filter((a) => a.kind === "player"));
    pd[rid] = x.gets.filter((a) => a.kind === "pick").reduce((t, a) => t + a.value, 0) - x.gives.filter((a) => a.kind === "pick").reduce((t, a) => t + a.value, 0);
  }
  return { overrides, pd };
}

const toneCls = (tone) => (tone === "contender" ? "contender" : tone === "middle" ? "middle" : "rebuilding");
const buildChip = (b) => `<span class="outlook ${toneCls(b.tone)}">${esc(b.name)}</span>`;
function directionHtml(b0, b1) {
  if (!b0 || !b1) return "";
  if (b0.key === b1.key) return `${buildChip(b0)} <span class="muted">stays</span>`;
  const turn = b0.tone !== b1.tone ? ` <span class="${b1.tone === "contender" ? "up" : b1.tone === "rebuilding" ? "down" : ""}">(${esc(b0.tone)} → ${esc(b1.tone)})</span>` : "";
  return `${buildChip(b0)} → ${buildChip(b1)}${turn}`;
}
// Pick value each team gains or loses in a trade (players move through overrides).
function tradePickDelta(s) {
  const d = {};
  s.forEach((side, i) => side.assets.map(assetById).filter((a) => a && a.kind === "pick").forEach((a) => {
    const from = senderOf(a, i);
    if (side.team != null) d[side.team] = (d[side.team] || 0) + a.value;
    if (from >= 0 && s[from].team != null) d[s[from].team] = (d[s[from].team] || 0) - a.value;
  }));
  return d;
}

// How a trade changes each involved team's starters and rooms, by league rank.
function tradeImpact(s, overrides, before, after, recBefore, recAfter) {
  if (!Object.keys(overrides).length) return "";
  const dirBefore = assignBuilds(), dirAfter = assignBuilds(overrides, tradePickDelta(s));
  const arrow = (b, a) => (a < b ? `<span class="up">#${b} → #${a}</span>` : a > b ? `<span class="down">#${b} → #${a}</span>` : `<span class="muted">#${b}</span>`);
  // Overall value: every player on the roster plus every pick, before and after.
  const pickDelta = tradePickDelta(s);
  const sum = (ps) => ps.reduce((t, p) => t + p.value, 0);
  const overall = (after) => {
    const v = {};
    for (const t of state.data.teams) {
      const rid = t.roster_id;
      v[rid] = sum(after && overrides[rid] ? overrides[rid] : rosterOf(rid)) + (t.pick_value || 0) + (after ? pickDelta[rid] || 0 : 0);
    }
    const rank = {};
    Object.keys(v).sort((a, b) => v[b] - v[a]).forEach((rid, i) => (rank[rid] = i + 1));
    return { v, rank };
  };
  const ovB = overall(false), ovA = overall(true);
  const rows = s.filter((x) => x.team != null).map((side) => {
    const rid = side.team;
    const sb = before.by[rid].starters, sa = after.by[rid].starters;
    const diff = sa - sb;
    const moved = roomPositions().filter((p) => before.ranks[p][rid] !== after.ranks[p][rid] || Math.round(before.by[rid].rooms[p]) !== Math.round(after.by[rid].rooms[p]));
    const need = needsOf(rid, before.ranks).needs;
    const filled = need.filter((p) => after.ranks[p][rid] < before.ranks[p][rid]);
    const opened = needsOf(rid, after.ranks).needs.filter((p) => !need.includes(p));
    const notes = [
      filled.length ? `<span class="up">helps need at ${filled.join(", ")}</span>` : "",
      opened.length ? `<span class="down">creates a need at ${opened.join(", ")}</span>` : "",
    ].filter(Boolean).join(" · ");
    const rb = recBefore[rid], ra = recAfter[rid], dw = ra.wins - rb.wins;
    const recCell = `${recordText(rb)} → ${recordText(ra)} <span class="${dw > 0.05 ? "up" : dw < -0.05 ? "down" : "muted"}">(${dw >= 0 ? "+" : ""}${dw.toFixed(1)} W)</span><br><span class="muted">${ordinal(rb.rank)} → ${ordinal(ra.rank)} · ${rb.ppg.toFixed(1)} → ${ra.ppg.toFixed(1)} pts/wk · max PF ${fmt(rb.maxPF)} → ${fmt(ra.maxPF)}</span>`;
    return `<tr><td class="name">${teamHtml(rid)}</td>
      <td>${directionHtml(dirBefore[rid], dirAfter[rid])}</td>
      <td>${recCell}</td>
      <td class="num">${fmt(sb)} → ${fmt(sa)} <span class="${diff > 0 ? "up" : diff < 0 ? "down" : "muted"}">(${diff >= 0 ? "+" : ""}${fmt(diff)})</span></td>
      <td>${arrow(before.ranks.starters[rid], after.ranks.starters[rid])}</td>
      <td class="num">${fmt(ovB.v[rid])} → ${fmt(ovA.v[rid])} <span class="${ovA.v[rid] > ovB.v[rid] ? "up" : ovA.v[rid] < ovB.v[rid] ? "down" : "muted"}">(${ovA.v[rid] >= ovB.v[rid] ? "+" : ""}${fmt(ovA.v[rid] - ovB.v[rid])})</span><br>${arrow(ovB.rank[rid], ovA.rank[rid])}</td>
      <td>${moved.map((p) => `${p} ${arrow(before.ranks[p][rid], after.ranks[p][rid])}`).join("<br>") || '<span class="muted">no change</span>'}</td>
      <td>${notes || (need.length ? `<span class="muted">needs ${need.join(", ")}</span>` : "")}</td></tr>`;
  });
  return `<h3>Roster impact</h3><div class="table-wrap"><table class="impact"><thead><tr><th>Team</th><th>Direction</th><th>Projected record</th><th class="num">Starter value</th><th>Starters rank</th><th class="num" title="Every player on the roster plus every pick">Overall value</th><th>Position rooms (league rank)</th><th>Needs</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
    <p class="muted">Ranks are among all ${state.data.teams.length} teams after the trade. A room is its starters' value plus a little credit for the next ${DEPTH_COUNT} backups. Picks don't change these ranks. Overall value counts the whole roster, bench included, plus every pick, with its league rank underneath.
    Direction is the team's build (see the Teams tab) before and after, re-run on the new rosters and pick totals.
    ${recordNote()}</p>`;
}

function recordNote() {
  const sch = state.data.schedule;
  const games = sch ? Object.keys(sch.weeks).length : 0;
  return games
    ? `Projected record = current record plus expected wins over the ${games} remaining regular-season week${games === 1 ? "" : "s"} against the real schedule${sch.median_game ? " (plus the weekly league-median game)" : ""}, from each lineup's rest-of-season points per game in this league's scoring. Projected max PF = max PF so far (Sleeper's best possible lineup each week played) plus the best lineup's projected points for each week left. Click any column header to sort.`
    : "No regular-season games left, so projected records equal current records.";
}

// ---------- owner messages ----------
// A ready-to-send pitch for each other owner in the trade, built only from the
// reasons that actually favor them. Derek copies and sends it himself.
const listNames = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const avgAge = (ps) => { const a = ps.filter((p) => p.age); return a.length ? a.reduce((t, p) => t + p.age, 0) / a.length : null; };

function pitchFor(i, ctx) {
  const { s, rows, before, after, recBefore, recAfter } = ctx;
  const rid = s[i].team;
  const team = state.data.teams.find((t) => t.roster_id === rid);
  const getsA = s[i].assets.map(assetById).filter(Boolean);
  const sendsA = s.flatMap((side, k) => side.assets.map(assetById).filter((a) => a && k !== i && senderOf(a, k) === i));
  const others = s.filter((x, k) => k !== i && x.team != null).map((x) => teamName(x.team));
  const reasons = [];
  const pct = rows[i].pct;
  if (pct > FAIR_MARGIN) reasons.push(`On values built for this league's exact scoring and roster settings, you come out ahead by about ${Math.round(pct * 100)}%.`);
  else if (pct >= -FAIR_MARGIN) reasons.push(`Value-wise it's basically even (within ${Math.round(Math.abs(pct) * 100)}% on league-adjusted values), so it comes down to fit.`);

  const needs = needsOf(rid, before.ranks).needs;
  for (const pos of needs) {
    const b = before.ranks[pos][rid], a = after.ranks[pos][rid];
    if (a < b) {
      const who = getsA.filter((x) => x.kind === "player" && x.pos === pos).map((x) => x.name);
      reasons.push(`It fixes your ${pos} room${who.length ? ` with ${listNames(who)}` : ""}: you go from ${ordinal(b)} to ${ordinal(a)} in the league at ${pos}.`);
    }
  }
  const sb = before.ranks.starters[rid], sa = after.ranks.starters[rid];
  if (sa < sb) reasons.push(`Your starting lineup moves from ${ordinal(sb)} to ${ordinal(sa)} in the league.`);
  const rb = recBefore[rid], ra = recAfter[rid], dw = ra.wins - rb.wins;
  if (dw >= 0.15 && Object.keys(state.data.schedule?.weeks || {}).length) {
    const moves = [recordText(rb) !== recordText(ra) ? `${recordText(rb)} → ${recordText(ra)}` : "",
      ra.rank < rb.rank ? `${ordinal(rb.rank)} → ${ordinal(ra.rank)} in projected standings` : ""].filter(Boolean).join(", ");
    reasons.push(`It projects to about ${dw.toFixed(1)} more wins the rest of the way${moves ? ` (${moves})` : ""}.`);
  }
  const picks = getsA.filter((x) => x.kind === "pick");
  if (picks.length && team.outlook !== "contender") reasons.push(`You add future capital: ${listNames(picks.map((x) => x.label))}.`);
  const ageIn = avgAge(getsA.filter((x) => x.kind === "player")), ageOut = avgAge(sendsA.filter((x) => x.kind === "player"));
  if (ageIn != null && ageOut != null && ageOut - ageIn >= 2) reasons.push(`You get younger: the players you get average ${ageIn.toFixed(1)} years old vs ${ageOut.toFixed(1)} for the ones you send.`);
  else if (ageIn == null && ageOut != null && ageOut >= 28 && picks.length) reasons.push(`You turn ${ageOut >= 30 ? "older" : "aging"} talent into picks before the value drops.`);
  const fit = getsA.filter((x) => x.kind === "player" && x.premium >= 1.08).map((x) => x.name);
  if (fit.length) reasons.push(`${listNames(fit)} ${fit.length > 1 ? "score" : "scores"} better in our scoring settings than in standard scoring, so ${fit.length > 1 ? "they're" : "he's"} worth more here than most trade charts say.`);

  const owner = team.owner || team.name;
  const deal = others.length > 1 ? ` It's a ${s.length}-team deal with ${listNames(others)}.` : "";
  const text = [
    `Hey ${owner}, I've got a trade idea for you.${deal}`,
    "",
    `You get: ${listNames(getsA.map((x) => x.name || x.label)) || "nothing yet"}`,
    `You send: ${listNames(sendsA.map((x) => x.name || x.label)) || "nothing"}`,
    "",
    ...(reasons.length ? ["Why it works for you:", ...reasons.map((r) => `- ${r}`), ""] : []),
    "Let me know what you think!",
  ].join("\n");
  return { rid, owner, text, strong: reasons.length };
}

function renderPitches(ctx) {
  const { s } = ctx;
  const inTrade = s.map((x, i) => i).filter((i) => s[i].team != null);
  if (!inTrade.length) return `<h3>Messages to owners</h3><p class="muted">Pick the teams in the trade to get a ready-to-send message for each owner.</p>`;
  const me = new Set(state.data.teams.filter((t) => t.is_me).map((t) => t.roster_id));
  const targets = inTrade.filter((i) => !me.has(s[i].team));
  if (!targets.length) return "";
  const link = `https://sleeper.com/leagues/${encodeURIComponent(state.data.league.sleeper_league_id)}`;
  const cards = targets.map((i) => {
    const p = pitchFor(i, ctx);
    return `<div class="pitch"><div class="pitch-head"><strong>To ${esc(p.owner)}</strong> <span class="muted">${esc(teamOf(p.rid).name)}</span><button class="copy">Copy</button></div>
      ${p.strong ? "" : `<p class="down">Nothing in this deal clearly helps them on value, needs or record, so expect a tough sell.</p>`}
      <textarea readonly rows="${Math.min(14, p.text.split("\n").length + 1)}">${esc(p.text)}</textarea></div>`;
  });
  return `<h3>Messages to owners</h3>
    <p class="muted">Each message only lists reasons that are true for that owner. Copy it and send it in Sleeper yourself (<a href="${link}" target="_blank" rel="noopener">open league</a>); nothing is sent automatically.</p>
    <div class="pitches">${cards.join("")}</div>`;
}

// ---------- teams ----------
// Eight roster builds from engine/builds.py; older data only has the three outlooks.
function buildBadge(t) {
  const b = t.build;
  if (!b) return `<span class="outlook ${t.outlook}">${t.outlook}</span>`;
  return `<span class="outlook ${b.tone === "middle" ? "middle" : b.tone === "contender" ? "contender" : "rebuilding"}" title="${esc(b.about)}">${esc(b.name)}</span>`;
}
function buildCard(t) {
  const b = t.build;
  if (!b) return "";
  return `<div class="card build-card"><h4>Build</h4><p>${buildBadge(t)} ${esc(b.about)}</p>
    <p class="muted">Why: ${b.reasons.map(esc).join("; ")}.</p>
    <h4>Playbook</h4><ul class="plan">${b.plan.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
}
// Future power rankings (engine/future.py): each roster aged one to three seasons,
// with picks turned into rookies from their draft year.
function renderFuture() {
  const el = $("#future");
  if (!el) return;
  const teams = state.data.teams.filter((t) => t.future);
  if (!teams.length) { el.innerHTML = ""; return; }
  const avg = (t) => t.future.years.reduce((s, y) => s + y.rank, 0) / t.future.years.length;
  const mine = myTeam();
  const cell = (y) => `<td class="num" data-sort="${-y.rank}"><b>${ordinal(y.rank)}</b> <span class="muted">${y.ppg.toFixed(1)}</span></td>`;
  const years = teams[0].future.years.map((y) => y.year);
  const rows = [...teams].sort((a, b) => avg(a) - avg(b)).map((t, i) => {
    const f = t.future, tr = f.trend;
    return `<tr class="${mine && t.roster_id === mine.roster_id ? "mine-row" : ""}"><td>${i + 1}</td><td class="name">${teamHtml(t.roster_id)}</td>
      <td>${t.build ? buildBadge(t) : ""}</td>${cell(f.now)}${f.years.map(cell).join("")}
      <td class="num ${tr < 0 ? "up" : tr > 0 ? "down" : ""}" data-sort="${-tr}">${tr < 0 ? "▲" + -tr : tr > 0 ? "▼" + tr : "–"}</td>
      <td>${f.best_year === f.now.year ? "Now" : f.best_year}</td><td class="num">${fmt(t.pick_value)}</td></tr>`;
  }).join("");
  el.innerHTML = `<h3>Future power rankings <span class="muted">(best lineup points a week, rosters aged with the age curves; picks become rookies from their draft year)</span></h3>
    <div class="table-wrap"><table id="future-table"><thead><tr><th>#</th><th>Team</th><th>Build</th><th class="num">Now</th>${years.map((y) => `<th class="num">${y}</th>`).join("")}
      <th class="num" title="Rank change from now to ${years[years.length - 1]}">Trend</th><th title="Season this roster ranks highest">Window</th><th class="num">Pick value</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted">Sorted by average rank over the next ${years.length} seasons. Young players who haven't produced yet are credited with the points their value implies, so treat later years as a direction, not a forecast.</p>`;
}

function renderBuildLegend() {
  const el = $("#build-legend");
  if (!el) return;
  const seen = new Map();
  for (const t of state.data.teams) if (t.build) (seen.get(t.build.key) || seen.set(t.build.key, { b: t.build, teams: [] }).get(t.build.key)).teams.push(t);
  if (!seen.size) { el.innerHTML = ""; return; }
  const order = ["juggernaut", "young_contender", "all_in", "bubble", "stuck", "youth", "pick_hoarder", "teardown"];
  el.innerHTML = `<h3>Builds in this league</h3><div class="cols">${[...seen.values()]
    .sort((x, y) => order.indexOf(x.b.key) - order.indexOf(y.b.key))
    .map(({ b, teams }) => `<div class="card"><h4>${buildBadge(teams[0])}</h4><p class="muted">${esc(b.about)}</p><p>${teams.map((t) => teamHtml(t.roster_id)).join(", ")}</p></div>`)
    .join("")}</div>`;
}

function renderTeams() {
  const recs = projectRecords();
  const rows = state.data.teams
    .map((t) => `<tr class="clickable" data-rid="${t.roster_id}">
      <td>${t.power_rank}</td><td class="name">${teamHtml(t.roster_id)}</td>
      <td data-sort="${t.record.seed ? -t.record.seed : t.record.wins}">${t.record.wins}-${t.record.losses}${t.record.ties ? "-" + t.record.ties : ""}${t.record.seed ? ` <span class="muted">(${ordinal(t.record.seed)})</span>` : ""}</td>
      <td data-sort="${recs[t.roster_id] ? recs[t.roster_id].wins : ""}">${recs[t.roster_id] ? `${recordText(recs[t.roster_id])} <span class="muted">(${ordinal(recs[t.roster_id].rank)})</span>` : ""}</td>
      <td class="num" data-sort="${recs[t.roster_id] ? recs[t.roster_id].maxPF : ""}" title="Max PF so far: ${fmt(t.record.max_pf || 0)}">${recs[t.roster_id] ? `${fmt(recs[t.roster_id].maxPF)} <span class="muted">(${ordinal(recs[t.roster_id].maxPFRank)})</span>` : ""}</td>
      <td class="num strong">${fmt(t.total_value)}</td><td class="num" data-sort="${t.starter_value}">${fmt(t.starter_value)} <span class="muted">(#${t.starter_rank})</span></td>
      <td class="num">${fmt(t.pick_value)}</td><td class="num">${t.proj_week_points || ""}</td>
      <td class="num">${t.starter_age ?? ""}</td><td data-sort="${esc(t.build ? t.build.name : t.outlook)}">${buildBadge(t)}</td></tr>`)
    .join("");
  $("#teams").innerHTML = `<thead><tr><th>#</th><th>Team</th><th>Record</th><th>Projected</th><th class="num" title="Projected end-of-season max PF: max PF so far plus the best lineup's projected points for each regular-season week left">Proj. max PF</th><th class="num">Total value</th>
    <th class="num">Starters</th><th class="num">Picks</th><th class="num">Proj pts (wk)</th><th class="num">Starter age</th><th>Build</th></tr></thead><tbody>${rows}</tbody>`;
  $("#teams").querySelectorAll("tr.clickable").forEach((tr) =>
    tr.addEventListener("click", () => { state.teamOpen = Number(tr.dataset.rid); renderTeamDetail(); })
  );
  $("#record-note").textContent = recordNote();
  renderBuildLegend();
  renderFuture();
  renderRooms();
  renderTeamDetail();
}

function renderTeamDetail() {
  const el = $("#team-detail");
  const t = state.data.teams.find((x) => x.roster_id === state.teamOpen);
  if (!t) { el.innerHTML = `<p class="muted">Click a team to see its roster, optimal lineup and picks.</p>`; return; }
  const starters = new Set(t.lineup.map((x) => x.id));
  const players = t.players.map(assetById).filter(Boolean);
  const groups = {};
  players.forEach((p) => (groups[p.pos] = groups[p.pos] || []).push(p));
  const picks = t.picks.map(assetById).filter(Boolean).sort((a, b) => a.year - b.year || a.round - b.round);
  const sit = situationText(t.roster_id);
  el.innerHTML = `<h2>${esc(t.name)} <span class="muted">${esc(t.owner || "")}</span></h2>
    ${sit ? `<p class="muted">Trade situation: ${esc(sit)}.</p>` : ""}
    ${buildCard(t)}
    <div class="cols">${Object.entries(groups)
      .sort((a, b) => POSITIONS.indexOf(a[0]) - POSITIONS.indexOf(b[0]))
      .map(([pos, ps]) => `<div class="card"><h4>${pos}</h4><ul>${ps
        .map((p) => `<li class="${starters.has(p.id) ? "starter" : ""}"><span class="player-link" data-pid="${esc(p.id)}">${esc(p.name)}${t.taxi.includes(p.id) ? ' <span class="muted">taxi</span>' : ""}</span><span class="num">${fmt(p.value)}</span></li>`)
        .join("")}</ul></div>`)
      .join("")}
      <div class="card"><h4>Picks</h4><ul>${picks.map((p) => `<li><span>${face(p.id)}${esc(p.label)}</span><span class="num">${fmt(p.value)}</span></li>`).join("") || "<li>None</li>"}</ul></div>
    </div><p class="muted">Bold = in the optimal starting lineup by value.</p>`;
}

// ---------- formula & calls ----------
// engine/formula.py scores every priced player 0-100 from seven parts and makes a
// buy / sell / hold call. For your own players the call is read through your team's
// situation: a contender keeps aging starters for the run, a rebuilder sells them.
const PARTS = [
  ["value", "Value", "League value: market blended with the points model"],
  ["production", "Prod", "Rest-of-season points a game over replacement in this scoring"],
  ["longevity", "Long", "Years left before the position's age cliff"],
  ["fit", "Fit", "How much this league's scoring lifts him over generic scoring"],
  ["momentum", "Mom", "Market move over the last 30 days"],
  ["consensus", "Cons", "How closely the market sources agree"],
  ["scarcity", "Scar", "Rank at his position against the league's starters there"],
];
const formulaView = { pos: "ALL", signal: "ALL", who: "all", q: "" };

// Your team's read on one of your own players.
function myCall(p, team) {
  const c = p.call;
  if (!c) return null;
  const mode = state.data.team_values?.context?.teams?.[team.roster_id]?.mode ?? 0;
  const starts = (team.ros_lineup || team.lineup || []).some((x) => x.id === p.id);
  const cliff = state.data.formula?.cliff?.[p.pos];
  const yearsLeft = cliff && p.age ? Math.max(0, cliff - p.age) : null;
  if (c.signal === "SELL" && mode >= 0.3 && starts)
    return { signal: "HOLD", why: `you're contending and he starts for you, so ride him this season and sell in the offseason (${c.why})` };
  if (mode <= -0.3 && c.signal !== "SELL" && yearsLeft != null && yearsLeft <= 3 && p.age >= 26)
    return { signal: "SELL", why: `you're rebuilding and he has about ${yearsLeft} prime years left; turn him into picks or younger players` };
  if (c.signal === "BUY") return { signal: "KEEP", why: `${c.why}, so don't sell him at market price` };
  return c;
}

function callBadge(sig) {
  return `<span class="call call-${sig.toLowerCase()}">${sig}</span>`;
}

function renderFormula() {
  const el = $("#formula");
  if (!el) return;
  const ps = state.data.players.filter((p) => p.formula);
  if (!ps.length) { el.innerHTML = `<p class="muted">The formula scores appear after the next data build.</p>`; return; }
  const w = state.data.formula?.weights || {};
  const mine = myTeam();
  const owner = (p) => (p.roster_id ? teamHtml(p.roster_id) : `<span class="muted">Free agent</span>`);

  let myBlock = "";
  if (mine) {
    const calls = mine.players.map(assetById).filter((p) => p && p.formula).map((p) => ({ p, c: myCall(p, mine) }));
    const group = (sig) => calls.filter((x) => x.c.signal === sig).sort((a, b) => b.p.value - a.p.value);
    const list = (xs) => xs.map(({ p, c }) => `<li><span>${face(p.id)}<b>${esc(p.name)}</b> <span class="muted">${p.pos}${p.age ? ", " + p.age : ""}</span><br><span class="muted">${esc(c.why)}</span></span><span class="num">${fmt(p.value)}</span></li>`).join("") || "<li><span class='muted'>None</span></li>";
    const sit = state.data.teams.length && mine.build ? mine.build.name : situationText(mine.roster_id);
    myBlock = `<h3>Your calls <span class="muted">(${esc(mine.name)}${sit ? " · " + esc(sit) : ""})</span></h3>
      <div class="cols calls-grid">
        <div class="card"><h4>${callBadge("SELL")} Sell</h4><ul>${list(group("SELL"))}</ul></div>
        <div class="card"><h4>${callBadge("KEEP")} Keep: worth more than the market says</h4><ul>${list(group("KEEP"))}</ul></div>
        <div class="card"><h4>${callBadge("HOLD")} Hold</h4><ul>${list(group("HOLD"))}</ul></div>
      </div>`;
  }
  const targets = ps.filter((p) => p.call.signal === "BUY" && (!mine || p.roster_id !== mine.roster_id)).sort((a, b) => b.formula.score - a.formula.score).slice(0, 15);
  const buyBlock = `<h3>Best buy targets <span class="muted">(top formula scores the market underprices; take them to the Trade Calculator)</span></h3>
    <div class="table-wrap"><table id="buy-targets"><thead><tr><th>Player</th><th>Owner</th><th class="num">Score</th><th class="num">Value</th><th>Why</th></tr></thead><tbody>${targets
      .map((p) => `<tr><td class="name">${esc(p.name)} <span class="muted">${p.pos}${p.age ? ", " + p.age : ""}</span></td><td>${owner(p)}</td><td class="num">${p.formula.score}</td><td class="num">${fmt(p.value)}</td><td class="why">${esc(p.call.why)}</td></tr>`)
      .join("")}</tbody></table></div>`;

  const positions = ["ALL", ...POSITIONS.filter((x) => ps.some((p) => p.pos === x))];
  el.innerHTML = `
    <p class="muted">Your formula ranks every player 0-100 from seven parts, each a percentile in this league: ${PARTS.map(([k, , d]) => `<b>${Math.round((w[k] || 0) * 100)}%</b> ${esc(d.toLowerCase())}`).join("; ")}. The call compares what his points are worth in this league with what the market pays, then checks age and the last month's market move.</p>
    ${myBlock}
    ${mine ? `<h3>Trade ideas for you <span class="muted">(your sells shopped to every team and the top buy targets priced from your roster, using the Trade Finder's fair line)</span></h3>
      <div class="toolbar"><button id="ideas-run" class="chip active">Find my trade ideas</button></div>
      <div id="ideas-out">${ideas.list && ideas.league === state.data.league.id ? ideasHtml(ideas.list) : ""}</div>` : ""}
    ${buyBlock}
    ${modelTuningHtml()}
    <h3>Full formula rankings</h3>
    <div class="toolbar">
      <div id="formula-pos" class="chips">${positions.map((x) => `<button class="chip ${x === formulaView.pos ? "active" : ""}" data-pos="${x}">${x === "ALL" ? "Overall" : x}</button>`).join("")}</div>
      <select id="formula-signal" aria-label="Call">${["ALL", "BUY", "HOLD", "SELL"].map((x) => `<option value="${x}" ${x === formulaView.signal ? "selected" : ""}>${x === "ALL" ? "All calls" : x}</option>`).join("")}</select>
      <select id="formula-who" aria-label="Owner">${[["all", "All players"], ["mine", "My team"], ["others", "Other teams"], ["fa", "Free agents"]].map(([v, l]) => `<option value="${v}" ${v === formulaView.who ? "selected" : ""}>${l}</option>`).join("")}</select>
      <input id="formula-search" type="search" placeholder="Search players" value="${esc(formulaView.q)}" />
    </div>
    <div class="table-wrap"><table id="formula-table"></table></div>`;
  drawFormulaTable();
  el.querySelectorAll("#formula-pos button").forEach((b) => b.addEventListener("click", () => { formulaView.pos = b.dataset.pos; el.querySelectorAll("#formula-pos button").forEach((x) => x.classList.toggle("active", x === b)); drawFormulaTable(); }));
  $("#formula-signal").addEventListener("change", (e) => { formulaView.signal = e.target.value; drawFormulaTable(); });
  $("#formula-who").addEventListener("change", (e) => { formulaView.who = e.target.value; drawFormulaTable(); });
  $("#formula-search").addEventListener("input", (e) => { formulaView.q = e.target.value; drawFormulaTable(); });
}

// What the backtest tuned and what this league's own trades taught the values.
function modelTuningHtml() {
  const m = state.data.model || {}, bt = m.backtest || {}, lm = state.data.league_market;
  if (!bt.stability && !lm) return "";
  const pc = (x) => `${Math.round(x * 100)}%`;
  const parts = [];
  if (bt.stability) parts.push(`<p><b>Backtested on ${esc((bt.seasons || []).join("-"))}.</b> Share of a player's points over replacement he kept the next season, after aging and counting missed games: ${Object.entries(bt.stability).map(([k, v]) => `${esc(k)} ${pc(v.stability)}`).join(", ")}. Weighting the last three seasons ${bt.season_weights ? `(1, ${bt.season_weights.two_ago}, ${bt.season_weights.three_ago})` : ""} cut next-season error from ${bt.season_weights?.mae_last_season_only} to ${bt.season_weights?.mae_tuned} points a game. Recent role swings mostly faded${bt.in_season ? ` (role trend ${bt.in_season.role_trend})` : ""}. ${Object.keys(m.archetype_curves || {}).length ? `Fitted age curves that beat the old ones on 2020-2025 seasons: ${Object.keys(m.archetype_curves).map((k) => esc(ARCHETYPE[k] || k)).join(", ")}; the rest kept their curves.` : ""}</p>`);
  if (m.replacement_fa_ppg && Object.keys(m.replacement_fa_ppg).length) parts.push(`<p>Replacement level here (points a game): ${Object.entries(m.replacement_ppg || {}).map(([k, v]) => `${esc(k)} ${v}`).join(", ")}, half the theoretical level and half the best free agents.</p>`);
  if (lm) {
    const moved = Object.entries(lm.multipliers || {}).filter(([, v]) => v !== 1);
    parts.push(`<p>This league's trade market (${lm.rows} trade sides from ${lm.trades} trades, this season and the two before, valued at today's numbers): ${moved.length ? moved.map(([k, v]) => `${esc(k)} ×${v}`).join(", ") : "not enough trades to move any position yet"}.</p>`);
  }
  return `<h3>How the values are tuned</h3>${parts.join("")}`;
}

function drawFormulaTable() {
  const mine = myTeam();
  const q = formulaView.q.trim().toLowerCase();
  const rows = state.data.players
    .filter((p) => p.formula)
    .filter((p) => formulaView.pos === "ALL" || p.pos === formulaView.pos)
    .filter((p) => formulaView.signal === "ALL" || p.call.signal === formulaView.signal)
    .filter((p) => formulaView.who === "all" || (formulaView.who === "fa" ? !p.roster_id : formulaView.who === "mine" ? mine && p.roster_id === mine.roster_id : p.roster_id && (!mine || p.roster_id !== mine.roster_id)))
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => a.formula.rank - b.formula.rank);
  const bar = (v) => `<td class="num part" data-sort="${v}"><span class="pbar"><span style="width:${Math.max(2, v)}%"></span></span>${Math.round(v)}</td>`;
  $("#formula-table").innerHTML = `<thead><tr><th class="num">#</th><th>Player</th><th>Owner</th><th class="num" title="Formula score, 0-100">Score</th>${PARTS.map(([, s, d]) => `<th class="num" title="${esc(d)}">${s}</th>`).join("")}<th class="num">Value</th><th class="num" title="Overall value rank">Val #</th><th>Call</th><th>Why</th></tr></thead><tbody>${rows
    .map((p) => {
      const c = mine && p.roster_id === mine.roster_id ? myCall(p, mine) : p.call;
      return `<tr class="${mine && p.roster_id === mine.roster_id ? "mine-row" : ""}"><td class="num">${p.formula.rank}</td>
        <td class="name"><span class="pos pos-${p.pos}">${p.pos}</span> <span class="player-link" data-pid="${esc(p.id)}">${esc(p.name)}</span> <span class="muted">${p.age ?? ""}</span></td>
        <td>${p.roster_id ? teamHtml(p.roster_id) : '<span class="muted">FA</span>'}</td>
        <td class="num strong">${p.formula.score}</td>${PARTS.map(([k]) => bar(p.formula.parts[k])).join("")}
        <td class="num">${fmt(p.value)}</td><td class="num">${p.rank ?? ""}</td><td data-sort="${c.signal}">${callBadge(c.signal)}</td><td class="why">${esc(c.why)}</td></tr>`;
    })
    .join("")}</tbody>`;
}

// Trade ideas: the Trade Finder run for you from your own calls. Each SELL on your
// roster is shopped to every team, and each top BUY target is priced from your roster;
// the best fair deal for each (same rules as the finder) is listed with the reason.
const IDEAS_SELL = 4, IDEAS_BUY = 4;
const ideas = { list: null, league: null };

function ideaSeeds(mine) {
  const roster = mine.players.map(assetById).filter((p) => p && p.formula);
  // Respect the Trade Finder's untouchable list when that feature is present.
  const locked = (id) => typeof untouchable === "function" && untouchable(id, mine.roster_id);
  const sells = roster.map((p) => ({ p, c: myCall(p, mine) })).filter((x) => x.c.signal === "SELL" && !locked(x.p.id))
    .sort((a, b) => b.p.value - a.p.value).slice(0, IDEAS_SELL).map(({ p, c }) => ({ kind: "sell", a: p, why: c.why }));
  const buys = state.data.players.filter((p) => p.formula && p.call.signal === "BUY" && p.roster_id && p.roster_id !== mine.roster_id && p.value >= 800)
    .sort((a, b) => b.formula.score - a.formula.score).slice(0, IDEAS_BUY).map((p) => ({ kind: "buy", a: p, why: p.call.why }));
  return [...sells, ...buys];
}

function runIdeas(done) {
  const mine = myTeam();
  if (!mine) { done([]); return; }
  const seeds = ideaSeeds(mine);
  const saved = { me: finder.me, partners: finder.partners, goal: finder.goal, target: finder.target, mode: finder.mode, winBy: finder.winBy, send: finder.send, offer: finder.offer, get: finder.get,
    getMax: finder.getMax, sendMax: finder.sendMax, positions: finder.positions, openAll: finder.openAll, last: finder.last };
  const c = teamCtx(mine.roster_id);
  const goal = c && c.label === "contending" ? "contend" : c && (c.label === "rebuilding" || c.label === "tanking") ? "rebuild" : "balanced";
  const out = [];
  const step = (i) => {
    if (i >= seeds.length) { Object.assign(finder, saved); done(out); return; }
    const s = seeds[i];
    // Ideas may pay from anywhere on your roster except your untouchables.
    Object.assign(finder, { me: mine.roster_id, partners: [], goal, target: null, mode: 2, winBy: 0, send: s.kind === "sell" ? [s.a.id] : [], offer: [], get: s.kind === "buy" ? [s.a.id] : [],
      getMax: null, sendMax: null, positions: [], openAll: s.kind === "buy" });
    const r = findTrades();
    const d = r.picked && r.picked[0];
    out.push({ ...s, deal: d || null, goal });
    const el = $("#ideas-out");
    if (el) el.innerHTML = `<p class="muted">Working… ${i + 1} of ${seeds.length}</p>`;
    setTimeout(() => step(i + 1), 0);
  };
  setTimeout(() => step(0), 20);
}

function ideasHtml(list) {
  if (!list.length) return `<p class="muted">No sells on your roster and no buy targets to price right now.</p>`;
  const pct = (x) => `${x > 0 ? "+" : ""}${Math.round(x * 1000) / 10}%`;
  const names = (xs) => xs.map((a) => esc(a.label || a.name)).join(", ");
  return list.map((x, i) => {
    const head = x.kind === "sell" ? `${callBadge("SELL")} Sell ${esc(x.a.name)}` : `${callBadge("BUY")} Buy ${esc(x.a.name)} <span class="muted">from ${teamHtml(x.a.roster_id)}</span>`;
    if (!x.deal) return `<div class="trade-log idea"><h4>${head}</h4><p class="muted">${esc(x.why)}. No deal passes the fair line for both teams right now.</p></div>`;
    const d = x.deal;
    return `<div class="trade-log idea"><h4>${head}</h4><p class="muted">${esc(x.why)}.</p>
      <p><b>Deal with ${teamHtml(d.B)}:</b> you get ${names(d.gets)}; you send ${names(d.gives)}.</p>
      <p class="muted">Market ${pct(d.mkt)} for you · your goal ${pct(d.mine)} · their needs ${pct(d.them)} · your lineup ${d.dMe >= 0 ? "+" : ""}${d.dMe.toFixed(1)} pts/wk · record ${recordText(d.rec.me[0])} → ${recordText(d.rec.me[1])}</p>
      <button class="chip idea-open" data-i="${i}">Open in Trade Calculator</button></div>`;
  }).join("");
}

document.addEventListener("click", (e) => {
  const run = e.target.closest("#ideas-run");
  if (run) {
    run.disabled = true;
    $("#ideas-out").innerHTML = `<p class="muted">Working…</p>`;
    runIdeas((list) => { ideas.list = list; ideas.league = state.data.league.id; $("#ideas-out").innerHTML = ideasHtml(list); run.disabled = false; });
    return;
  }
  const b = e.target.closest(".idea-open");
  if (!b || !ideas.list) return;
  const x = ideas.list[Number(b.dataset.i)];
  if (!x || !x.deal) return;
  finder.me = myTeam().roster_id;
  openInCalculator(x.deal);
});

// ---------- league & sources ----------
function renderLeague() {
  const lg = state.data.league, f = lg.format;
  const payouts = Object.entries(lg.payouts || {}).filter(([k]) => k !== "notes").map(([k, v]) => `${esc(k)}: $${esc(v)}`).join(" · ");
  const sources = state.data.sources
    .map((s) => `<tr><td>${esc(s.source)}</td><td>${s.ok ? "✓" : "✗"}</td><td class="num">${s.ok ? `${s.matched}/${s.players}` : ""}</td><td class="num">${s.picks ?? ""}</td><td class="muted">${esc(s.error || (s.reference && s.reference !== s.source ? `scaled to ${s.reference}` : s.ok ? "reference scale" : ""))}</td></tr>`)
    .join("");
  const repl = Object.entries(state.data.model.replacement_ppg || {}).map(([k, v]) => `${k} ${v}`).join(" · ");
  const scoring = Object.entries(lg.scoring || {}).filter(([, v]) => v).map(([k, v]) => `<span class="kv">${esc(k)} <b>${v}</b></span>`).join("");
  $("#league-info").innerHTML = `
    <div class="stats">
      <div><label>Teams</label><b>${f.num_teams}</b></div>
      <div><label>QB</label><b>${f.superflex ? "Superflex" : "1QB"}</b></div>
      <div><label>PPR</label><b>${f.ppr}</b></div>
      <div><label>TE premium</label><b>${f.te_premium || 0}</b></div>
      <div><label>Pass TD</label><b>${f.pass_td}</b></div>
      <div><label>IDP</label><b>${f.idp ? "Yes" : "No"}</b></div>
      <div><label>Buy-in</label><b>$${esc(lg.buy_in ?? 0)}</b></div>
    </div>
    ${payouts ? `<p>Payouts: ${payouts}</p>` : ""}${lg.payouts && lg.payouts.notes ? `<p class="muted">${esc(lg.payouts.notes)}</p>` : ""}
    <p>Starting lineup: ${f.starting_slots.map(esc).join(", ")}</p>
    <p>Replacement level (PPG in this scoring): ${repl}</p>
    <h3>Market sources</h3>
    <table><thead><tr><th>Source</th><th>OK</th><th class="num">Matched</th><th class="num">Picks</th><th>Notes</th></tr></thead><tbody>${sources}</tbody></table>
    <h3>Scoring settings</h3><div class="scoring">${scoring}</div>
    <h3>How values are built</h3>
    <ol class="muted">
      <li>Market: FantasyCalc (queried for this exact team count, QB format and PPR), KeepTradeCut and DynastyProcess/FantasyPros values, each rescaled onto one curve and averaged.</li>
      <li>Scoring fit: each player's points per game under this league's exact scoring vs. generic scoring adjusts market value (TE premium, 6pt pass TDs, rush attempt and first-down points, etc.).</li>
      <li>Model: points over replacement, with replacement set by filling every lineup in this league, projected five years with age curves, then put on the market scale. IDP and kickers, which no market prices, come from this alone.</li>
      <li>Final value blends the scoring-adjusted market (60%) and the model (40%).</li>
    </ol>`;
}

// ---------- this week: live matchups, players of the week, movers, news ----------
// The build ships a snapshot (data.week); while the Matchups tab is open the page
// refreshes scores from Sleeper and game clocks from ESPN every minute.
const LIVE_MS = 60000;
const LEAGUE_GAME = 3600;

function playerOf(id) {
  return state.assetMap.get(id) || { id, name: /^[A-Z]{2,3}$/.test(id) ? `${id} D/ST` : id, pos: /^[A-Z]{2,3}$/.test(id) ? "DEF" : "", team: /^[A-Z]{2,3}$/.test(id) ? id : null };
}
const myTeam = () => state.data.teams.find((t) => t.is_me);
const ownerTag = (rid) => (rid ? teamHtml(rid) : '<span class="muted">FA</span>');
const starMine = (rid) => (myTeam() && rid === myTeam().roster_id ? ' <span class="mine" title="Your player">★</span>' : "");

function setupWeek() {
  const wk = state.data.week || {};
  if (state.live) clearTimeout(state.live.timer); // previous league's polling
  state.live = { week: wk.week, matchups: wk.matchups || [], games: clockFromKickoff(wk.games || {}), at: null, source: "snapshot", open: new Set() };
  const mine = myTeam();
  if (mine) state.live.open.add(mine.roster_id);
  renderMatchups();
  renderPlayersOfWeek();
  renderMovers();
  renderNews();
  refreshLive();
}

async function refreshLive() {
  const lg = state.data.league, L = state.live;
  if (!L.week) return;
  const leagueId = lg.sleeper_league_id;
  try {
    // A hung request must not hold up the other one or the next poll.
    const get = (u) => fetch(u, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
    const [rows, board] = await Promise.all([
      get(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${L.week}`).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      get(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${L.week}&dates=${state.data.week.season}`)
        .then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (state.live !== L) return; // league switched meanwhile
    L.matchups = rows.map((r) => ({ roster_id: r.roster_id, matchup_id: r.matchup_id, points: r.points, starters: r.starters, players_points: r.players_points }));
    L.games = board ? gameStatus(board) : clockFromKickoff(state.data.week.games || {});
    L.at = new Date();
    L.source = "live";
  } catch (e) {
    L.source = "snapshot";
    L.games = clockFromKickoff(state.data.week.games || {});
  }
  renderMatchups();
  renderPlayersOfWeek();
  if (state.live !== L) return; // league switched while this was loading
  clearTimeout(L.timer);
  // Poll only while the Matchups tab is on screen; check again a minute later otherwise.
  const tick = () => (!document.hidden && !$("#tab-matchups").classList.contains("hidden") ? refreshLive() : (L.timer = setTimeout(tick, LIVE_MS)));
  L.timer = setTimeout(tick, LIVE_MS);
}

// Mirrors engine/weekly.py game_status.
function gameStatus(board) {
  const out = {};
  for (const ev of board.events || []) {
    const comp = (ev.competitions || [{}])[0];
    const st = comp.status || ev.status || {};
    const state_ = (st.type || {}).state || "pre";
    let left = state_ === "pre" ? 1 : state_ === "post" ? 0 : 0;
    if (state_ === "in") {
      const period = Number(st.period || 1), clock = Number(st.clock || 0);
      left = period <= 4 ? Math.max(0, Math.min(1, ((4 - period) * 900 + clock) / LEAGUE_GAME)) : 0.03;
    }
    const teams = (comp.competitors || []).map((c) => (c.team.abbreviation === "WSH" ? "WAS" : c.team.abbreviation));
    teams.forEach((t, i) => (out[t] = { state: state_, left, label: (st.type || {}).shortDetail || "", kickoff: ev.date, opp: teams[1 - i] }));
  }
  return out;
}

// When ESPN can't be reached from the browser, the build's game status goes stale
// during games, so estimate what's left from kickoff time (a game runs ~3h10m).
const GAME_WALL_MS = 190 * 60000;
function clockFromKickoff(games) {
  const out = {}, now = Date.now();
  for (const [team, g] of Object.entries(games)) {
    const k = Date.parse(g.kickoff);
    if (g.state === "post" || !k || now < k) { out[team] = g; continue; }
    const est = Math.max(0, 1 - (now - k) / GAME_WALL_MS);
    const left = g.state === "in" ? Math.min(g.left, est) : est;
    out[team] = left > 0
      ? { ...g, state: "in", left, label: `in progress (est. ${Math.round(left * 100)}% left)` }
      : { ...g, state: "post", left: 0, label: "Final (est.)" };
  }
  return out;
}

// One side of a matchup: points so far, what its starters still project, and who's left.
function sideOf(row) {
  const sameWeek = state.live.week === (state.data.week || {}).week;
  const starters = (row.starters || []).filter((id) => id && id !== "0").map((id) => {
    const p = playerOf(id);
    const g = state.live.games[p.team] || null;
    const pts = (row.players_points || {})[id] || 0;
    const full = (sameWeek && p.proj_week != null ? p.proj_week : p.ros_ppg) || 0;
    // No game found for his team: a bye, or ESPN unavailable (then guess from points so far).
    const left = g ? g.left : Object.keys(state.live.games).length ? 0 : pts ? 0 : 1;
    return { p, pts, full, left, rem: full * left, status: g ? (g.state === "pre" ? new Date(g.kickoff).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : g.label) : Object.keys(state.live.games).length ? "Bye / no game" : "" };
  });
  const rem = starters.reduce((t, x) => t + x.rem, 0), full = starters.reduce((t, x) => t + x.full, 0);
  return { rid: row.roster_id, points: row.points || 0, rem, proj: (row.points || 0) + rem, full, starters, left: starters.filter((x) => x.left > 0).length };
}

function matchupPairs() {
  const by = {};
  for (const r of state.live.matchups) if (r.matchup_id != null) (by[r.matchup_id] = by[r.matchup_id] || []).push(r);
  const mine = myTeam();
  return Object.values(by).filter((x) => x.length === 2)
    .map((pair) => (mine && pair[1].roster_id === mine.roster_id ? [pair[1], pair[0]] : pair))
    .sort((a, b) => (mine ? (b[0].roster_id === mine.roster_id) - (a[0].roster_id === mine.roster_id) : 0));
}

function winOdds(a, b) {
  const sigma = (state.data.schedule || {}).sigma || 25;
  // Spread shrinks as the week plays out: what's left is the only uncertainty.
  const sd = (s) => sigma * Math.sqrt(s.full > 0 ? Math.min(1, s.rem / s.full) : 0);
  const spread = Math.sqrt(sd(a) ** 2 + sd(b) ** 2);
  if (spread < 1e-6) return a.proj > b.proj ? 1 : a.proj < b.proj ? 0 : 0.5;
  return 0.5 * (1 + erf((a.proj - b.proj) / (spread * Math.SQRT2)));
}

function renderMatchups() {
  const el = $("#matchups");
  const L = state.live;
  if (!L.week) { el.innerHTML = `<p class="muted">No regular-season week in progress.</p>`; return; }
  const pairs = matchupPairs();
  const when = L.at ? `live from Sleeper, updated ${L.at.toLocaleTimeString()}` : `snapshot from ${new Date(state.data.generated_at).toLocaleString()} (live scores load when Sleeper is reachable)`;
  const sideHtml = (s, odds) => `<div class="side"><div class="team">${teamHtml(s.rid)}${starMine(s.rid)}</div>
      <div class="score">${s.points.toFixed(2)}</div>
      <div class="muted">proj ${s.proj.toFixed(1)} · ${s.left} left · ${Math.round(odds * 100)}% to win</div></div>`;
  const lineup = (s) => `<div><table class="lineup"><thead><tr><th>Player</th><th>Game</th><th class="num">Pts</th><th class="num">Proj</th><th class="num">Left</th></tr></thead><tbody>${s.starters
      .map((x) => `<tr class="${x.left > 0 ? "" : "done"}"><td><span class="pos pos-${x.p.pos}">${x.p.pos}</span> ${face(x.p.id)}${esc(x.p.name)} <span class="muted">${esc(x.p.team || "")}</span></td>
        <td class="muted">${esc(x.status)}</td><td class="num strong">${x.pts.toFixed(2)}</td><td class="num">${x.full.toFixed(1)}</td><td class="num">${x.left > 0 ? x.rem.toFixed(1) : ""}</td></tr>`)
      .join("")}</tbody></table></div>`;
  el.innerHTML = `<p class="muted">Week ${L.week} · ${when}. Projected final = points so far plus each starter's projection for the part of his game still to play.</p>` +
    (pairs.length ? pairs.map(([a, b]) => {
      const A = sideOf(a), B = sideOf(b), pa = winOdds(A, B);
      const open = L.open.has(A.rid) || L.open.has(B.rid);
      return `<div class="matchup ${open ? "open" : ""}" data-rid="${A.rid}">
        <div class="head">${sideHtml(A, pa)}<div class="vs"><div class="odds"><div style="width:${pa * 100}%"></div></div></div>${sideHtml(B, 1 - pa)}</div>
        ${open ? `<div class="lineups">${lineup(A)}${lineup(B)}</div>` : `<div class="muted expand">Show lineups</div>`}</div>`;
    }).join("") : `<p class="muted">Sleeper has no matchups for week ${L.week} in this league.</p>`);
  el.querySelectorAll(".matchup .head, .matchup .expand").forEach((h) =>
    h.addEventListener("click", () => {
      const rid = Number(h.closest(".matchup").dataset.rid);
      L.open.has(rid) ? L.open.delete(rid) : L.open.add(rid);
      renderMatchups();
    })
  );
}

function potwTable(rows, id) {
  return `<table id="${id}"><thead><tr><th>#</th><th>Player</th><th>Pos</th><th>NFL</th><th class="num">Pts</th><th>Owner</th></tr></thead><tbody>${rows
    .map((r, i) => `<tr><td>${i + 1}</td><td class="name">${esc(r.name)}${starMine(r.roster_id)}</td><td><span class="pos pos-${r.pos}">${r.pos}</span></td>
      <td>${esc(r.team || "")}</td><td class="num strong">${r.pts.toFixed(2)}</td><td>${ownerTag(r.roster_id)}</td></tr>`)
    .join("")}</tbody></table>`;
}
function byPosition(rows, n = 3) {
  const out = {};
  rows.forEach((r) => { if ((out[r.pos] = out[r.pos] || []).length < n) out[r.pos].push(r); });
  return out;
}
function posCards(groups) {
  return `<div class="cols">${Object.entries(groups).sort((a, b) => POSITIONS.indexOf(a[0]) - POSITIONS.indexOf(b[0]))
    .map(([pos, rs]) => `<div class="card"><h4>${pos}</h4><ul>${rs.map((r) => `<li><span>${esc(r.name)}${starMine(r.roster_id)} <span class="muted">${ownerTag(r.roster_id)}</span></span><span class="num">${r.pts.toFixed(1)}</span></li>`).join("")}</ul></div>`)
    .join("")}</div>`;
}

function renderPlayersOfWeek() {
  const wk = state.data.week || {};
  // This week: every rostered player's points so far in this league's scoring (Sleeper's players_points).
  const seen = new Map();
  for (const r of state.live.matchups) for (const [id, pts] of Object.entries(r.players_points || {})) {
    const p = playerOf(id);
    if (pts > 0) seen.set(id, { id, name: p.name, pos: p.pos, team: p.team, pts, roster_id: r.roster_id });
  }
  const now = [...seen.values()].sort((a, b) => b.pts - a.pts);
  const last = (wk.potw_last || {}).overall || [];
  $("#potw").innerHTML = !wk.week ? `<p class="muted">No regular-season week in progress.</p>` : `
    <h3>Week ${state.live.week} so far <span class="muted">(rostered players, ${state.live.source === "live" ? "live" : "as of the last build"})</span></h3>
    ${now.length ? posCards(byPosition(now)) + `<div class="table-wrap">${potwTable(now.slice(0, 15), "potw-now")}</div>` : `<p class="muted">No points scored yet this week.</p>`}
    ${wk.last_week ? `<h3>Week ${wk.last_week} final <span class="muted">(everyone, free agents included)</span></h3>
      ${posCards(Object.fromEntries(Object.entries((wk.potw_last || {}).by_position || {}).map(([k, v]) => [k, v.slice(0, 3)])))}
      <div class="table-wrap">${potwTable(last, "potw-last")}</div>` : ""}`;
}

function renderMovers() {
  const mv = (state.data.week || {}).movers;
  if (!mv) { $("#movers").innerHTML = ""; return; }
  const src = mv.source.kind === "history"
    ? `Change in this league's value over the last ${mv.source.days} days (since ${mv.source.since}).`
    : `Market trend over the last 30 days (FantasyCalc) until a week of this site's own daily values has built up; then it switches to 7-day changes in this league's values.`;
  const table = (rows, id) => `<table id="${id}"><thead><tr><th>Player</th><th>Pos</th><th>Owner</th><th class="num">Value</th><th class="num">Change</th><th class="num">%</th></tr></thead><tbody>${rows
    .map((r) => { const p = playerOf(r.id); return `<tr><td class="name">${esc(p.name)}${starMine(p.roster_id)}</td><td><span class="pos pos-${p.pos}">${p.pos}${p.pos_rank || ""}</span></td>
      <td>${ownerTag(p.roster_id)}</td><td class="num">${fmt(r.now)}</td><td class="num ${r.change > 0 ? "up" : "down"}">${r.change > 0 ? "+" : ""}${fmt(r.change)}</td><td class="num ${r.change > 0 ? "up" : "down"}">${r.pct > 0 ? "+" : ""}${r.pct}%</td></tr>`; })
    .join("")}</tbody></table>`;
  $("#movers").innerHTML = `<p class="muted">${src}</p><div class="cols two"><div><h3>Risers</h3><div class="table-wrap">${table(mv.risers, "risers")}</div></div>
    <div><h3>Fallers</h3><div class="table-wrap">${table(mv.fallers, "fallers")}</div></div></div>`;
}

function renderNews() {
  const wk = state.data.week || {};
  const mine = myTeam();
  const isMine = (ids) => mine && ids.some((id) => (playerOf(id).roster_id) === mine.roster_id);
  const news = [...(wk.news || [])].sort((a, b) => isMine(b.players) - isMine(a.players) || (b.published || "").localeCompare(a.published || ""));
  const inj = [...(wk.injuries || [])].sort((a, b) => isMine([b.id]) - isMine([a.id]));
  const ago = (iso) => { const h = (Date.now() - new Date(iso)) / 36e5; return h < 1 ? "just now" : h < 24 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`; };
  $("#news").innerHTML = `
    <h3>Injury report <span class="muted">(rostered players, from Sleeper${mine ? "; yours first" : ""})</span></h3>
    ${inj.length ? `<div class="table-wrap"><table id="injuries"><thead><tr><th>Player</th><th>Pos</th><th>Status</th><th>Injury</th><th>Owner</th></tr></thead><tbody>${inj
      .map((i) => { const p = playerOf(i.id); return `<tr><td class="name">${esc(p.name)}${starMine(p.roster_id)}</td><td><span class="pos pos-${p.pos}">${p.pos}</span></td><td><span class="inj">${esc(i.status)}</span></td><td>${esc(i.body_part || "")}${i.notes ? ` <span class="muted">${esc(i.notes)}</span>` : ""}</td><td>${ownerTag(p.roster_id)}</td></tr>`; })
      .join("")}</tbody></table></div>` : `<p class="muted">No rostered player carries an injury designation.</p>`}
    <h3>Headlines <span class="muted">(ESPN, stories about players rostered in this league${mine ? "; yours first" : ""})</span></h3>
    ${news.length ? `<ul class="news">${news.map((n) => `<li class="${isMine(n.players) ? "mine-row" : ""}">
        <a href="${esc(n.url || "#")}" target="_blank" rel="noopener">${esc(n.headline)}</a>
        <div class="muted">${n.players.map((id) => { const p = playerOf(id); return `${esc(p.name)} (${ownerTag(p.roster_id)})`; }).join(", ")}${n.published ? ` · ${ago(n.published)}` : ""}</div>
        ${n.description ? `<div>${esc(n.description)}</div>` : ""}</li>`).join("")}</ul>` : `<p class="muted">No recent ESPN stories about players in this league.</p>`}`;
}

// ---------- trade finder ----------
// Pick your team, what you must send and/or get, the pieces you're OK adding, how
// many pieces and which positions you want back, and a goal. The finder only ever
// offers what you picked: "You send" always goes, "OK to add" may be added, and
// nothing else from your roster is touched. From the partner it adds pieces in the
// positions you asked for. It keeps deals within the fair line at market for both
// teams (with the value adjustment), even or better for the partner by its own
// situation, good for your goal, and sensible for both directions: a contender
// isn't asked to gut its lineup, a rebuilder isn't handed old veterans, and your
// lineup doesn't drop when you're contending. Contend: points now count more, picks
// and stashed youth less. Rebuild: picks and young players count more, veterans
// (running backs soonest) less. Balanced: your own team lens from the build.
const FINDER_POOL = 18;   // partner assets it considers adding
const FINDER_SHOW = 12;
const FINDER_MAX_ADD = 3; // most partner pieces added beyond the ones you named
const finder = { me: null, partners: [], goal: null, target: null, mode: 2, winBy: 0, three: { teams: [null, null], goals: ["auto", "auto"] },
  send: [], offer: [], get: [], getMax: null, sendMax: null, positions: [], openAll: false };
const FINDER_AIM_POOL = 150; // candidates checked for movement toward the build you aim for
// "Win by": 0 keeps every deal within the fair line. Otherwise you come out ahead at
// market by about that much (within WIN_BAND either way), and each partner may give
// up to that much plus the fair line, still judged by its own situation.
const WIN_BY = [0, 0.05, 0.1, 0.15, 0.2, 0.25];
const WIN_BAND = 0.025;
const myMarketFits = (net) => (finder.winBy ? Math.abs(net - finder.winBy) <= WIN_BAND : Math.abs(net) <= FAIR_MARGIN);
const theirMarketFits = (net) => (finder.winBy ? net >= -(finder.winBy + FAIR_MARGIN) && net <= FAIR_MARGIN : Math.abs(net) <= FAIR_MARGIN);
const theirFloor = () => -(finder.winBy + FAIR_MARGIN);
const OLD_FOR_REBUILD = (a) => a.kind === "player" && (a.age || 0) >= (a.pos === "RB" ? 26 : 28);

function goalFactor(a, goal, rid, startsForMe) {
  if (goal === "balanced") return teamFactor(rid, a.id);
  const firstYear = Math.min(...state.data.picks.map((p) => p.year));
  if (a.kind === "pick") {
    const soon = a.year === firstYear;
    if (goal === "contend") return soon ? 0.8 : 0.7;
    return soon ? (a.round === 1 ? 1.3 : 1.2) : 1.15;
  }
  const age = a.age || 26;
  if (goal === "contend") {
    if (startsForMe.has(a.id)) return age >= 29 ? 1.2 : 1.15;
    return age <= 23 ? 0.85 : 0.95;
  }
  const old = age + (a.pos === "RB" ? 2 : 0); // running backs age out sooner
  return old <= 23 ? 1.2 : old <= 25 ? 1.1 : old <= 27 ? 1.0 : old <= 29 ? 0.85 : 0.7;
}

// Untouchables: players and picks the finder (and the trade ideas) never offer from
// your side unless you add them to "You send" yourself. Kept in this browser per team.
const lockKey = (rid) => `untouchable.${state.data.league.id}.${rid}`;
function lockedIds(rid = finder.me ?? myTeam()?.roster_id) {
  try { return new Set(JSON.parse(localStorageGet(lockKey(rid)) || "[]")); } catch { return new Set(); }
}
function untouchable(id, rid) { return lockedIds(rid).has(id); }
function setLocked(rid, ids) { localStorageSet(lockKey(rid), JSON.stringify([...ids])); }

// ---------- manager profiles ----------
// Two halves. Their trade history comes from the league's public Sleeper trades and
// is worked out here in the browser. Your notes on each manager (won't trade with
// you, picks only, players they won't move) live only in this browser, like the
// untouchable list; the "won't move" list is that manager's untouchable list.
const profileKey = (rid) => `profile.${state.data.league.id}.${rid}`;
function managerNotes(rid) {
  try { return { block: false, picksOnly: false, ...JSON.parse(localStorageGet(profileKey(rid)) || "{}") }; } catch { return { block: false, picksOnly: false }; }
}
function setManagerNotes(rid, notes) { localStorageSet(profileKey(rid), JSON.stringify(notes)); }
const blockedPartner = (rid) => rid !== finder.me && managerNotes(rid).block;

function managerHistory(rid) {
  const me = myTeam()?.roster_id;
  const ageOf = (id) => { const p = state.data.players.find((x) => x.id === id); return p && p.age ? p.age : null; };
  const h = { trades: 0, withMe: 0, picksIn: 0, picksOut: 0, agesIn: [], agesOut: [], posIn: {}, last: null, partners: {} };
  for (const t of state.data.trades || []) {
    if (!t.rosters || !t.rosters.includes(rid)) continue;
    h.trades++;
    if (me != null && me !== rid && t.rosters.includes(me)) h.withMe++;
    if (!h.last || t.at > h.last) h.last = t.at;
    t.rosters.filter((r) => r !== rid).forEach((r) => (h.partners[r] = (h.partners[r] || 0) + 1));
    for (const m of t.moves || []) {
      if (m.to === rid) {
        if (m.kind === "pick") h.picksIn++;
        else { const a = ageOf(m.id); if (a) h.agesIn.push(a); if (m.pos) h.posIn[m.pos] = (h.posIn[m.pos] || 0) + 1; }
      } else if (m.from === rid) {
        if (m.kind === "pick") h.picksOut++;
        else { const a = ageOf(m.id); if (a) h.agesOut.push(a); }
      }
    }
  }
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  h.ageIn = avg(h.agesIn); h.ageOut = avg(h.agesOut);
  h.buysPicks = h.picksIn - h.picksOut >= 2;
  h.sellsPicks = h.picksOut - h.picksIn >= 2;
  h.younger = h.ageIn != null && h.ageOut != null && h.ageOut - h.ageIn >= 1.5;
  h.older = h.ageIn != null && h.ageOut != null && h.ageIn - h.ageOut >= 1.5;
  const top = Object.entries(h.posIn).sort((a, b) => b[1] - a[1])[0];
  h.topPos = top && top[1] >= 2 ? top[0] : null;
  return h;
}
function historyText(h) {
  if (!h.trades) return "No trades this season.";
  const bits = [`${h.trades} trade${h.trades > 1 ? "s" : ""} this season`];
  if (h.buysPicks) bits.push(`buys picks (got ${h.picksIn}, sent ${h.picksOut})`);
  else if (h.sellsPicks) bits.push(`sells picks (sent ${h.picksOut}, got ${h.picksIn})`);
  if (h.younger) bits.push(`gets younger (adds ${h.ageIn.toFixed(1)}, sends ${h.ageOut.toFixed(1)} avg age)`);
  else if (h.older) bits.push(`buys veterans (adds ${h.ageIn.toFixed(1)}, sends ${h.ageOut.toFixed(1)} avg age)`);
  if (h.topPos) bits.push(`adds ${h.topPos} most`);
  if (myTeam()) bits.push(h.withMe ? `${h.withMe} with you` : "never with you");
  if (h.last) bits.push(`last ${new Date(h.last).toLocaleDateString()}`);
  return bits.join(" · ");
}
// How well a deal fits what a manager has done before: one point per habit it matches.
function historyFits(rid, theyGet, theySend) {
  const h = managerHistory(rid), fits = [];
  const ages = (xs) => xs.filter((a) => a.kind === "player" && a.age).map((a) => a.age);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  if (h.buysPicks && theyGet.some((a) => a.kind === "pick")) fits.push("they buy picks");
  if (h.sellsPicks && theySend.some((a) => a.kind === "pick")) fits.push("they sell picks");
  const gi = avg(ages(theyGet)), so = avg(ages(theySend));
  if (h.younger && gi != null && so != null && gi < so) fits.push("they like getting younger");
  if (h.older && gi != null && so != null && gi > so) fits.push("they buy veterans");
  if (h.topPos && theyGet.some((a) => a.pos === h.topPos)) fits.push(`they add ${h.topPos}s`);
  return fits;
}

// The Manager profiles panel in the Trade Finder: each other manager's trade history,
// plus your own notes, which the finder obeys.
function managersHtml() {
  const others = state.data.teams.filter((t) => t.roster_id !== finder.me);
  const rows = others.map((t) => {
    const rid = t.roster_id, n = managerNotes(rid), keeps = [...lockedIds(rid)].map(assetById).filter(Boolean);
    const theirs = [...state.assetMap.values()].filter((a) => a.roster_id === rid && a.value > 0).sort((a, b) => b.value - a.value);
    return `<div class="mgr-row ${n.block ? "blocked" : ""}" data-rid="${rid}">
      <div class="mgr-head">${teamAvatar(t)}<b>${esc(t.name)}</b>${managerOf(t) ? ` <span class="muted">${esc(managerOf(t))}</span>` : ""}</div>
      <p class="muted small">${esc(historyText(managerHistory(rid)))}</p>
      <div class="chips"><label class="chip"><input type="checkbox" data-note="block" ${n.block ? "checked" : ""}> Won't trade with me</label>
        <label class="chip"><input type="checkbox" data-note="picksOnly" ${n.picksOnly ? "checked" : ""}> Picks only from me</label></div>
      <input class="mgr-keep" type="search" placeholder="Won't move: add a piece" list="mgr-list-${rid}" />
      <datalist id="mgr-list-${rid}">${theirs.map((a) => `<option value="${esc(a.label)}"></option>`).join("")}</datalist>
      ${keeps.length ? `<ul class="assets">${keeps.map((a) => `<li><span>🔒 ${esc(a.label)}</span><span class="num">${fmt(a.value)}</span><button data-keep-off="${esc(a.id)}" aria-label="Remove">×</button></li>`).join("")}</ul>` : ""}
    </div>`;
  }).join("");
  const noted = others.filter((t) => { const n = managerNotes(t.roster_id); return n.block || n.picksOnly || lockedIds(t.roster_id).size; }).length;
  return `<details class="card managers" ${finder.mgrOpen ? "open" : ""}><summary>Manager profiles <span class="muted">(${noted ? `${noted} with your notes` : "add notes the finder will follow"})</span></summary>
    <p class="muted">Trade history comes from this season's trades in this league on Sleeper. Your notes stay in this browser only. The finder skips managers who won't trade with you, sends only picks to "picks only" managers, never asks for a piece they won't move, and ranks deals that match a manager's habits a little higher.</p>
    <div class="mgr-grid">${rows}</div></details>`;
}
function bindManagers(el) {
  const box = el.querySelector("details.managers");
  if (!box) return;
  box.addEventListener("toggle", () => (finder.mgrOpen = box.open));
  box.querySelectorAll(".mgr-row").forEach((row) => {
    const rid = Number(row.dataset.rid);
    row.querySelectorAll("[data-note]").forEach((c) => (c.onchange = () => { const n = managerNotes(rid); n[c.dataset.note] = c.checked; setManagerNotes(rid, n); finder.last = null; renderFinder(); }));
    row.querySelector(".mgr-keep").onchange = (e) => {
      const a = [...state.assetMap.values()].find((x) => x.roster_id === rid && (x.label === e.target.value || x.name === e.target.value));
      if (a) { const ids = lockedIds(rid); ids.add(a.id); setLocked(rid, ids); finder.get = finder.get.filter((id) => id !== a.id); finder.last = null; }
      renderFinder();
    };
    row.querySelectorAll("[data-keep-off]").forEach((b) => (b.onclick = () => { const ids = lockedIds(rid); ids.delete(b.dataset.keepOff); setLocked(rid, ids); finder.last = null; renderFinder(); }));
  });
}

function renderFinder() {
  const el = $("#finder");
  if (!el) return;
  const teams = state.data.teams;
  if (finder.me == null || !teamOf(finder.me)) {
    finder.me = (myTeam() || teams[0]).roster_id;
    finder.partners = []; finder.send = []; finder.offer = []; finder.get = [];
  }
  if (!finder.goal) {
    const c = teamCtx(finder.me);
    finder.goal = c && c.label === "contending" ? "contend" : c && (c.label === "rebuilding" || c.label === "tanking") ? "rebuild" : "balanced";
  }
  const locked = lockedIds(finder.me);
  const opt = (sel, any) => (any ? `<option value="">Any team</option>` : "") + teams.map((t) => `<option value="${t.roster_id}" ${t.roster_id === sel ? "selected" : ""}>${esc(teamName(t.roster_id))}</option>`).join("");
  const mine = [...state.assetMap.values()].filter((a) => a.roster_id === finder.me && a.value > 0).sort((a, b) => b.value - a.value);
  const theirs = [...state.assetMap.values()].filter((a) => a.roster_id != null && a.roster_id !== finder.me && a.value > 0
    && (finder.mode === 3 ? finder.three.teams.includes(a.roster_id) : !finder.partners.length || finder.partners.includes(a.roster_id))).sort((a, b) => b.value - a.value).slice(0, 600);
  const chips = (ids, kind) => ids.map(assetById).filter(Boolean).map((a) => `<li><span>${face(a.id)}${esc(a.label)}${kind === "get" ? ` <span class="muted">${esc(teamName(a.roster_id))}</span>` : ""}</span><span class="num">${fmt(a.value)}</span><button data-kind="${kind}" data-id="${esc(a.id)}" aria-label="Remove">×</button></li>`).join("");
  const posList = [...new Set(["QB", "RB", "WR", "TE", ...roomPositions()])].filter((p) => POSITIONS.includes(p)).concat("PICK");
  const countChips = (key, opts) => opts.map((k) => `<button class="chip ${finder[key] === k ? "active" : ""}" data-count="${key}" data-k="${k ?? ""}">${k == null ? "Any" : k}</button>`).join("");
  const myStarters = new Set(bestLineup(rosterOf(finder.me), "ros_ppg").map((x) => x.p.id));
  const buildsNow = assignBuilds();
  const goalOptions = (sel) => [["auto", "Goal: their own situation"], ["contend", "Goal: contend now"], ["rebuild", "Goal: rebuild"], ["balanced", "Goal: balanced"]]
    .concat(Object.keys(BUILD_INFO).map((k) => [`aim:${k}`, `Aim for: ${BUILD_INFO[k][0]}`]))
    .map(([v, l]) => `<option value="${v}" ${sel === v ? "selected" : ""}>${esc(l)}</option>`).join("");
  el.innerHTML = `<div class="toolbar"><span class="muted">Deal size</span><div class="chips" id="finder-mode">${[2, 3].map((k) => `<button class="chip ${finder.mode === k ? "active" : ""}" data-mode="${k}">${k} teams</button>`).join("")}</div></div>
    <p class="muted">The finder only offers what you pick. "You send" is always in the deal; "OK to add" pieces may be added; nothing else of yours is touched. It keeps deals within ${Math.round(FAIR_MARGIN * 100)}% at market for both teams (with the value adjustment), even or better for the other team by its own situation, and good for your goal.</p>
    <div class="finder-grid">
      <div class="trade-side"><h3>Your team</h3><select id="finder-me" aria-label="Your team">${opt(finder.me, false)}</select>
        <div class="needs muted">${esc(situationText(finder.me))}</div>
        <h4>You send <span class="muted">(always in the deal)</span></h4><input id="finder-send" type="search" placeholder="Add your player or pick" list="finder-send-list" /><datalist id="finder-send-list">${mine.map((a) => `<option value="${esc(a.label)}">${fmt(a.value)}</option>`).join("")}</datalist>
        <ul class="assets">${chips(finder.send, "send")}</ul>
        <h4>OK to add <span class="muted">(the finder may use these)</span></h4><input id="finder-offer" type="search" placeholder="Add a piece you'd part with" list="finder-send-list" />
        <div class="chips small"><button class="chip" id="offer-picks">+ my picks</button><button class="chip" id="offer-bench">+ my bench</button><button class="chip" id="offer-clear">clear</button></div>
        <ul class="assets">${chips(finder.offer, "offer") || `<li><span class="muted">Nothing yet. Only "You send" will be offered.</span></li>`}</ul></div>
      <div class="trade-side">${finder.mode === 3 ? `<h3>Trade with <span class="muted">(two teams, each with its own goal)</span></h3>
        ${[0, 1].map((k) => `<div class="three-pick"><select class="three-team" data-k="${k}" aria-label="Team ${k + 2}"><option value="">Pick team ${k + 2}</option>${teams.filter((t) => t.roster_id !== finder.me)
          .map((t) => `<option value="${t.roster_id}" ${finder.three.teams[k] === t.roster_id ? "selected" : ""}>${esc(teamName(t.roster_id))}</option>`).join("")}</select>
          <select class="three-goal" data-k="${k}" aria-label="Team ${k + 2} goal">${goalOptions(finder.three.goals[k])}</select>
          ${finder.three.teams[k] != null ? `<span class="muted">now ${esc(buildsNow[finder.three.teams[k]]?.name || "")}</span>` : ""}</div>`).join("")}`
      : `<h3>Trade with <span class="muted">(pick one or more; none = every team)</span></h3>
        <div class="chips small" id="finder-partners"><button class="chip ${finder.partners.length ? "" : "active"}" data-partner="">All teams</button>${teams.filter((t) => t.roster_id !== finder.me)
          .map((t) => `<button class="chip ${finder.partners.includes(t.roster_id) ? "active" : ""}" data-partner="${t.roster_id}">${esc(teamName(t.roster_id))}</button>`).join("")}</div>`}
        <h4>You get <span class="muted">(must be in the deal)</span></h4><input id="finder-get" type="search" placeholder="Add a player or pick you want" list="finder-get-list" /><datalist id="finder-get-list">${theirs.map((a) => `<option value="${esc(a.label)}">${fmt(a.value)} · ${esc(teamName(a.roster_id))}</option>`).join("")}</datalist>
        <ul class="assets">${chips(finder.get, "get")}</ul>
        <h4>Positions you want back</h4><div class="chips" id="finder-pos">${posList.map((p) => `<button class="chip ${finder.positions.includes(p) ? "active" : ""}" data-pos="${p}">${p}</button>`).join("")}</div>
        <p class="muted">${finder.positions.length ? `Only ${finder.positions.join(", ")} come back, and at least one of them.` : "Any position. Tap to limit what comes back."}</p>
        <h4>Pieces you get back</h4><div class="chips">${countChips("getMax", [null, 1, 2, 3, 4])}</div>
        <h4>Pieces you send, at most</h4><div class="chips">${countChips("sendMax", [null, 1, 2, 3, 4, 5])}</div></div>
    </div>
    <div class="trade-side untouchables"><h3>Untouchable <span class="muted">(can't be added to "OK to add")</span></h3>
      <input id="finder-lock" type="search" placeholder="Lock a player or pick" list="finder-send-list" />
      <ul class="assets">${[...locked].map(assetById).filter(Boolean).map((a) => `<li><span>🔒 ${esc(a.label)}</span><span class="num">${fmt(a.value)}</span><button data-unlock="${esc(a.id)}" aria-label="Unlock">×</button></li>`).join("") || `<li><span class="muted">Nothing locked yet.</span></li>`}</ul></div>
    ${managersHtml()}
    <div class="toolbar"><span class="muted">Your goal</span><div class="chips" id="finder-goal">${[["contend", "Contend now"], ["rebuild", "Rebuild"], ["balanced", "Balanced"]]
      .map(([k, l]) => `<button class="chip ${finder.goal === k ? "active" : ""}" data-goal="${k}">${l}</button>`).join("")}</div></div>
    <div class="toolbar"><span class="muted">Aim for <span class="aim-now">(you're ${esc(buildsNow[finder.me]?.name || "")} now)</span></span><div class="chips" id="finder-aim"><button class="chip ${finder.target ? "" : "active"}" data-aim="">Any build</button>${Object.keys(BUILD_INFO)
      .map((k) => `<button class="chip ${finder.target === k ? "active" : ""}" data-aim="${k}">${esc(BUILD_INFO[k][0])}</button>`).join("")}</div>
</div>
    <div class="toolbar"><span class="muted">Win by</span><div class="chips" id="finder-win">${WIN_BY.map((w) => `<button class="chip ${finder.winBy === w ? "active" : ""}" data-win="${w}">${w ? `${Math.round(w * 100)}%` : "Fair"}</button>`).join("")}</div>
      <button id="finder-run" class="chip active">Find trades</button></div>
    <div id="finder-out"></div>`;
  const reset = () => { finder.last = null; renderFinder(); };
  $("#finder-me").onchange = (e) => { finder.me = Number(e.target.value); finder.partners = finder.partners.filter((r) => r !== finder.me); finder.send = []; finder.offer = []; finder.get = finder.get.filter((id) => (assetById(id) || {}).roster_id !== finder.me); finder.goal = null; finder.three.teams = finder.three.teams.map((r) => (r === finder.me ? null : r)); reset(); };
  el.querySelectorAll("#finder-partners [data-partner]").forEach((b) => (b.onclick = () => {
    const rid = b.dataset.partner ? Number(b.dataset.partner) : null;
    if (rid == null) finder.partners = [];
    else finder.partners = finder.partners.includes(rid) ? finder.partners.filter((r) => r !== rid) : [...finder.partners, rid];
    if (finder.partners.length) finder.get = finder.get.filter((id) => finder.partners.includes((assetById(id) || {}).roster_id));
    reset();
  }));
  const pick = (input, list, kind) => {
    input.onchange = () => {
      const a = list.find((x) => x.label === input.value || x.name === input.value);
      const arr = finder[kind];
      if (a && !arr.includes(a.id) && !(kind === "offer" && locked.has(a.id))) {
        arr.push(a.id);
        // A piece is either always sent or optional, not both.
        if (kind === "send") finder.offer = finder.offer.filter((id) => id !== a.id);
        if (kind === "offer") finder.send = finder.send.filter((id) => id !== a.id);
        if (kind === "get" && finder.mode === 2) finder.partners = [a.roster_id]; // gets must all come from one team
        if (kind === "get") finder.get = finder.get.filter((id) => (assetById(id) || {}).roster_id === a.roster_id);
      }
      renderFinder();
    };
  };
  const addOffer = (xs) => { xs.forEach((a) => { if (!locked.has(a.id) && !finder.send.includes(a.id) && !finder.offer.includes(a.id)) finder.offer.push(a.id); }); renderFinder(); };
  $("#offer-picks").onclick = () => addOffer(mine.filter((a) => a.kind === "pick"));
  $("#offer-bench").onclick = () => addOffer(mine.filter((a) => a.kind === "player" && !myStarters.has(a.id) && a.value >= 150));
  $("#offer-clear").onclick = () => { finder.offer = []; renderFinder(); };
  $("#finder-lock").onchange = (e) => {
    const a = mine.find((x) => x.label === e.target.value || x.name === e.target.value);
    if (a) { const ids = lockedIds(finder.me); ids.add(a.id); setLocked(finder.me, ids); finder.offer = finder.offer.filter((id) => id !== a.id); }
    renderFinder();
  };
  el.querySelectorAll("[data-unlock]").forEach((b) => b.addEventListener("click", () => {
    const ids = lockedIds(finder.me); ids.delete(b.dataset.unlock); setLocked(finder.me, ids); renderFinder();
  }));
  bindManagers(el);
  pick($("#finder-send"), mine, "send");
  pick($("#finder-offer"), mine, "offer");
  pick($("#finder-get"), theirs, "get");
  el.querySelectorAll(".assets button[data-kind]").forEach((b) => b.addEventListener("click", () => {
    finder[b.dataset.kind] = finder[b.dataset.kind].filter((id) => id !== b.dataset.id); renderFinder();
  }));
  el.querySelectorAll("#finder-pos button").forEach((b) => b.addEventListener("click", () => {
    const p = b.dataset.pos;
    finder.positions = finder.positions.includes(p) ? finder.positions.filter((x) => x !== p) : [...finder.positions, p];
    renderFinder();
  }));
  el.querySelectorAll("[data-count]").forEach((b) => b.addEventListener("click", () => { finder[b.dataset.count] = b.dataset.k ? Number(b.dataset.k) : null; renderFinder(); }));
  el.querySelectorAll("#finder-goal button").forEach((b) => b.addEventListener("click", () => { finder.goal = b.dataset.goal; renderFinder(); }));
  el.querySelectorAll("#finder-mode [data-mode]").forEach((b) => (b.onclick = () => { finder.mode = Number(b.dataset.mode); reset(); }));
  el.querySelectorAll("#finder-win [data-win]").forEach((b) => (b.onclick = () => { finder.winBy = Number(b.dataset.win); reset(); }));
  el.querySelectorAll("#finder-aim [data-aim]").forEach((b) => (b.onclick = () => {
    finder.target = b.dataset.aim || null;
    if (finder.target) finder.goal = aimTone(finder.target);
    reset();
  }));
  el.querySelectorAll(".three-team").forEach((sel) => (sel.onchange = () => {
    const k = Number(sel.dataset.k);
    finder.three.teams[k] = sel.value ? Number(sel.value) : null;
    finder.get = finder.get.filter((id) => finder.three.teams.includes((assetById(id) || {}).roster_id));
    reset();
  }));
  el.querySelectorAll(".three-goal").forEach((sel) => (sel.onchange = () => { finder.three.goals[Number(sel.dataset.k)] = sel.value; finder.last = null; }));
  $("#finder-run").onclick = () => {
    $("#finder-out").innerHTML = `<p class="muted">Searching…</p>`;
    setTimeout(() => {
      finder.last = finder.mode === 3 ? findTrades3() : findTrades();
      $("#finder-out").innerHTML = finder.mode === 3 ? finderResults3(finder.last) : finderResults(finder.last);
    }, 20);
  };
}

const combosUpTo = (xs, k) => {
  const out = [[]];
  const rec = (start, cur) => {
    if (cur.length) out.push(cur);
    if (cur.length >= k) return;
    for (let i = start; i < xs.length; i++) rec(i + 1, [...cur, xs[i]]);
  };
  rec(0, []);
  return out;
};

function findTrades() {
  const me = finder.me, goal = finder.goal;
  const send = finder.send.map(assetById).filter(Boolean), get = finder.get.map(assetById).filter(Boolean);
  const locked = lockedIds(me);
  const sendIds = new Set(send.map((a) => a.id));
  const myRoster = rosterOf(me);
  const myPPG = teamPPG(myRoster);
  const startsForMe = new Set(bestLineup(myRoster, "ros_ppg").map((x) => x.p.id));
  // Your optional pieces: only what you listed as OK to add. The trade ideas (and
  // nothing else) may open the rest of your roster, still never an untouchable.
  const myExtra = (finder.openAll
    ? [...state.assetMap.values()].filter((a) => a.roster_id === me && a.value >= 150)
    : finder.offer.map(assetById).filter(Boolean))
    .filter((a) => a.roster_id === me && !sendIds.has(a.id) && !locked.has(a.id))
    .sort((a, b) => b.value - a.value).slice(0, 14);
  if (!send.length && !myExtra.length) return { error: get.length
    ? `Add what you'd send for ${get.map((a) => a.name).join(" and ")}: put pieces in "You send" or "OK to add". The finder never offers anything you didn't pick.`
    : "Add at least one player or pick to send, or to OK to add." };
  const sendRoom = finder.sendMax == null ? 4 : finder.sendMax - send.length;
  const getRoom = finder.getMax == null ? FINDER_MAX_ADD : finder.getMax - get.length;
  if (sendRoom < 0) return { error: `You named ${send.length} pieces to send but set at most ${finder.sendMax}.` };
  if (getRoom < 0) return { error: `You named ${get.length} pieces to get but set ${finder.getMax} back.` };
  const posOk = (a) => !finder.positions.length || finder.positions.includes(a.kind === "pick" ? "PICK" : a.pos);
  const crack = (p) => p.kind === "player" && p.ros_ppg > 0 && teamPPG([...myRoster, p]) - myPPG > 0.3;
  if (get.length && blockedPartner(get[0].roster_id)) return { error: `You noted that ${teamName(get[0].roster_id)} won't trade with you. Clear that in Manager profiles to look anyway.` };
  const partners = (get.length ? [get[0].roster_id] : finder.partners.length ? finder.partners.filter((r) => r !== me) : state.data.teams.map((t) => t.roster_id).filter((r) => r !== me))
    .filter((r) => !blockedPartner(r));
  if (!partners.length) return { error: "Every team you picked is marked \"won't trade with me\" in Manager profiles." };
  const dirs = assignBuilds();
  const extrasMine = combosUpTo(myExtra, Math.min(sendRoom, myExtra.length > 8 ? 2 : 3));
  const recBefore = projectRecords();
  const out = [];
  for (const B of partners) {
    const getIds = new Set(get.map((a) => a.id));
    const theirTone = dirs[B] && dirs[B].tone;
    const theirLocked = lockedIds(B), picksOnly = managerNotes(B).picksOnly;
    // A manager you noted takes only picks from you: no players of yours in the deal.
    if (picksOnly && send.some((a) => a.kind !== "pick")) continue;
    // What the partner could add: the positions you asked for, best fits for your goal first.
    const fitScore = (a) => a.value * goalFactor(a, goal, me, crack(a) ? new Set([a.id]) : new Set()) * (goal === "contend" && crack(a) ? 1.3 : 1);
    const pool = [...state.assetMap.values()].filter((a) => a.roster_id === B && a.value >= 150 && !getIds.has(a.id) && !theirLocked.has(a.id) && posOk(a)
      && !(goal === "rebuild" && OLD_FOR_REBUILD(a)))
      .sort((a, b) => fitScore(b) - fitScore(a)).slice(0, FINDER_POOL);
    const adds = combosUpTo(pool, Math.min(getRoom, FINDER_MAX_ADD));
    for (const add of adds) {
      const gets = [...get, ...add];
      if (!gets.length) continue;
      if (finder.getMax != null && gets.length !== finder.getMax) continue;
      if (finder.positions.length && !gets.some(posOk)) continue;
      for (const mx of extrasMine) {
        const gives = [...send, ...mx];
        if (!gives.length) continue;
        // A rebuilding partner doesn't want your old veterans as throw-ins.
        if (theirTone === "rebuilding" && mx.some(OLD_FOR_REBUILD)) continue;
        if (picksOnly && mx.some((a) => a.kind !== "pick")) continue;
        const mkt = netOf(gets, gives);
        if (!myMarketFits(mkt)) continue;
        const them = netOf(gives, gets, (a) => teamFactor(B, a.id));
        if (them < theirFloor()) continue;
        const crackSet = new Set(gets.filter(crack).map((a) => a.id));
        gives.forEach((a) => startsForMe.has(a.id) && crackSet.add(a.id));
        const mine = netOf(gets, gives, (a) => goalFactor(a, goal, me, crackSet));
        // A piece you named to get is your call, so the goal only ranks those deals.
        if (!get.length && mine < -FAIR_MARGIN) continue;
        out.push({ B, gets, gives, mkt, them, mine });
      }
    }
  }
  // Lineup and record effects for the best candidates only (the costly part).
  out.sort((a, b) => b.mine - a.mine || Math.abs(a.mkt) - Math.abs(b.mkt));
  const top = [];
  for (const d of out.slice(0, 800)) {
    const outIds = new Set(d.gives.map((a) => a.id)), inIds = new Set(d.gets.map((a) => a.id));
    const mineAfter = rosterOf(me).filter((p) => !outIds.has(p.id)).concat(d.gets.filter((a) => a.kind === "player"));
    const theirsAfter = rosterOf(d.B).filter((p) => !inIds.has(p.id)).concat(d.gives.filter((a) => a.kind === "player"));
    d.overrides = { [me]: mineAfter, [d.B]: theirsAfter };
    d.dMe = teamPPG(mineAfter) - myPPG;
    d.dThem = teamPPG(theirsAfter) - teamPPG(rosterOf(d.B));
    // Logical for both sides: a contender keeps its lineup, and so do you when contending.
    if (goal === "contend" && d.dMe < -0.3) continue;
    if (dirs[d.B] && dirs[d.B].tone === "contender" && d.dThem < -1.5) continue;
    const pieces = d.gets.length + d.gives.length;
    d.score = goal === "contend" ? d.dMe + 20 * d.mine + 5 * d.them - 0.4 * pieces
      : goal === "rebuild" ? 100 * d.mine + 10 * d.them - 0.15 * Math.max(0, -d.dMe) - 0.8 * pieces
      : 60 * d.mine + 0.5 * d.dMe + 15 * d.them - 0.6 * pieces;
    // Deals that look like what this manager has done before rank a little higher.
    d.fits = historyFits(d.B, d.gives, d.gets);
    d.score += 0.6 * d.fits.length;
    top.push(d);
  }
  top.sort((a, b) => b.score - a.score);
  // Aiming for a build: keep deals that land on it or move you toward it, closest first.
  if (finder.target) {
    const aimed = [];
    for (const d of top.slice(0, FINDER_AIM_POOL)) {
      const { overrides, pd } = dealAfter({ [me]: { gets: d.gets, gives: d.gives }, [d.B]: { gets: d.gives, gives: d.gets } });
      d.aim = aimProgress(dirs[me], assignBuilds(overrides, pd)[me], finder.target);
      if (d.aim.hit || d.aim.closer >= 0.005) aimed.push(d);
    }
    aimed.sort((a, b) => b.aim.hit - a.aim.hit || b.aim.closer - a.aim.closer || b.score - a.score);
    top.splice(0, top.length, ...aimed);
  }
  // One proposal per set of players you'd receive, so the list isn't ten variants of one deal.
  const seen = new Set(), picked = [];
  for (const d of top) {
    const key = d.B + ":" + d.gets.map((a) => a.id).sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key); picked.push(d);
    if (picked.length >= FINDER_SHOW) break;
  }
  if (picked.length) {
    const before = leagueStrength();
    for (const d of picked) {
      const after = leagueStrength(d.overrides);
      const recAfter = projectRecords(d.overrides);
      d.rec = { me: [recBefore[me], recAfter[me]], them: [recBefore[d.B], recAfter[d.B]] };
      const filled = (rid) => needsOf(rid, before.ranks).needs.filter((p) => after.ranks[p][rid] < before.ranks[p][rid]);
      const opened = (rid) => needsOf(rid, after.ranks).needs.filter((p) => !needsOf(rid, before.ranks).needs.includes(p));
      d.why = { meFill: filled(me), meOpen: opened(me), themFill: filled(d.B), themOpen: opened(d.B) };
      const pd = {};
      d.gets.filter((a) => a.kind === "pick").forEach((a) => { pd[me] = (pd[me] || 0) + a.value; pd[d.B] = (pd[d.B] || 0) - a.value; });
      d.gives.filter((a) => a.kind === "pick").forEach((a) => { pd[d.B] = (pd[d.B] || 0) + a.value; pd[me] = (pd[me] || 0) - a.value; });
      const dirAfter = assignBuilds(d.overrides, pd);
      d.dir = { me: [dirs[me], dirAfter[me]], them: [dirs[d.B], dirAfter[d.B]] };
    }
  }
  return { picked, total: out.length, partners: partners.length };
}

// ---------- three-team finder ----------
// You plus two teams you pick, each with its own goal. Deals go around a circle (you
// send to one team, it sends to the other, the other sends to you), both directions.
// Same rules as two-team: only what you picked leaves your roster, every team within
// the fair line at market and even or better by its own goal.
const goalSpec = (g, rid) => {
  if (g && g.startsWith("aim:")) { const key = g.slice(4); return { tone: aimTone(key), aim: key }; }
  if (g === "contend" || g === "rebuild" || g === "balanced") return { tone: g, aim: null };
  return { tone: "balanced", aim: null }; // "their situation": the team's own lens (teamFactor)
};
const goalLabel = (g) => (g && g.startsWith("aim:") ? `aiming for ${BUILD_INFO[g.slice(4)][0]}` : { contend: "contending", rebuild: "rebuilding", balanced: "balanced" }[g] || "their own situation");

function findTrades3() {
  const me = finder.me, [B, C] = finder.three.teams;
  if (B == null || C == null || B === C) return { error: "Pick two different teams to trade with." };
  const blocked = [B, C].filter(blockedPartner);
  if (blocked.length) return { error: `You noted that ${blocked.map(teamName).join(" and ")} won't trade with you. Clear that in Manager profiles to look anyway.` };
  const send = finder.send.map(assetById).filter(Boolean), get = finder.get.map(assetById).filter(Boolean);
  const locked = lockedIds(me), sendIds = new Set(send.map((a) => a.id));
  const myExtra = finder.offer.map(assetById).filter(Boolean)
    .filter((a) => a.roster_id === me && !sendIds.has(a.id) && !locked.has(a.id)).sort((a, b) => b.value - a.value).slice(0, 10);
  if (!send.length && !myExtra.length) return { error: 'Add at least one player or pick to "You send" or "OK to add". The finder never offers anything you didn\'t pick.' };
  const getOwners = new Set(get.map((a) => a.roster_id));
  if ([...getOwners].some((r) => r !== B && r !== C)) return { error: "Everything in \"You get\" has to belong to one of the two teams you picked." };
  if (getOwners.size > 1) return { error: "In a three-team deal one partner sends to you and the other gets paid by you, so \"You get\" can only come from one of them." };
  const specs = { [me]: { tone: finder.goal, aim: finder.target }, [B]: goalSpec(finder.three.goals[0], B), [C]: goalSpec(finder.three.goals[1], C) };
  const starts = {};
  [me, B, C].forEach((r) => (starts[r] = new Set(bestLineup(rosterOf(r), "ros_ppg").map((x) => x.p.id))));
  const factor = (rid) => (a) => (specs[rid].tone === "balanced" && !specs[rid].aim ? teamFactor(rid, a.id) : goalFactor(a, specs[rid].tone, rid, starts[rid]));
  const sendRoom = finder.sendMax == null ? 3 : finder.sendMax - send.length;
  const getRoom = finder.getMax == null ? 2 : finder.getMax - get.length;
  if (sendRoom < 0 || getRoom < 0) return { error: "The piece limits are smaller than what you've already named." };
  const posOk = (a) => !finder.positions.length || finder.positions.includes(a.kind === "pick" ? "PICK" : a.pos);
  const getIds = new Set(get.map((a) => a.id));
  // Pool of what team `from` could send to team `to`, best fits for `to` first.
  const pool = (from, to, mineToo) => [...state.assetMap.values()]
    .filter((a) => a.roster_id === from && a.value >= 150 && !getIds.has(a.id) && !lockedIds(from).has(a.id) && (!mineToo || posOk(a))
      && !(specs[to].tone === "rebuild" && OLD_FOR_REBUILD(a)))
    .sort((a, b) => b.value * factor(to)(b) - a.value * factor(to)(a)).slice(0, 9);
  const mine = combosUpTo(myExtra, Math.min(sendRoom, 2)).map((mx) => [...send, ...mx]).filter((g) => g.length);
  const ok = (gets, gives, rid, named) => {
    const mkt = netOf(gets, gives);
    if (rid === me ? !myMarketFits(mkt) : !theirMarketFits(mkt)) return null;
    const g = netOf(gets, gives, factor(rid));
    return !named && g < (rid === me ? -FAIR_MARGIN : theirFloor()) ? null : g;
  };
  const out = [];
  for (const [X, Y] of [[B, C], [C, B]]) {   // you → X → Y → you
    if (get.length && !getOwners.has(Y)) continue;
    const xy = combosUpTo(pool(X, Y), 2).filter((c) => c.length);
    const ym = combosUpTo(pool(Y, me, true), Math.min(getRoom, 2)).map((c) => [...get.filter((a) => a.roster_id === Y), ...c]).filter((c) => c.length);
    for (const toY of xy) for (const toMe of ym) {
      if (finder.getMax != null && toMe.length !== finder.getMax) continue;
      if (finder.positions.length && !toMe.some(posOk)) continue;
      const gy = ok(toY, toMe, Y, false);
      if (gy == null) continue;
      for (const toX of mine) {
        if (managerNotes(X).picksOnly && toX.some((a) => a.kind !== "pick")) continue;
        const gx = ok(toX, toY, X, false);
        if (gx == null) continue;
        const gm = ok(toMe, toX, me, get.length > 0);
        if (gm == null) continue;
        out.push({ X, Y, side: { [me]: { gets: toMe, gives: toX }, [X]: { gets: toX, gives: toY }, [Y]: { gets: toY, gives: toMe } },
          g: { [me]: gm, [X]: gx, [Y]: gy } });
      }
    }
  }
  const dirs = assignBuilds(), ppg0 = {};
  [me, B, C].forEach((r) => (ppg0[r] = teamPPG(rosterOf(r))));
  out.sort((a, b) => b.g[me] - a.g[me]);
  const scored = [];
  for (const d of out.slice(0, 160)) {
    const { overrides, pd } = dealAfter(d.side);
    d.overrides = overrides;
    d.dppg = {};
    [me, B, C].forEach((r) => (d.dppg[r] = teamPPG(overrides[r]) - ppg0[r]));
    // Contenders keep their lineups.
    if ([me, B, C].some((r) => specs[r].tone === "contend" && d.dppg[r] < -1)) continue;
    const after = assignBuilds(overrides, pd);
    d.dir = {}; d.aim = {};
    let miss = false;
    for (const r of [me, B, C]) {
      d.dir[r] = [dirs[r], after[r]];
      d.aim[r] = aimProgress(dirs[r], after[r], specs[r].aim);
      if (specs[r].aim && !d.aim[r].hit && d.aim[r].closer < 0.005) miss = true;
    }
    if (miss) continue;
    const pieces = Object.values(d.side).reduce((t, x) => t + x.gets.length, 0);
    const hits = [me, B, C].filter((r) => d.aim[r].hit).length;
    d.score = 3 * hits + 10 * [me, B, C].reduce((t, r) => t + d.aim[r].closer, 0) + 40 * d.g[me] + 10 * (d.g[d.X] + d.g[d.Y])
      + (specs[me].tone === "contend" ? 0.3 * d.dppg[me] : 0) - 0.3 * pieces;
    scored.push(d);
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set(), picked = [];
  for (const d of scored) {
    const key = d.X + ":" + d.side[me].gets.map((a) => a.id).sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key); picked.push(d);
    if (picked.length >= 8) break;
  }
  const recBefore = projectRecords();
  picked.forEach((d) => { const ra = projectRecords(d.overrides); d.rec = {}; [me, B, C].forEach((r) => (d.rec[r] = [recBefore[r], ra[r]])); });
  return { three: true, picked, total: out.length, specs };
}

function finderResults3(r) {
  if (r.error) return `<p class="error">${esc(r.error)}</p>`;
  if (!r.picked.length) return `<p class="muted">No three-team deal fits: nothing ${finder.winBy ? `where you win by about ${Math.round(finder.winBy * 100)}% at market and both partners stay` : "that keeps all three teams"} within the fair line, even or better by each team's goal${Object.values(r.specs).some((s) => s.aim) ? ", and moving each aimed team toward its build" : ""}. Try more pieces in "OK to add", other goals, or other partners.</p>`;
  const me = finder.me;
  const pct = (x) => `${x > 0 ? "+" : ""}${Math.round(x * 1000) / 10}%`;
  const cls = (x) => (x > FAIR_MARGIN ? "up" : x < -FAIR_MARGIN ? "down" : "");
  const list = (xs) => `<ul>${xs.map((a) => `<li><span>${face(a.id)}${esc(a.label)}</span><span>${fmt(a.value)}</span></li>`).join("")}</ul>`;
  const col = (d, rid) => {
    const x = d.side[rid], aim = d.aim[rid], sp = r.specs[rid];
    return `<div class="trade-side"><h3>${rid === me ? "You" : esc(teamOf(rid).name)}</h3>
      <h4>Gets</h4>${list(x.gets)}<h4>Gives</h4>${list(x.gives)}
      <p>Market <b class="${cls(netOf(x.gets, x.gives))}">${pct(netOf(x.gets, x.gives))}</b> · by its goal <b class="${cls(d.g[rid])}">${pct(d.g[rid])}</b></p>
      <p>${directionHtml(...d.dir[rid])}${sp.aim ? ` <span class="${aim.hit ? "up" : "muted"}">${aim.hit ? "reaches" : "closer to"} ${esc(BUILD_INFO[sp.aim][0])}</span>` : ""}</p>
      <p class="muted">Lineup ${d.dppg[rid] >= 0 ? "+" : ""}${d.dppg[rid].toFixed(1)} pts/wk · ${recordText(d.rec[rid][0])} → ${recordText(d.rec[rid][1])}</p></div>`;
  };
  return `<p class="muted">${r.picked.length} best of ${fmt(r.total)} ${finder.winBy ? `three-team deals where you win by about ${Math.round(finder.winBy * 100)}%` : "fair three-team deals"}. You: ${esc(goalLabel(finder.target ? "aim:" + finder.target : finder.goal))}. ${esc(teamOf(finder.three.teams[0]).name)}: ${esc(goalLabel(finder.three.goals[0]))}. ${esc(teamOf(finder.three.teams[1]).name)}: ${esc(goalLabel(finder.three.goals[1]))}.</p>
    ${r.picked.map((d, i) => `<div class="trade-log finder-deal">
      <h3>${i + 1}. You → ${esc(teamOf(d.X).name)} → ${esc(teamOf(d.Y).name)} → you</h3>
      <div class="trade-grid">${col(d, me)}${col(d, d.X)}${col(d, d.Y)}</div>
      <button class="chip finder-open3" data-i="${i}">Open in Trade Calculator</button>
    </div>`).join("")}`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".finder-open3");
  if (!b || !finder.last || !finder.last.three) return;
  const d = finder.last.picked[Number(b.dataset.i)];
  state.trade = { sides: [finder.me, d.X, d.Y].map((rid) => ({ team: rid, assets: d.side[rid].gets.map((a) => a.id) })) };
  renderTeamCount();
  renderSides();
  document.querySelector('.tabs button[data-tab="trade"]').click();
});

function finderResults(r) {
  if (r.error) return `<p class="error">${esc(r.error)}</p>`;
  if (!r.picked.length) return `<p class="muted">No deal fits: nothing ${finder.winBy ? `where you win by about ${Math.round(finder.winBy * 100)}% at market` : "within the fair line for both teams"} that also helps your goal and makes sense for both directions. Try adding pieces to "OK to add", more positions or pieces back, a different partner, or another goal.</p>`;
  const me = finder.me;
  const pct = (x) => `${x > 0 ? "+" : ""}${Math.round(x * 1000) / 10}%`;
  const cls = (x) => (x > FAIR_MARGIN ? "up" : x < -FAIR_MARGIN ? "down" : "");
  const list = (xs) => `<ul>${xs.map((a) => `<li><span>${esc(a.label)}</span><span>${fmt(a.value)}</span></li>`).join("")}</ul>`;
  const goalName = { contend: "contending", rebuild: "rebuilding", balanced: "your situation" }[finder.goal];
  const winNote = finder.winBy ? ` You win each one by about ${Math.round(finder.winBy * 100)}% at market (${Math.round((finder.winBy - WIN_BAND) * 100)}-${Math.round((finder.winBy + WIN_BAND) * 100)}%), so expect to sell it to them on fit.` : "";
  const aimNote = finder.target ? ` Only deals that reach ${esc(BUILD_INFO[finder.target][0])} or move you toward it, closest first.` : "";
  const themWhy = (d) => {
    const c = teamCtx(d.B), bits = [];
    if (c) bits.push(`They're ${c.label}${c.label === "middle" ? " of the pack" : ""}.`);
    if (d.them > 0.005) bits.push(`By their own needs they gain ${pct(d.them)}.`);
    if (d.why.themFill.length) bits.push(`Helps their need at ${d.why.themFill.join(", ")}.`);
    if (d.dThem > 0.3) bits.push(`Their lineup gains ${d.dThem.toFixed(1)} pts a week.`);
    const picks = d.gives.filter((a) => a.kind === "pick");
    if (picks.length && c && (c.label === "rebuilding" || c.label === "tanking")) bits.push(`They add ${picks.length > 1 ? "picks" : "a pick"} for their rebuild.`);
    if (d.why.themOpen.length) bits.push(`It opens a need at ${d.why.themOpen.join(", ")} for them.`);
    if (d.fits && d.fits.length) bits.push(`Fits their trade history: ${d.fits.join(", ")}.`);
    return bits.join(" ");
  };
  return `<p class="muted">${r.picked.length} best of ${fmt(r.total)} ${finder.winBy ? "winning" : "fair"} deals found, ranked for ${goalName}.
${winNote}${aimNote}
      Market is league value with the value adjustment. Your goal is the deal valued for ${goalName}. Their needs is the other team's own lens.</p>
    ${r.picked.map((d, i) => `<div class="trade-log finder-deal">
      <h3>${i + 1}. With ${teamHtml(d.B)}</h3>
      <div class="cols two">
        <div class="card"><h4>You get</h4>${list(d.gets)}</div>
        <div class="card"><h4>You send</h4>${list(d.gives)}</div>
      </div>
      <table class="net"><tbody>
        <tr><td>Market (you)</td><td class="${cls(d.mkt)}">${pct(d.mkt)}</td><td>Your goal</td><td class="${cls(d.mine)}">${pct(d.mine)}</td><td>Their needs</td><td class="${cls(d.them)}">${pct(d.them)}</td></tr>
        <tr><td>Your direction</td><td colspan="2">${directionHtml(...d.dir.me)}${d.aim ? ` <span class="${d.aim.hit ? "up" : "muted"}">${d.aim.hit ? "reaches" : "closer to"} ${esc(BUILD_INFO[finder.target][0])}</span>` : ""}</td><td>Their direction</td><td colspan="2">${directionHtml(...d.dir.them)}</td></tr>
        <tr><td>Your lineup</td><td class="${d.dMe > 0.3 ? "up" : d.dMe < -0.3 ? "down" : ""}">${d.dMe >= 0 ? "+" : ""}${d.dMe.toFixed(1)} pts/wk</td>
          <td>Your record</td><td>${recordText(d.rec.me[0])} → ${recordText(d.rec.me[1])}</td>
          <td>Your max PF</td><td>${fmt(d.rec.me[0].maxPF)} → ${fmt(d.rec.me[1].maxPF)}</td></tr>
      </tbody></table>
      <p>${d.why.meFill.length ? `<span class="up">Helps your need at ${d.why.meFill.join(", ")}.</span> ` : ""}${d.why.meOpen.length ? `<span class="down">Opens a need at ${d.why.meOpen.join(", ")} for you.</span> ` : ""}
        <strong>Why they'd say yes:</strong> ${esc(themWhy(d))}</p>
      <button class="chip finder-open" data-i="${i}">Open in Trade Calculator</button>
    </div>`).join("")}`;
}

function openInCalculator(d) {
  state.trade = { sides: [{ team: finder.me, assets: d.gets.map((a) => a.id) }, { team: d.B, assets: d.gives.map((a) => a.id) }] };
  renderTeamCount();
  renderSides();
  document.querySelector('.tabs button[data-tab="trade"]').click();
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".finder-open");
  if (!b || !finder.last) return;
  openInCalculator(finder.last.picked[Number(b.dataset.i)]);
});

// ---------- strength of schedule ----------
// The build rates every team's remaining regular season (engine/record.py
// strength_of_schedule): each week's opponent, how many points that opponent's best
// lineup projects, and the chance to win; difficulty = average opponent points.
function renderSchedule() {
  const el = $("#schedule");
  if (!el) return;
  const sch = state.data.schedule || {};
  const sos = sch.strength || {};
  const teams = state.data.teams.filter((t) => sos[t.roster_id] && sos[t.roster_id].weeks.length);
  if (!teams.length) {
    el.innerHTML = `<p class="muted">No regular-season games left to rate.</p>`;
    return;
  }
  const weeks = sos[teams[0].roster_id].weeks.map((w) => w.week);
  const mine = myTeam();
  const short = (rid) => { const t = teamOf(rid); return t ? managerOf(t) || t.name : ""; };
  const pct = (p) => `${Math.round(p * 100)}%`;
  const winCls = (p) => (p >= 0.6 ? "up" : p <= 0.4 ? "down" : "");
  const signed = (x) => `${x > 0 ? "+" : ""}${x.toFixed(1)}`;
  const byRank = [...teams].sort((a, b) => (sos[a.roster_id].rank || 99) - (sos[b.roster_id].rank || 99));
  const rec = (t) => `${t.record.wins}-${t.record.losses}${t.record.ties ? "-" + t.record.ties : ""}`;
  const summary = byRank.map((t) => {
    const s = sos[t.roster_id];
    return `<tr class="${mine && t.roster_id === mine.roster_id ? "mine-row" : ""}">
      <td>${s.rank ?? ""}</td><td class="name">${teamHtml(t.roster_id)}</td><td>${rec(t)}</td>
      <td class="num">${t.ros_ppg != null ? t.ros_ppg.toFixed(1) : ""}</td>
      <td class="num strong">${s.opp_ppg != null ? s.opp_ppg.toFixed(1) : ""}</td>
      <td class="num">${s.exp_wins.toFixed(1)}</td>
      <td class="num ${s.vs_average <= -0.3 ? "down" : s.vs_average >= 0.3 ? "up" : ""}" data-sort="${s.vs_average}">${signed(s.vs_average)}</td>
      ${sch.median_game ? `<td class="num">${s.median_wins.toFixed(1)}</td>` : ""}</tr>`;
  }).join("");
  const grid = byRank.map((t) => {
    const s = sos[t.roster_id];
    return `<tr class="${mine && t.roster_id === mine.roster_id ? "mine-row" : ""}"><td class="name">${teamHtml(t.roster_id)}</td>${s.weeks.map((w) =>
      `<td class="${winCls(w.win)}" data-sort="${w.opp_ppg ?? ""}" title="${w.opp ? `${esc(teamName(w.opp))}: ${w.opp_ppg} projected per game` : "No opponent listed: rated against the whole league"}">${w.opp ? esc(short(w.opp)) : "League"} <span class="muted">${pct(w.win)}</span></td>`).join("")}</tr>`;
  }).join("");
  el.innerHTML = `<p class="muted">Rest of the regular season (week ${weeks[0]}${weeks.length > 1 ? ` to ${weeks[weeks.length - 1]}` : ""}), hardest first.
      Opponent strength is the points per game that team's best lineup projects from here on, in this league's scoring.
      "Vs. average" is the wins this schedule is worth compared with playing an average opponent every week; negative means a tougher draw.${sch.median_game ? " Median games don't depend on the schedule, so they're shown on their own." : ""}
      Updates every build.</p>
    <div class="table-wrap"><table id="sos"><thead><tr><th>#</th><th>Team</th><th>Record</th><th class="num">Own proj/wk</th>
      <th class="num" title="Average projected points per game of the opponents left">Opp proj/wk</th>
      <th class="num" title="Expected head-to-head wins over the games left">Exp. wins</th><th class="num">Vs. average</th>
      ${sch.median_game ? `<th class="num" title="Expected wins in the weekly league-median games left">Median wins</th>` : ""}</tr></thead><tbody>${summary}</tbody></table></div>
    <h3>Week by week <span class="muted">(opponent and your chance to win)</span></h3>
    <div class="table-wrap"><table id="sos-weeks"><thead><tr><th>Team</th>${weeks.map((w) => `<th>Wk ${w}</th>`).join("")}</tr></thead><tbody>${grid}</tbody></table></div>`;
}

// ---------- recent trades ----------
// The build ships this season's completed trades (data.trades). Opening the tab also
// asks Sleeper directly, so a trade made since the last build shows right away.
// Every asset is valued with today's numbers: market, and each team's own lens.
function tradeMove(m) {
  if (m.kind === "faab") return { label: `$${m.amount} FAAB`, value: 0, id: null, kind: "faab" };
  if (m.kind === "pick") {
    const pk = assetById(m.id);
    return pk ? { label: pk.label, value: pk.value, id: m.id, kind: "pick" }
      : { label: `${m.season} round ${m.round} (${pickOwner(m.original_roster_id) || "pick"})`, value: 0, id: m.id, kind: "pick" };
  }
  const p = assetById(m.id);
  return p ? { label: `${p.name} (${p.pos}${p.team ? ", " + p.team : ""})`, value: p.value, id: m.id, kind: "player" }
    : { label: m.name || playerOf(m.id).name, value: 0, id: m.id, kind: "player" };
}

function tradeFromSleeper(t) {
  const moves = [];
  const drops = t.drops || {};
  for (const [pid, to] of Object.entries(t.adds || {})) moves.push({ kind: "player", id: pid, from: drops[pid], to });
  for (const pk of t.draft_picks || [])
    moves.push({ kind: "pick", id: `pick:${pk.season}:${pk.round}:${pk.roster_id}`, season: String(pk.season), round: pk.round,
      original_roster_id: pk.roster_id, from: pk.previous_owner_id, to: pk.owner_id });
  for (const w of t.waiver_budget || []) moves.push({ kind: "faab", id: "faab", amount: w.amount, from: w.sender, to: w.receiver });
  return { id: t.transaction_id, at: t.status_updated || t.created, leg: t.leg, rosters: t.roster_ids || [], moves };
}

async function refreshTrades() {
  const data = state.data, lid = data.league.sleeper_league_id;
  const week = Math.min((data.league.week || 0) + 1, 18);
  try {
    const legs = Array.from({ length: week + 1 }, (_, i) => i);
    const got = await Promise.all(legs.map((leg) =>
      fetch(`https://api.sleeper.app/v1/league/${lid}/transactions/${leg}`).then((r) => (r.ok ? r.json() : [])).catch(() => [])));
    if (state.data !== data) return; // league switched meanwhile
    const live = got.flat().filter((t) => t.type === "trade" && t.status === "complete").map(tradeFromSleeper);
    const known = new Set((data.trades || []).map((t) => t.id));
    state.liveTrades = live.filter((t) => !known.has(t.id));
  } catch (e) {
    state.liveTrades = [];
  }
  renderTrades();
}

function renderTrades() {
  const el = $("#trades");
  if (!el) return;
  const built = new Date(state.data.generated_at).getTime();
  const all = [...(state.liveTrades || []), ...(state.data.trades || [])].sort((a, b) => (b.at || 0) - (a.at || 0));
  if (!all.length) {
    el.innerHTML = `<p class="muted">No completed trades in this league this season yet.</p>`;
    return;
  }
  const mine = myTeam();
  const pct = (x) => `${x > 0 ? "+" : ""}${Math.round(x * 1000) / 10}%`;
  const cls = (x) => (x >= FAIR_MARGIN ? "up" : x <= -FAIR_MARGIN ? "down" : "");
  const newer = all.some((t) => t.at > built);
  el.innerHTML = `<p class="muted">Completed trades this season, newest first, valued with today's numbers.
      Market is the league-wide value; Own needs is how much each team's own situation says it gained.${newer
        ? " <strong>Trades marked new happened after the last build, so rosters and values elsewhere on the site catch up at the next build.</strong>" : ""}</p>
    ${all.map((t) => {
      const when = t.at ? new Date(t.at) : null;
      const sides = t.rosters.map((rid) => {
        const gets = t.moves.filter((m) => m.to === rid).map(tradeMove);
        const gives = t.moves.filter((m) => m.from === rid).map(tradeMove);
        const m = netOf(gets, gives), tl = netOf(gets, gives, (a) => (a.id ? teamFactor(rid, a.id) : 1));
        return { rid, gets, gives, m, tl };
      });
      const list = (xs) => (xs.length ? `<ul>${xs.map((a) => `<li><span>${esc(a.label)}</span><span>${a.value ? fmt(a.value) : ""}</span></li>`).join("")}</ul>` : `<p class="muted">Nothing</p>`);
      const best = sides.reduce((b, s) => (s.m > b.m ? s : b), sides[0]);
      const verdict = best && best.m >= FAIR_MARGIN ? `Market winner: ${teamHtml(best.rid)}` : "Even by market";
      return `<div class="trade-log${mine && t.rosters.includes(mine.roster_id) ? " mine-row" : ""}">
        <h3>${when ? esc(when.toLocaleDateString(undefined, { month: "short", day: "numeric" })) : ""}${t.leg ? ` · Week ${t.leg}` : ""}${t.at > built ? ' <span class="badge new">new</span>' : ""} <span class="muted">${verdict}</span></h3>
        <div class="cols">${sides.map((s) => `<div class="card">
          <h4>${teamHtml(s.rid)}</h4>
          <div class="muted">Gets</div>${list(s.gets)}
          <div class="muted">Gives</div>${list(s.gives)}
          <table class="net"><tbody><tr><td>Market</td><td class="${cls(s.m)}">${pct(s.m)}</td></tr>
            <tr><td>Own needs</td><td class="${cls(s.tl)}">${pct(s.tl)}</td></tr></tbody></table>
        </div>`).join("")}</div></div>`;
    }).join("")}`;
}

// ---------- rookie mock draft ----------
// The build ships next year's projected order (this league's own rule), who holds
// each pick, and the class on this league's value scale. The mock runs here so it
// can use the same room rankings as the Teams tab: each holder takes the best
// prospect, nudged toward a position its room ranks bottom third in.
const NEED_BONUS = 0.12;
const MOCK_LOOKAHEAD = 12;

function runMock(rd) {
  const { ranks } = leagueStrength();
  const needs = {};
  state.data.teams.forEach((t) => (needs[t.roster_id] = new Set(needsOf(t.roster_id, ranks).needs)));
  const avail = [...rd.class];
  return rd.board.map((b) => {
    if (!avail.length) return { ...b, pick: null };
    const need = needs[b.roster_id] || new Set();
    const score = (p) => p.value * (need.has(p.pos) ? 1 + NEED_BONUS : 1);
    const window = avail.slice(0, MOCK_LOOKAHEAD);
    const pick = window.reduce((best, p) => (score(p) > score(best) ? p : best), window[0]);
    const bpa = avail[0];
    avail.splice(avail.indexOf(pick), 1);
    const forNeed = need.has(pick.pos);
    need.delete(pick.pos);
    return { ...b, pick, bpa, forNeed, roomRank: ranks[pick.pos] ? ranks[pick.pos][b.roster_id] : null };
  });
}

function mockAnalysis(m, rd) {
  const n = state.data.teams.length;
  const p = m.pick;
  const notes = [];
  if (m.forNeed && m.bpa && m.bpa !== p) notes.push(`Takes ${p.pos} for need (their ${p.pos} room is ${ordinal(m.roomRank)} of ${n}) over best available ${esc(m.bpa.name)} (${m.bpa.pos}).`);
  else if (m.forNeed) notes.push(`Best available and fills a need: their ${p.pos} room is ${ordinal(m.roomRank)} of ${n}.`);
  else notes.push(`Best available on this league's values.`);
  if (p.factor >= 1.04) notes.push(`${p.pos}s score up in this league (×${p.factor.toFixed(2)}).`);
  else if (p.factor <= 0.96) notes.push(`${p.pos}s score down in this league (×${p.factor.toFixed(2)}).`);
  if (m.slot_value) {
    const r = p.value / m.slot_value;
    if (r >= 1.15) notes.push(`Value: worth about ${Math.round((r - 1) * 100)}% more than the pick trades for.`);
    else if (r <= 0.85) notes.push(`Reach: the pick trades for about ${Math.round((1 / r - 1) * 100)}% more than him.`);
  }
  return notes.join(" ");
}

function slotWhy(rid, rd) {
  const t = teamOf(rid);
  if (!t || !t.projection) return "";
  const pr = t.projection;
  const missed = pr.rank > rd.playoff_teams;
  return `${recordText(pr)} (${ordinal(pr.rank)})${rd.rule.rule === "max_pf" ? ` · max PF ${fmt(pr.max_pf)}` : ""}${missed ? "" : " · playoffs"}`;
}

function renderRookieMock() {
  const el = $("#rookie");
  const rd = state.data.rookie_draft;
  if (state.data.lite) { el.innerHTML = `<p class="muted">The rookie mock needs this league's past drafts and the devy class, so it runs only for leagues in the hourly build. Picks on the other tabs are still priced by projected finish.</p>`; return; }
  if (!rd || !rd.board.length) { el.innerHTML = `<p class="muted">No upcoming rookie draft picks found for this league.</p>`; return; }
  const rule = rd.rule;
  const ruleText = rule.rule === "max_pf" ? "lowest projected max PF first" : "worst projected record first";
  const evidence = rule.basis === "league_rule"
    ? `This is the order this league has written down, so it is used as given.`
    : rule.basis === "last_draft"
    ? `This league's ${rd.last_draft_season} rookie draft followed ${rule.rule === "max_pf" ? "max PF" : "record"}: ${rule.matched} of ${rule.of} non-playoff slots matched (${rule.rule === "max_pf" ? `record matched ${rule.record_matched}` : `max PF matched ${rule.max_pf_matched}`}).`
    : `Sleeper had no past rookie draft to check, so this assumes worst record first.`;
  const playoffText = rule.playoff_slots
    ? `then the ${rd.playoff_teams} playoff teams at the slots this league grants by finish (champion picks last)`
    : `then the ${rd.playoff_teams} playoff teams, weakest projected record first`;
  const orderText = rule.fixed
    ? `Set ${rd.year} order: this league wrote down every slot, round by round, so each pick stays at its listed slot whatever the standings do.`
    : `Projected ${rd.year} order: non-playoff teams by ${ruleText}, ${playoffText}.`;
  const src = rd.source || {};
  const srcText = src.ok
    ? `Prospects from KeepTradeCut's devy rankings (${state.data.league.format.superflex ? "superflex" : "1QB"} values), refreshed every build, valued at what the market pays for the pick where each one ranks and adjusted for how this league scores his position.`
    : `The prospect rankings couldn't be loaded this build (${esc(src.error || "unavailable")}); the order and pick holders are still current.`;
  const mock = rd.class.length ? runMock(rd) : rd.board.map((b) => ({ ...b, pick: null }));
  const mine = myTeam();
  const myPicks = mine ? mock.filter((m) => m.roster_id === mine.roster_id) : [];
  const fromCell = (m) => m.original_roster_id !== m.roster_id ? `<div class="muted">via ${teamHtml(m.original_roster_id)}</div>` : "";
  const row = (m) => `<tr class="${mine && m.roster_id === mine.roster_id ? "mine-row" : ""}">
      <td class="strong">${m.label}</td>
      <td class="muted" data-sort="${nowSlot(m)}">${nowSlot(m) ? `${m.round}.${String(nowSlot(m)).padStart(2, "0")}` : ""}</td>
      <td>${teamHtml(m.roster_id)}${starMine(m.roster_id)}${fromCell(m)}</td>
      <td class="muted">${slotWhy(m.original_roster_id, rd)}</td>
      ${m.pick ? `<td class="name">${esc(m.pick.name)}</td><td><span class="pos pos-${m.pick.pos}">${m.pick.pos}</span></td><td class="muted">${esc(m.pick.school || "")}</td>
      <td class="num" data-sort="${m.pick.value}">${fmt(m.pick.value)} <span class="muted">/ ${fmt(m.slot_value)}</span></td><td class="analysis">${mockAnalysis(m, rd)}</td>`
      : `<td colspan="5" class="muted">Past the end of the ranked class.</td>`}</tr>`;
  const rounds = [...new Set(mock.map((m) => m.round))];
  const takenAt = new Map(mock.filter((m) => m.pick).map((m) => [m.pick.name, m.label]));
  el.innerHTML = `
    <p class="muted">${orderText} ${rd.type === "snake" ? "Snake" : "Linear"}, ${rd.rounds} rounds. Each ${rd.year} pick is valued at its own projected slot, half from what the market pays for that slot and half from the prospect projected to go there, so a loaded class lifts its picks.${rd.class_weight && rd.class_weight.ktc_devy ? " Prospects are priced half from their slot and half from their own KTC devy value on this league's scale" : ""}${rd.class.some((p) => p.pinned) ? `; pinned: ${rd.class.filter((p) => p.pinned).map((p) => `${esc(p.name)} as ${p.pinned}`).join(", ")}` : ""}. ${evidence} ${srcText}</p>
    ${standingsTodayHtml(rd)}
    ${myPicks.length ? `<div class="card mine-card"><h4>Your ${rd.year} picks</h4><ul>${myPicks.map((m) => `<li><span><strong>${m.label}</strong>${m.original_roster_id !== m.roster_id ? ` <span class="muted">via ${teamHtml(m.original_roster_id)}</span>` : ""}</span><span>${m.pick ? `${esc(m.pick.name)} <span class="pos pos-${m.pick.pos}">${m.pick.pos}</span>` : ""}</span></li>`).join("")}</ul></div>` : ""}
    ${rounds.map((r) => `<h3>Round ${r}</h3><div class="table-wrap"><table id="mock-r${r}"><thead><tr><th>Pick</th><th title="Where this pick would fall if the season ended today">Today</th><th>Holder</th><th>Original team, projected</th><th>Mock pick</th><th>Pos</th><th>School</th><th class="num" title="Prospect value in this league / what this exact pick slot trades for">Value / slot</th><th>Analysis</th></tr></thead><tbody>${mock.filter((m) => m.round === r).map(row).join("")}</tbody></table></div>`).join("")}
    ${rd.class.length ? `<h3>Prospect board <span class="muted">(${rd.year} class, this league's values)</span></h3>
    <div class="table-wrap"><table id="prospects"><thead><tr><th>#</th><th>Player</th><th>Pos</th><th>School</th><th>Age</th><th class="num">KTC rank</th><th class="num">League value</th><th>Mock</th></tr></thead><tbody>${rd.class
      .map((p, i) => `<tr><td>${i + 1}</td><td class="name">${esc(p.name)}</td><td><span class="pos pos-${p.pos}">${p.pos}${p.ktc_pos_rank || ""}</span></td><td class="muted">${esc(p.school || "")}</td><td>${p.age ? Number(p.age).toFixed(1) : ""}</td><td class="num">${p.class_rank}</td><td class="num strong">${fmt(p.value)}</td><td>${takenAt.get(p.name) || '<span class="muted">undrafted</span>'}</td></tr>`)
      .join("")}</tbody></table></div>` : ""}
    ${nextDraftHtml()}`;
}

// Slot this round's pick would take if the season ended today.
function nowSlot(m) {
  const rd = state.data.rookie_draft;
  if (rd.round_orders) return m.slot;  // a set order doesn't move with the standings
  const now = rd.order_now;
  if (!now) return null;
  const seq = state.data.rookie_draft.type === "snake" && m.round % 2 === 0 ? [...now].reverse() : now;
  const i = seq.indexOf(m.original_roster_id);
  return i < 0 ? null : i + 1;
}

// Standings as of today and where each team's first would land, next to the projection.
function standingsTodayHtml(rd) {
  if (!rd.order_now) return "";
  const lg = state.data.league;
  const divs = lg.divisions || {};
  // Divisions count only when every team has one (the engine's seeding falls back otherwise).
  const hasDiv = Object.keys(divs).length > 1 && state.data.teams.every((t) => t.division != null);
  const firsts = new Map(state.data.picks.filter((p) => p.year === rd.year && p.round === 1).map((p) => [p.original_roster_id, p]));
  const mine = myTeam();
  const champs = new Set();
  if (hasDiv) {
    const seen = new Set();
    [...state.data.teams].sort((a, b) => a.record.seed - b.record.seed).forEach((t) => {
      if (t.record.seed <= rd.playoff_teams && !seen.has(t.division)) { seen.add(t.division); champs.add(t.roster_id); }
    });
  }
  const label = (s) => `1.${String(s).padStart(2, "0")}`;
  const rows = [...state.data.teams].sort((a, b) => a.record.seed - b.record.seed).map((t) => {
    const r = t.record, pk = firsts.get(t.roster_id), now = rd.order_now.indexOf(t.roster_id) + 1;
    const spot = r.seed > rd.playoff_teams ? "" : champs.has(t.roster_id) ? "division champ" : hasDiv ? "wildcard" : "playoffs";
    return `<tr class="${mine && t.roster_id === mine.roster_id ? "mine-row" : ""}">
      <td>${r.seed}</td><td>${teamHtml(t.roster_id)}${starMine(t.roster_id)}</td>
      ${hasDiv ? `<td class="muted">${esc(divs[String(t.division)] || "")}</td>` : ""}
      <td data-sort="${r.wins + 0.5 * (r.ties || 0)}">${recordText(r)}${spot ? ` <span class="muted">· ${spot}</span>` : ""}</td>
      <td class="num">${fmt(r.fpts)}</td>
      <td class="num strong" data-sort="${r.max_pf}">${fmt(r.max_pf)} <span class="muted">(${ordinal(r.max_pf_rank)})</span></td>
      <td class="num strong" data-sort="${now}">${label(now)}</td>
      <td class="num" data-sort="${pk && pk.slot}">${pk && pk.slot ? label(pk.slot) : ""}</td>
      <td>${pk ? teamHtml(pk.roster_id) : ""}</td></tr>`;
  }).join("");
  return `<h3>Standings today</h3>
    <p class="muted">Where everyone stands after the games played so far (Sleeper, refreshed every build, so it moves week to week). Playoff seeds: ${hasDiv ? `each division's best record takes a top seed, the next best records take the ${Math.max(rd.playoff_teams - Object.keys(divs).length, 0)} wildcard spots` : `the ${rd.playoff_teams} best records`}, ties to most points for. "1st today" is where each team's ${rd.year} first would land if the season ended now under this league's draft rule; "Projected" is the end-of-season projection used for pick values.</p>
    <div class="table-wrap"><table id="standings-now"><thead><tr><th>Seed</th><th>Team</th>${hasDiv ? "<th>Division</th>" : ""}<th>Record</th><th class="num">Points for</th><th class="num" title="Best possible lineup each week, bench included">Max PF</th><th class="num">1st today</th><th class="num">Projected</th><th>Holder</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// The draft after next: every team a season older plus the rookies its picks bring.
function nextDraftHtml() {
  const nd = state.data.next_draft;
  if (!nd || !nd.teams.length) return "";
  const firsts = new Map(state.data.picks.filter((p) => p.year === nd.year && p.round === 1).map((p) => [p.original_roster_id, p]));
  const mine = myTeam();
  const rows = nd.teams.map((t) => {
    const pk = firsts.get(t.roster_id);
    return `<tr class="${mine && pk && pk.roster_id === mine.roster_id ? "mine-row" : ""}">
      <td>${t.rank}</td><td>${teamHtml(t.roster_id)}${starMine(t.roster_id)}</td>
      <td class="num">${t.now_ppg != null ? fmt(t.now_ppg) : "–"}</td><td class="num strong">${fmt(t.ppg)}</td>
      <td class="muted">${t.rookies.length ? t.rookies.map(esc).join(", ") : "none"}</td>
      <td class="num" data-sort="${t.first_slot}">1.${String(Math.round(t.first_slot)).padStart(2, "0")} <span class="muted">(avg ${Number(t.first_slot).toFixed(1)})</span></td>
      <td>${pk ? `${teamHtml(pk.roster_id)}` : ""}</td><td class="num strong">${pk ? fmt(pk.value) : ""}</td></tr>`;
  }).join("");
  return `<h3>Looking ahead: the ${nd.year} draft</h3>
    <p class="muted">Each team projected a season ahead: every player a year older on his position's age curve (stars regress toward an ordinary starter), plus the rookies its ${nd.year - 1} picks bring at a rookie-year discount. Teams are ordered by that lineup under this league's draft rule. Rosters churn in a year, so each ${nd.year} pick is priced as the average over thousands of seasons with ±${Math.round(nd.spread * 100)}% swings in team strength: a clear tanker's pick stays near the top, a middling team's spreads out.${nd.class.length ? ` Slots carry the ${nd.year} class from KTC's devy rankings.` : ""}</p>
    <div class="table-wrap"><table id="next-draft"><thead><tr><th>#</th><th>Team</th><th class="num">Lineup now</th><th class="num">Next season</th><th>Rookies starting</th><th class="num">Projected 1st</th><th>Holder</th><th class="num">${nd.year} 1st value</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------- sortable tables ----------
// Click any column header to sort; click again to flip, a third time to go back
// to the original order. Each table keeps its sort when it re-renders.
const sortState = {}; // table key -> { col, dir }
const tableKey = (t) => t.id || t.className || "table";

function cellValue(td) {
  if (!td) return null;
  const raw = (td.dataset.sort ?? td.textContent).trim();
  if (raw === "" || raw === "–") return null;
  if (td.dataset.sort == null) {
    const rec = /^(\d+)-(\d+)(?:-(\d+))?(\s|$)/.exec(raw); // a W-L(-T) record
    if (rec) {
      const [w, l, t] = [Number(rec[1]), Number(rec[2]), Number(rec[3] || 0)];
      return w + l + t ? (w + t / 2) / (w + l + t) + w / 1e4 : 0;
    }
  }
  const num = /^[#$+]?\s*(-?[\d,]*\.?\d+)(?![\w])/.exec(raw);
  return num ? parseFloat(num[1].replace(/,/g, "")) : raw.toLowerCase();
}

function sortTable(table, col, dir) {
  const tbody = table.tBodies[0];
  if (!tbody) return;
  const rows = [...tbody.rows];
  rows.forEach((r, i) => { if (r.dataset.order == null) r.dataset.order = i; });
  const isGap = (r) => r.classList.contains("tier-row");
  if (!dir) {
    rows.sort((a, b) => a.dataset.order - b.dataset.order).forEach((r) => { r.hidden = false; tbody.appendChild(r); });
  } else {
    const keyed = rows.filter((r) => !isGap(r)).map((r) => [r, cellValue(r.cells[col])]);
    keyed.sort(([, a], [, b]) => {
      if (a == null || b == null) return (a == null) - (b == null); // blanks last either way
      const c = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
      return dir === "asc" ? c : -c;
    });
    rows.filter(isGap).forEach((r) => (r.hidden = true)); // tier breaks only make sense in value order
    keyed.forEach(([r]) => tbody.appendChild(r));
  }
  tbody.dataset.sorted = `${col}:${dir || ""}`;
  table.querySelectorAll("thead th").forEach((th, i) => {
    if (i === col && dir) th.setAttribute("aria-sort", dir === "asc" ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });
}

document.addEventListener("click", (e) => {
  const th = e.target.closest("thead th");
  const table = th && th.closest("table");
  if (!table) return;
  const col = [...th.parentNode.children].indexOf(th);
  const key = tableKey(table);
  const cur = sortState[key];
  let dir;
  if (!cur || cur.col !== col) {
    // Numbers start high-to-low, text A-Z.
    const first = [...(table.tBodies[0]?.rows || [])].map((r) => cellValue(r.cells[col])).find((v) => v != null);
    dir = typeof first === "number" ? "desc" : "asc";
  } else {
    dir = cur.dir === "desc" && cur.first === "desc" ? "asc" : cur.dir === "asc" && cur.first === "asc" ? "desc" : null;
  }
  sortState[key] = dir ? { col, dir, first: cur && cur.col === col ? cur.first : dir } : undefined;
  sortTable(table, col, dir);
});

// Tables are rebuilt with innerHTML; put each one's chosen sort back after that.
new MutationObserver(() => {
  document.querySelectorAll("table").forEach((table) => {
    const st = sortState[tableKey(table)];
    const tbody = table.tBodies[0];
    if (st && tbody && tbody.rows.length && !tbody.dataset.sorted) sortTable(table, st.col, st.dir);
  });
}).observe(document.body, { childList: true, subtree: true });

init();

// ---------- money bank ----------
// Dues, payouts and winnings across every league, kept only in this browser
// (localStorage). The site is public, so nothing here is ever sent anywhere or built
// into the data; Export/Import moves it between devices.
const BANK_KEY = "moneybank.v1";
const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round((n || 0) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : 0; };

function bankLoad() {
  try {
    const b = JSON.parse(localStorageGet(BANK_KEY) || "null");
    if (b && Array.isArray(b.entries)) return { leagues: {}, ...b };
  } catch {}
  return { leagues: {}, entries: [] };
}
function bankSave(b) { localStorageSet(BANK_KEY, JSON.stringify(b)); }

// Every league the site knows, plus any the bank added by hand (an old or non-Sleeper league).
function bankLeagues(b) {
  const out = (state.leagues || []).map((l) => ({ id: l.key, name: l.name, teams: l.teams, buy_in: l.buy_in, season: l.season, payouts: l.payouts }));
  for (const [id, l] of Object.entries(b.leagues)) if (l.custom && !out.some((o) => o.id === id)) out.push({ id, name: l.name, teams: l.teams, custom: true });
  return out;
}
function leagueSetup(b, l) {
  const s = b.leagues[l.id] || {};
  return {
    dues: s.dues ?? (l.buy_in || 0),
    teams: s.teams ?? l.teams ?? 0,
    // Until edited here, payouts come from the league's config (data/leagues.json).
    payouts: s.payouts || Object.entries(l.payouts || {}).filter(([k, v]) => k !== "notes" && num(v)).map(([k, v]) => ({ place: k.replace(/_/g, " "), amount: v })),
    notes: s.notes ?? (l.payouts?.notes && l.payouts.notes !== "TBD" ? l.payouts.notes : ""),
  };
}

function bankTotals(entries) {
  const t = { invested: 0, owed: 0, won: 0, n: 0 };
  for (const e of entries) {
    const cost = num(e.dues) + num(e.extra);
    if (e.paid) t.invested += cost; else t.owed += cost;
    t.won += num(e.winnings); t.n++;
  }
  t.net = t.won - t.invested;
  t.roi = t.invested ? t.net / t.invested : null;
  return t;
}
const pct = (r) => (r == null ? "—" : `${r >= 0 ? "+" : ""}${Math.round(r * 100)}%`);
const signCls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");

function groupTotals(entries, key, label) {
  const groups = new Map();
  for (const e of entries) {
    const k = key(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  return [...groups.entries()].map(([k, es]) => ({ k, label: label(k), ...bankTotals(es), titles: es.filter((e) => /^(1|1st|champ)/i.test(String(e.finish || "").trim())).length }));
}

function renderBank() {
  const el = $("#bank");
  if (!el) return;
  const b = bankLoad();
  const leagues = bankLeagues(b);
  const lname = (id) => leagues.find((l) => l.id === id)?.name || b.leagues[id]?.name || id || "Other";
  const year = new Date().getFullYear();
  const entries = [...b.entries].sort((x, y) => (y.year - x.year) || lname(x.league).localeCompare(lname(y.league)));
  const all = bankTotals(entries);
  const byLeague = groupTotals(entries, (e) => e.league, lname).sort((x, y) => y.net - x.net);
  const byYear = groupTotals(entries, (e) => e.year, (k) => k).sort((x, y) => y.k - x.k);
  // Paid-ahead seasons: dues already paid for a year after this one.
  const ahead = entries.filter((e) => e.paid && e.year > year);
  const leagueOpts = (sel) => leagues.map((l) => `<option value="${esc(l.id)}" ${l.id === sel ? "selected" : ""}>${esc(l.name)}</option>`).join("");
  const totalsRow = (g) => `<tr><td>${esc(g.label)}</td><td class="num">${g.n}</td><td class="num">${money(g.invested)}</td><td class="num">${g.owed ? money(g.owed) : ""}</td><td class="num">${money(g.won)}</td><td class="num ${signCls(g.net)}">${money(g.net)}</td><td class="num">${pct(g.roi)}</td><td class="num">${g.titles || ""}</td></tr>`;
  const totalsHead = (first) => `<thead><tr><th>${first}</th><th class="num">Seasons</th><th class="num">Invested</th><th class="num">Still owed</th><th class="num">Won</th><th class="num">Net</th><th class="num">ROI</th><th class="num">Titles</th></tr></thead>`;

  el.innerHTML = `
    <p class="muted">Your money stays in this browser only. Nothing here is uploaded or shared, and the public site never sees it. Use Export to back it up or move it to another device.</p>
    <div class="stats">
      <div><label>Invested</label><b>${money(all.invested)}</b></div>
      <div><label>Won</label><b>${money(all.won)}</b></div>
      <div><label>Net</label><b class="${signCls(all.net)}">${money(all.net)}</b></div>
      <div><label>ROI</label><b>${pct(all.roi)}</b></div>
      <div><label>Still owed</label><b>${money(all.owed)}</b></div>
      <div><label>Paid ahead</label><b>${ahead.length ? money(bankTotals(ahead).invested) : "$0"}</b></div>
    </div>
    ${ahead.length ? `<p class="muted">Paid ahead: ${ahead.map((e) => `${esc(lname(e.league))} ${e.year}`).join(", ")}.</p>` : ""}

    <h3>Ledger <span class="muted">(one row per league per season)</span></h3>
    <div class="toolbar">
      <select id="bank-new-league" aria-label="League">${leagueOpts(state.data?.league?.id || leagues[0]?.id)}</select>
      <input id="bank-new-year" type="number" value="${year}" min="2000" max="2100" style="width:90px" aria-label="Season" />
      <button id="bank-add" class="chip">Add season</button>
      <button id="bank-add-all" class="chip">Add ${year} for every league</button>
    </div>
    <div class="table-wrap"><table id="bank-ledger" class="bank-table"><thead><tr><th>League</th><th>Season</th><th class="num">Dues</th><th>Paid</th><th class="num">Other costs</th><th>Finish</th><th class="num">Winnings</th><th class="num">Net</th><th>Notes</th><th></th></tr></thead><tbody>${entries
      .map((e) => {
        const net = num(e.winnings) - (e.paid ? num(e.dues) + num(e.extra) : 0);
        return `<tr data-id="${esc(e.id)}">
          <td><select data-f="league">${leagueOpts(e.league)}</select></td>
          <td><input data-f="year" type="number" value="${esc(e.year)}" style="width:76px" /></td>
          <td class="num"><input data-f="dues" inputmode="decimal" value="${esc(e.dues ?? "")}" style="width:80px" /></td>
          <td><input data-f="paid" type="checkbox" ${e.paid ? "checked" : ""} aria-label="Paid" /></td>
          <td class="num"><input data-f="extra" inputmode="decimal" value="${esc(e.extra ?? "")}" placeholder="0" style="width:72px" title="Trade fees, side bets, anything else you put in" /></td>
          <td><input data-f="finish" value="${esc(e.finish ?? "")}" placeholder="e.g. 1st" style="width:72px" /></td>
          <td class="num"><input data-f="winnings" inputmode="decimal" value="${esc(e.winnings ?? "")}" placeholder="0" style="width:80px" /></td>
          <td class="num ${signCls(net)}">${money(net)}</td>
          <td><input data-f="note" value="${esc(e.note ?? "")}" style="width:180px" /></td>
          <td><button class="bank-del" title="Remove row" aria-label="Remove row">×</button></td>
        </tr>`;
      })
      .join("") || `<tr><td colspan="10" class="muted">No seasons yet. Add one above.</td></tr>`}</tbody></table></div>

    <h3>By league</h3>
    <div class="table-wrap"><table>${totalsHead("League")}<tbody>${byLeague.map(totalsRow).join("") || `<tr><td colspan="8" class="muted">—</td></tr>`}</tbody></table></div>
    <h3>By season</h3>
    <div class="table-wrap"><table>${totalsHead("Season")}<tbody>${byYear.map(totalsRow).join("") || `<tr><td colspan="8" class="muted">—</td></tr>`}</tbody></table></div>

    <h3>Payout structure <span class="muted">(per league; the pot is dues × teams)</span></h3>
    <div class="cols bank-leagues">${leagues
      .map((l) => {
        const s = leagueSetup(b, l);
        const pot = num(s.dues) * num(s.teams);
        const paidOut = s.payouts.reduce((a, p) => a + num(p.amount), 0);
        const mine = bankTotals(b.entries.filter((e) => e.league === l.id));
        return `<div class="card" data-league="${esc(l.id)}">
          <h4>${esc(l.name)}${l.custom ? ' <button class="bank-del-league chip" title="Remove this league">remove</button>' : ""}</h4>
          <div class="bank-setup">
            <label>Dues <input data-s="dues" inputmode="decimal" value="${esc(s.dues)}" style="width:80px" /></label>
            <label>Teams <input data-s="teams" type="number" value="${esc(s.teams)}" style="width:60px" /></label>
          </div>
          <ul>${s.payouts
            .map((p, i) => `<li><span><input data-p="${i}" data-k="place" value="${esc(p.place)}" style="width:120px" aria-label="Place" /></span><span><input data-p="${i}" data-k="amount" inputmode="decimal" value="${esc(p.amount)}" style="width:80px" aria-label="Amount" /> <button class="bank-del-payout" data-p="${i}" aria-label="Remove payout">×</button></span></li>`)
            .join("")}</ul>
          <button class="bank-add-payout chip">Add payout</button>
          <p class="muted">Pot ${money(pot)} · paid out ${money(paidOut)}${pot && Math.abs(pot - paidOut) > 0.5 ? ` · <span class="${paidOut > pot ? "down" : ""}">${money(pot - paidOut)} unassigned</span>` : ""}</p>
          <p class="muted">Your record here: in ${money(mine.invested)}, won ${money(mine.won)}, net <span class="${signCls(mine.net)}">${money(mine.net)}</span></p>
          <textarea data-s="notes" rows="2" placeholder="Payout rules, who holds the money, deadlines" style="width:100%">${esc(s.notes)}</textarea>
        </div>`;
      })
      .join("")}</div>
    <div class="toolbar" style="margin-top:12px">
      <input id="bank-custom-name" placeholder="Another league (name)" />
      <button id="bank-custom-add" class="chip">Add league</button>
    </div>

    <h3>Back up</h3>
    <div class="toolbar">
      <button id="bank-export" class="chip">Export</button>
      <label class="chip">Import <input id="bank-import" type="file" accept="application/json,.json" hidden /></label>
      <button id="bank-clear" class="chip">Clear everything</button>
      <span id="bank-msg" class="muted"></span>
    </div>`;

  const save = () => { bankSave(b); renderBank(); };
  const entryOf = (node) => b.entries.find((e) => e.id === node.closest("tr")?.dataset.id);
  const newEntry = (league, yr) => {
    const l = leagues.find((x) => x.id === league) || { id: league };
    return { id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, league, year: yr, dues: leagueSetup(b, l).dues || "", paid: false, extra: "", finish: "", winnings: "", note: "" };
  };
  el.querySelector("#bank-add").onclick = () => {
    b.entries.push(newEntry($("#bank-new-league").value, Number($("#bank-new-year").value) || year));
    save();
  };
  el.querySelector("#bank-add-all").onclick = () => {
    for (const l of leagues) if (!b.entries.some((e) => e.league === l.id && e.year === year)) b.entries.push(newEntry(l.id, year));
    save();
  };
  el.querySelectorAll("#bank-ledger [data-f]").forEach((inp) =>
    inp.addEventListener("change", () => {
      const e = entryOf(inp);
      if (!e) return;
      const f = inp.dataset.f;
      e[f] = f === "paid" ? inp.checked : f === "year" ? Number(inp.value) || year : inp.value;
      save();
    })
  );
  el.querySelectorAll(".bank-del").forEach((btn) =>
    btn.addEventListener("click", () => { const e = entryOf(btn); b.entries = b.entries.filter((x) => x !== e); save(); })
  );
  el.querySelectorAll(".bank-leagues .card").forEach((card) => {
    const id = card.dataset.league;
    const l = leagues.find((x) => x.id === id);
    const setup = () => (b.leagues[id] = { ...(b.leagues[id] || {}), ...(b.leagues[id]?.payouts ? {} : { payouts: leagueSetup(b, l).payouts }) });
    card.querySelectorAll("[data-s]").forEach((inp) => inp.addEventListener("change", () => { setup()[inp.dataset.s] = inp.value; save(); }));
    card.querySelectorAll("[data-p][data-k]").forEach((inp) => inp.addEventListener("change", () => { setup().payouts[inp.dataset.p][inp.dataset.k] = inp.value; save(); }));
    card.querySelector(".bank-add-payout").onclick = () => { const s = setup(); s.payouts = [...(s.payouts || []), { place: s.payouts?.length ? "" : "1st", amount: "" }]; save(); };
    card.querySelectorAll(".bank-del-payout").forEach((btn) => (btn.onclick = () => { setup().payouts.splice(Number(btn.dataset.p), 1); save(); }));
    const del = card.querySelector(".bank-del-league");
    if (del) del.onclick = () => { delete b.leagues[id]; b.entries = b.entries.filter((e) => e.league !== id); save(); };
  });
  el.querySelector("#bank-custom-add").onclick = () => {
    const name = $("#bank-custom-name").value.trim();
    if (!name) return;
    b.leagues[`custom-${Date.now().toString(36)}`] = { custom: true, name, dues: "", teams: "", payouts: [] };
    save();
  };
  el.querySelector("#bank-export").onclick = () => {
    const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `money-bank-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  el.querySelector("#bank-import").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.entries)) throw new Error("not a Money Bank export");
      bankSave({ leagues: data.leagues || {}, entries: data.entries });
      renderBank();
      $("#bank-msg").textContent = `Imported ${data.entries.length} seasons.`;
    } catch (e) {
      $("#bank-msg").textContent = `Couldn't import that file (${e.message}).`;
    }
  });
  el.querySelector("#bank-clear").onclick = () => {
    const btn = el.querySelector("#bank-clear");
    if (btn.dataset.armed) { bankSave({ leagues: {}, entries: [] }); renderBank(); return; }
    btn.dataset.armed = "1";
    btn.textContent = "Click again to erase";
  };
}
