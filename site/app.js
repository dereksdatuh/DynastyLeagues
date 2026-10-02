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
  state.trade = { a: [], b: [] };
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
function effective(values) {
  const v = values.filter((x) => x > 0);
  return v.length ? Math.pow(v.reduce((s, x) => s + Math.pow(x, CONSOLIDATION_POWER), 0), 1 / CONSOLIDATION_POWER) : 0;
}
function balanceNeeded(values, target) {
  const have = values.filter((x) => x > 0).reduce((s, x) => s + Math.pow(x, CONSOLIDATION_POWER), 0);
  const need = Math.pow(target, CONSOLIDATION_POWER) - have;
  return need > 0 ? Math.pow(need, 1 / CONSOLIDATION_POWER) : 0;
}

function setupTrade() {
  const teamOpts = `<option value="">Any team</option>` + state.data.teams.map((t) => `<option value="${t.roster_id}">${esc(t.name)}</option>`).join("");
  document.querySelectorAll(".trade-side").forEach((el) => {
    const side = el.dataset.side;
    const select = el.querySelector(".team-pick");
    select.innerHTML = teamOpts;
    select.onchange = () => { fillDatalist(); renderTrade(); };
    const input = el.querySelector(".asset-search");
    input.value = "";
    input.onchange = () => {
      const a = [...state.assetMap.values()].find((x) => x.label === input.value || x.name === input.value);
      if (a && !state.trade[side].includes(a.id)) state.trade[side].push(a.id);
      input.value = "";
      renderTrade();
    };
  });
  fillDatalist();
  renderTrade();
}

function sideTeam(side) {
  const v = document.querySelector(`.trade-side[data-side="${side}"] .team-pick`).value;
  return v ? Number(v) : null;
}

function fillDatalist() {
  // What team A gets comes from team B's roster (and vice versa) when a team is chosen.
  for (const side of ["a", "b"]) {
    const giver = sideTeam(side === "a" ? "b" : "a");
    const list = [...state.assetMap.values()]
      .filter((x) => x.value > 0 && (giver == null || x.roster_id === giver))
      .sort((x, y) => y.value - x.value)
      .slice(0, 600);
    document.getElementById(`assets-${side}`).innerHTML = list.map((x) => `<option value="${esc(x.label)}">${fmt(x.value)}</option>`).join("");
  }
}

function renderTrade() {
  const vals = {};
  for (const side of ["a", "b"]) {
    const el = document.querySelector(`.trade-side[data-side="${side}"]`);
    const items = state.trade[side].map(assetById).filter(Boolean);
    vals[side] = items.map((x) => x.value);
    el.querySelector(".assets").innerHTML = items
      .map((x) => `<li><span>${esc(x.label)}</span><span class="num">${fmt(x.value)}</span><button data-id="${esc(x.id)}" aria-label="Remove">×</button></li>`)
      .join("");
    el.querySelectorAll(".assets button").forEach((b) =>
      b.addEventListener("click", () => { state.trade[side] = state.trade[side].filter((id) => id !== b.dataset.id); renderTrade(); })
    );
    const raw = vals[side].reduce((s, x) => s + x, 0);
    el.querySelector(".side-total").innerHTML = items.length ? `Total ${fmt(raw)} · Adjusted <strong>${fmt(effective(vals[side]))}</strong>` : "";
  }
  const out = $("#trade-result");
  if (!state.trade.a.length && !state.trade.b.length) {
    out.innerHTML = `<p class="muted">Add what each team receives. Values are this league's, and the adjusted total applies a consolidation premium: one great player is worth more than two good ones that add up to the same raw total.</p>`;
    return;
  }
  const ea = effective(vals.a), eb = effective(vals.b);
  const top = Math.max(ea, eb) || 1;
  const pct = (ea - eb) / top;
  const nameA = sideTeam("a") ? teamName(sideTeam("a")) : "Team A";
  const nameB = sideTeam("b") ? teamName(sideTeam("b")) : "Team B";
  let verdict, short = null, target = 0;
  if (Math.abs(pct) <= FAIR_MARGIN) verdict = "Fair trade";
  else if (pct > 0) { verdict = `${esc(nameA)} wins by ${Math.round(pct * 100)}%`; short = "b"; target = ea; }
  else { verdict = `${esc(nameB)} wins by ${Math.round(-pct * 100)}%`; short = "a"; target = eb; }
  const shareA = ea + eb ? (ea / (ea + eb)) * 100 : 50;
  let suggest = "";
  if (short) {
    const need = balanceNeeded(vals[short], target);
    const giver = sideTeam(short === "a" ? "b" : "a");
    const taken = new Set([...state.trade.a, ...state.trade.b]);
    const cands = [...state.assetMap.values()]
      .filter((x) => !taken.has(x.id) && x.value > 0 && (giver == null || x.roster_id === giver))
      .sort((x, y) => Math.abs(x.value - need) - Math.abs(y.value - need))
      .slice(0, 6)
      .sort((x, y) => y.value - x.value);
    const who = short === "a" ? nameA : nameB;
    suggest = `<p>To even it out, ${esc(who)} should also get about <strong>${fmt(need)}</strong> in value. Closest fits:</p>
      <ul class="suggest">${cands.map((x) => `<li><button data-side="${short}" data-id="${esc(x.id)}">+ ${esc(x.label)} <span class="muted">${fmt(x.value)}</span></button></li>`).join("")}</ul>`;
  }
  out.innerHTML = `<div class="verdict ${short ? "uneven" : "fair"}">${verdict}</div>
    <div class="bar"><div style="width:${shareA}%"></div></div>${suggest}`;
  out.querySelectorAll(".suggest button").forEach((b) =>
    b.addEventListener("click", () => { state.trade[b.dataset.side].push(b.dataset.id); renderTrade(); })
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
