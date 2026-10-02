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
async function init() {
  try {
    state.index = await getJSON("data/index.json");
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
}

// ---------- tabs ----------
document.querySelectorAll(".tabs button").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== `tab-${btn.dataset.tab}`));
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
    el.querySelector(".side-total").innerHTML = items.length ? `Total ${fmt(raw)} · Adjusted <strong>${fmt(effective(gets[i]))}</strong>` : "";
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
  out.innerHTML = `<div class="verdict ${fair ? "fair" : "uneven"}">${verdict}</div>${detail}${suggest}`;
  out.querySelectorAll(".suggest button").forEach((b) =>
    b.addEventListener("click", () => { s[Number(b.dataset.i)].assets.push(b.dataset.id); renderTrade(); })
  );
}

// ---------- teams ----------
function renderTeams() {
  const rows = state.data.teams
    .map((t) => `<tr class="clickable" data-rid="${t.roster_id}">
      <td>${t.power_rank}</td><td class="name">${esc(t.name)}</td>
      <td>${t.record.wins}-${t.record.losses}${t.record.ties ? "-" + t.record.ties : ""}</td>
      <td class="num strong">${fmt(t.total_value)}</td><td class="num">${fmt(t.starter_value)} <span class="muted">(#${t.starter_rank})</span></td>
      <td class="num">${fmt(t.pick_value)}</td><td class="num">${t.proj_week_points || ""}</td>
      <td class="num">${t.starter_age ?? ""}</td><td><span class="outlook ${t.outlook}">${t.outlook}</span></td></tr>`)
    .join("");
  $("#teams").innerHTML = `<thead><tr><th>#</th><th>Team</th><th>Record</th><th class="num">Total value</th>
    <th class="num">Starters</th><th class="num">Picks</th><th class="num">Proj pts (wk)</th><th class="num">Starter age</th><th>Outlook</th></tr></thead><tbody>${rows}</tbody>`;
  $("#teams").querySelectorAll("tr.clickable").forEach((tr) =>
    tr.addEventListener("click", () => { state.teamOpen = Number(tr.dataset.rid); renderTeamDetail(); })
  );
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

init();
