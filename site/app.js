// Dynasty Leagues: static front end over the JSON the engine builds (site/data/).

const CONSOLIDATION_POWER = 1.35; // keep in sync with engine/trade.py
const FAIR_MARGIN = 0.05;
const POSITIONS = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "K", "DEF"];

const state = { index: null, data: null, pos: "ALL", trade: { a: [], b: [] }, teamOpen: null };
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (n == null ? "" : Math.round(n).toLocaleString());

async function getJSON(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// ---------- data helpers ----------
function teamName(rid) {
  const t = state.data.teams.find((t) => t.roster_id === rid);
  return t ? t.name : "";
}
function assets() {
  const players = state.data.players.map((p) => ({ ...p, kind: "player", label: `${p.name} (${p.pos}${p.team ? ", " + p.team : ""})` }));
  const picks = state.data.picks.map((p) => ({
    ...p, kind: "pick", name: p.label, pos: "PICK",
    label: p.label.includes("(via") ? p.label : `${p.label} (${teamName(p.original_roster_id)})`,
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

async function init() {
  try {
    state.index = await getJSON("data/index.json");
    if (reloadIfStale(state.index.build)) return;
  } catch (e) {
    $("main").innerHTML = `<p class="error">No data built yet. Run <code>python -m engine.build</code> (the scheduled GitHub Action does this daily).</p>`;
    return;
  }
  const sel = $("#league-select");
  sel.innerHTML = state.index.leagues.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
  const saved = localStorageGet("league");
  if (saved && state.index.leagues.some((l) => l.id === saved)) sel.value = saved;
  sel.addEventListener("change", () => loadLeague(sel.value));
  if (state.index.leagues.length) loadLeague(sel.value);
}

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

async function loadLeague(id) {
  localStorageSet("league", id);
  state.data = await getJSON(`data/${id}.json`);
  state.assetMap = new Map(assets().map((a) => [a.id, a]));
  state.trade = { sides: [newSide(), newSide()] };
  state.teamOpen = null;
  const when = new Date(state.data.generated_at);
  $("#updated").textContent = `Updated ${when.toLocaleString()}${state.data.league.week ? ` · Week ${state.data.league.week}` : ""}`;
  renderPosFilter();
  renderRankings();
  setupTrade();
  renderTeams();
  renderLeague();
  setupWeek();
}

// ---------- tabs ----------
document.querySelectorAll(".tabs button").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== `tab-${btn.dataset.tab}`));
    // Coming back to Matchups after a while: refresh scores now rather than at the next poll.
    const L = state.live;
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
      .map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.label)}</td><td>${esc(teamName(p.roster_id))}</td><td class="num strong">${fmt(p.value)}</td></tr>`)
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
      const sep = p[tierKey] !== lastTier ? `<tr class="tier-row"><td colspan="11">Tier ${p[tierKey]}</td></tr>` : "";
      lastTier = p[tierKey];
      const src = Object.entries(p.sources || {}).map(([k, v]) => `${k}: ${fmt(v)}`).join("\n");
      return `${sep}<tr>
        <td>${byPos ? p.pos_rank : p.rank}</td>
        <td><span class="name">${esc(p.name)}</span>${p.injury ? ` <span class="inj">${esc(p.injury)}</span>` : ""}</td>
        <td><span class="pos pos-${p.pos}">${p.pos}${p.pos_rank}</span></td>
        <td>${esc(p.team || "FA")}</td>
        <td class="num">${p.age ?? ""}</td>
        <td class="num strong">${fmt(p.value)}</td>
        <td class="num muted" title="${esc(src)}">${p.market ? fmt(p.market) : "–"}</td>
        <td class="num muted">${p.model ? fmt(p.model) : "–"}</td>
        <td>${fitBadge(p.premium)}</td>
        <td class="num">${p.ppg ?? ""}${p.proj_week != null ? ` <span class="muted">/ ${p.proj_week}</span>` : ""}</td>
        <td class="muted">${esc(p.roster_id ? teamName(p.roster_id) : "FA")}</td>
      </tr>`;
    })
    .join("");
  table.innerHTML = `<thead><tr><th>#</th><th>Player</th><th>Pos</th><th>Team</th><th class="num">Age</th>
    <th class="num" title="Final league value">Value</th><th class="num" title="Consensus across sites">Market</th>
    <th class="num" title="League scoring production model">Model</th><th title="Scoring fit">Fit</th>
    <th class="num" title="Points per game in this league's scoring / projected this week">PPG / Wk</th><th>Owner</th></tr></thead><tbody>${body}</tbody>`;
}

// ---------- trade calculator ----------
// Each side lists what that team receives. An asset is sent by the team that
// owns it; in a two-team trade with no teams picked, by the other side.
const LETTERS = "ABCD";

function effective(values) {
  const v = values.filter((x) => x > 0);
  return v.length ? Math.pow(v.reduce((s, x) => s + Math.pow(x, CONSOLIDATION_POWER), 0), 1 / CONSOLIDATION_POWER) : 0;
}
function balanceNeeded(values, target) {
  const have = values.filter((x) => x > 0).reduce((s, x) => s + Math.pow(x, CONSOLIDATION_POWER), 0);
  const need = Math.pow(target, CONSOLIDATION_POWER) - have;
  return need > 0 ? Math.pow(need, 1 / CONSOLIDATION_POWER) : 0;
}

const newSide = () => ({ team: null, assets: [] });
const sides = () => state.trade.sides;
const sideName = (i) => (sides()[i].team ? teamName(sides()[i].team) : `Team ${LETTERS[i]}`);

function senderOf(asset, i) {
  const s = sides();
  if (asset.roster_id != null) {
    const j = s.findIndex((x, k) => k !== i && x.team === asset.roster_id);
    if (j >= 0) return j;
  }
  return s.length === 2 ? 1 - i : -1;
}

function setupTrade() {
  if (!state.trade || !state.trade.sides) state.trade = { sides: [newSide(), newSide()] };
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
    state.data.teams.map((t) => `<option value="${t.roster_id}" ${t.roster_id === sel ? "selected" : ""}>${esc(t.name)}</option>`).join("");
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
  document.querySelectorAll(".trade-side").forEach((el) => {
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
  const unassigned = [];
  const base = leagueStrength();
  const baseRanks = base.ranks;
  s.forEach((side, i) => {
    side.assets.map(assetById).filter(Boolean).forEach((a) => {
      gets[i].push(a.value);
      const from = senderOf(a, i);
      if (from >= 0) gives[from].push(a.value);
      else unassigned.push(a);
    });
  });
  s.forEach((side, i) => {
    const el = document.querySelector(`.trade-side[data-i="${i}"]`);
    const items = side.assets.map(assetById).filter(Boolean);
    el.querySelector(".assets").innerHTML = items
      .map((x) => {
        const from = senderOf(x, i);
        const tag = multi ? `<span class="muted from">${from >= 0 ? "from " + esc(sideName(from)) : "sender not in trade"}</span>` : "";
        return `<li><span>${esc(x.label)}${tag}</span><span class="num">${fmt(x.value)}</span><button data-id="${esc(x.id)}" aria-label="Remove">×</button></li>`;
      })
      .join("");
    el.querySelectorAll(".assets button").forEach((b) =>
      b.addEventListener("click", () => { side.assets = side.assets.filter((id) => id !== b.dataset.id); renderTrade(); })
    );
    const raw = gets[i].reduce((t, x) => t + x, 0);
    let needLine = "";
    if (side.team != null) {
      const nd = needsOf(side.team, baseRanks);
      needLine = `<div class="needs">Needs: ${nd.needs.map((p) => `<span class="pos pos-${p}">${p}</span>`).join(" ") || "none"}${nd.strengths.length ? ` · Strong at ${nd.strengths.join(", ")}` : ""}</div>`;
    }
    el.querySelector(".side-total").innerHTML = (items.length ? `Total ${fmt(raw)} · Adjusted <strong>${fmt(effective(gets[i]))}</strong>` : "") + needLine;
  });

  const out = $("#trade-result");
  if (!s.some((x) => x.assets.length)) {
    out.innerHTML = `<p class="muted">Add what each team receives${multi ? " (pick each team first, so the calculator knows who sends what)" : ""}. Values are this league's, and the adjusted total applies a consolidation premium: one great player is worth more than two good ones that add up to the same raw total.</p>`;
    return;
  }
  if (multi && s.some((x) => x.team == null)) {
    out.innerHTML = `<p class="error">Pick a team for every side in a ${s.length}-team trade.</p>`;
    return;
  }
  // Net for each team: adjusted value received minus adjusted value sent.
  const rows = s.map((_, i) => {
    const g = effective(gets[i]), v = effective(gives[i]);
    const top = Math.max(g, v) || 1;
    return { i, g, v, pct: (g - v) / top };
  });
  const fair = rows.every((r) => Math.abs(r.pct) <= FAIR_MARGIN);
  const winner = rows.reduce((a, b) => (b.pct > a.pct ? b : a));
  const loser = rows.reduce((a, b) => (b.pct < a.pct ? b : a));
  let verdict;
  if (fair) verdict = "Fair trade";
  else if (!multi) verdict = `${esc(sideName(winner.i))} wins by ${Math.round(winner.pct * 100)}%`;
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
  if (unassigned.length) {
    detail += `<p class="error">Not counted as sent by anyone: ${unassigned.map((a) => esc(a.label)).join(", ")}. Their owner isn't one of the teams in this trade.</p>`;
  }

  let suggest = "";
  if (!fair) {
    // Close the biggest gap: the biggest loser gets more from the biggest winner.
    const need = balanceNeeded(gets[loser.i], effective(gives[loser.i]));
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
  out.innerHTML = `<div class="verdict ${fair ? "fair" : "uneven"}">${verdict}</div>${detail}${suggest}`
    + tradeImpact(s, overrides, ctx.before, after, recBefore, recAfter) + renderPitches(ctx);
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
      return `<tr><td class="name">${esc(t.name)}</td>${rankCell(ranks.starters[t.roster_id], n)}${pos.map((p) => rankCell(ranks[p][t.roster_id], n)).join("")}
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
    out[rid] = { ppg: ppg[rid], wins: t.record.wins + w, losses: t.record.losses + g - w, ties: t.record.ties || 0, games: g, maxPF };
  }
  Object.keys(out).sort((a, b) => out[b].wins - out[a].wins || out[b].ppg - out[a].ppg).forEach((rid, i) => (out[rid].rank = i + 1));
  Object.keys(out).sort((a, b) => out[b].maxPF - out[a].maxPF).forEach((rid, i) => (out[rid].maxPFRank = i + 1));
  return out;
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

// How a trade changes each involved team's starters and rooms, by league rank.
function tradeImpact(s, overrides, before, after, recBefore, recAfter) {
  if (!Object.keys(overrides).length) return "";
  const arrow = (b, a) => (a < b ? `<span class="up">#${b} → #${a}</span>` : a > b ? `<span class="down">#${b} → #${a}</span>` : `<span class="muted">#${b}</span>`);
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
    return `<tr><td class="name">${esc(teamName(rid))}</td>
      <td>${recCell}</td>
      <td class="num">${fmt(sb)} → ${fmt(sa)} <span class="${diff > 0 ? "up" : diff < 0 ? "down" : "muted"}">(${diff >= 0 ? "+" : ""}${fmt(diff)})</span></td>
      <td>${arrow(before.ranks.starters[rid], after.ranks.starters[rid])}</td>
      <td>${moved.map((p) => `${p} ${arrow(before.ranks[p][rid], after.ranks[p][rid])}`).join("<br>") || '<span class="muted">no change</span>'}</td>
      <td>${notes || (need.length ? `<span class="muted">needs ${need.join(", ")}</span>` : "")}</td></tr>`;
  });
  return `<h3>Roster impact</h3><div class="table-wrap"><table class="impact"><thead><tr><th>Team</th><th>Projected record</th><th class="num">Starter value</th><th>Starters rank</th><th>Position rooms (league rank)</th><th>Needs</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
    <p class="muted">Ranks are among all ${state.data.teams.length} teams after the trade. A room is its starters' value plus a little credit for the next ${DEPTH_COUNT} backups. Picks don't change these ranks.
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
    return `<div class="pitch"><div class="pitch-head"><strong>To ${esc(p.owner)}</strong> <span class="muted">${esc(teamName(p.rid))}</span><button class="copy">Copy</button></div>
      ${p.strong ? "" : `<p class="down">Nothing in this deal clearly helps them on value, needs or record, so expect a tough sell.</p>`}
      <textarea readonly rows="${Math.min(14, p.text.split("\n").length + 1)}">${esc(p.text)}</textarea></div>`;
  });
  return `<h3>Messages to owners</h3>
    <p class="muted">Each message only lists reasons that are true for that owner. Copy it and send it in Sleeper yourself (<a href="${link}" target="_blank" rel="noopener">open league</a>); nothing is sent automatically.</p>
    <div class="pitches">${cards.join("")}</div>`;
}

// ---------- teams ----------
function renderTeams() {
  const recs = projectRecords();
  const rows = state.data.teams
    .map((t) => `<tr class="clickable" data-rid="${t.roster_id}">
      <td>${t.power_rank}</td><td class="name">${esc(t.name)}</td>
      <td data-sort="${t.record.wins + 0.5 * (t.record.ties || 0) - t.record.losses / 1000}">${t.record.wins}-${t.record.losses}${t.record.ties ? "-" + t.record.ties : ""}</td>
      <td data-sort="${recs[t.roster_id] ? recs[t.roster_id].wins : ""}">${recs[t.roster_id] ? `${recordText(recs[t.roster_id])} <span class="muted">(${ordinal(recs[t.roster_id].rank)})</span>` : ""}</td>
      <td class="num" data-sort="${recs[t.roster_id] ? recs[t.roster_id].maxPF : ""}" title="Max PF so far: ${fmt(t.record.max_pf || 0)}">${recs[t.roster_id] ? `${fmt(recs[t.roster_id].maxPF)} <span class="muted">(${ordinal(recs[t.roster_id].maxPFRank)})</span>` : ""}</td>
      <td class="num strong">${fmt(t.total_value)}</td><td class="num" data-sort="${t.starter_value}">${fmt(t.starter_value)} <span class="muted">(#${t.starter_rank})</span></td>
      <td class="num">${fmt(t.pick_value)}</td><td class="num">${t.proj_week_points || ""}</td>
      <td class="num">${t.starter_age ?? ""}</td><td><span class="outlook ${t.outlook}">${t.outlook}</span></td></tr>`)
    .join("");
  $("#teams").innerHTML = `<thead><tr><th>#</th><th>Team</th><th>Record</th><th>Projected</th><th class="num" title="Projected end-of-season max PF: max PF so far plus the best lineup's projected points for each regular-season week left">Proj. max PF</th><th class="num">Total value</th>
    <th class="num">Starters</th><th class="num">Picks</th><th class="num">Proj pts (wk)</th><th class="num">Starter age</th><th>Outlook</th></tr></thead><tbody>${rows}</tbody>`;
  $("#teams").querySelectorAll("tr.clickable").forEach((tr) =>
    tr.addEventListener("click", () => { state.teamOpen = Number(tr.dataset.rid); renderTeamDetail(); })
  );
  $("#record-note").textContent = recordNote();
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
  el.innerHTML = `<h2>${esc(t.name)} <span class="muted">${esc(t.owner || "")}</span></h2>
    <div class="cols">${Object.entries(groups)
      .sort((a, b) => POSITIONS.indexOf(a[0]) - POSITIONS.indexOf(b[0]))
      .map(([pos, ps]) => `<div class="card"><h4>${pos}</h4><ul>${ps
        .map((p) => `<li class="${starters.has(p.id) ? "starter" : ""}"><span>${esc(p.name)}${t.taxi.includes(p.id) ? ' <span class="muted">taxi</span>' : ""}</span><span class="num">${fmt(p.value)}</span></li>`)
        .join("")}</ul></div>`)
      .join("")}
      <div class="card"><h4>Picks</h4><ul>${picks.map((p) => `<li><span>${esc(p.label)}</span><span class="num">${fmt(p.value)}</span></li>`).join("") || "<li>None</li>"}</ul></div>
    </div><p class="muted">Bold = in the optimal starting lineup by value.</p>`;
}

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
const ownerTag = (rid) => (rid ? esc(teamName(rid)) : '<span class="muted">FA</span>');
const starMine = (rid) => (myTeam() && rid === myTeam().roster_id ? ' <span class="mine" title="Your player">★</span>' : "");

function setupWeek() {
  const wk = state.data.week || {};
  if (state.live) clearTimeout(state.live.timer); // previous league's polling
  state.live = { week: wk.week, matchups: wk.matchups || [], games: wk.games || {}, at: null, source: "snapshot", open: new Set() };
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
    const [rows, board] = await Promise.all([
      fetch(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${L.week}`).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${L.week}&dates=${state.data.week.season}`)
        .then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (state.live !== L) return; // league switched meanwhile
    L.matchups = rows.map((r) => ({ roster_id: r.roster_id, matchup_id: r.matchup_id, points: r.points, starters: r.starters, players_points: r.players_points }));
    if (board) L.games = gameStatus(board);
    L.at = new Date();
    L.source = "live";
  } catch (e) {
    L.source = "snapshot";
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
  const sideHtml = (s, odds) => `<div class="side"><div class="team">${esc(teamName(s.rid))}${starMine(s.rid)}</div>
      <div class="score">${s.points.toFixed(2)}</div>
      <div class="muted">proj ${s.proj.toFixed(1)} · ${s.left} left · ${Math.round(odds * 100)}% to win</div></div>`;
  const lineup = (s) => `<div><table class="lineup"><thead><tr><th>Player</th><th>Game</th><th class="num">Pts</th><th class="num">Proj</th><th class="num">Left</th></tr></thead><tbody>${s.starters
      .map((x) => `<tr class="${x.left > 0 ? "" : "done"}"><td><span class="pos pos-${x.p.pos}">${x.p.pos}</span> ${esc(x.p.name)} <span class="muted">${esc(x.p.team || "")}</span></td>
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
