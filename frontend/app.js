const leaguesContainer = document.getElementById("leagues-container");
const leagueListSection = document.getElementById("league-list");
const leagueDetailSection = document.getElementById("league-detail");
const detailTitle = document.getElementById("detail-title");
const leagueFormatEl = document.getElementById("league-format");
const leagueMoneyEl = document.getElementById("league-money");
const rostersTab = document.getElementById("rosters-tab");
const rankingsTab = document.getElementById("rankings-tab");

document.getElementById("back-btn").addEventListener("click", () => {
  leagueDetailSection.classList.add("hidden");
  leagueListSection.classList.remove("hidden");
});

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const target = btn.dataset.tab;
    rostersTab.classList.toggle("hidden", target !== "rosters");
    rankingsTab.classList.toggle("hidden", target !== "rankings");
  });
});

async function loadLeagues() {
  try {
    const leagues = await fetch("/api/leagues").then((r) => r.json());
    leaguesContainer.innerHTML = "";
    if (!leagues.length) {
      leaguesContainer.textContent = "No leagues configured yet.";
      return;
    }
    leagues.forEach((league) => {
      const card = document.createElement("div");
      card.className = "league-card";
      const payouts = league.payouts || {};
      card.innerHTML = `
        <h3>${league.name}</h3>
        <div class="meta">Buy-in: $${league.buy_in} ${league.currency || ""}</div>
        <div class="meta">Payouts: 1st $${payouts["1st"] ?? 0} / 2nd $${payouts["2nd"] ?? 0} / 3rd $${payouts["3rd"] ?? 0}</div>
        ${league.notes ? `<div class="meta">${league.notes}</div>` : ""}
      `;
      card.addEventListener("click", () => openLeague(league));
      leaguesContainer.appendChild(card);
    });
  } catch (err) {
    leaguesContainer.innerHTML = `<p class="error">Failed to load leagues: ${err}</p>`;
  }
}

async function openLeague(league) {
  leagueListSection.classList.add("hidden");
  leagueDetailSection.classList.remove("hidden");
  detailTitle.textContent = league.name;
  leagueFormatEl.innerHTML = "Loading format...";
  leagueMoneyEl.innerHTML = "";
  rostersTab.innerHTML = "Loading rosters...";
  rankingsTab.innerHTML = "";

  renderMoney(league);

  try {
    const rosterData = await fetch(`/api/leagues/${league.id}/rosters`).then((r) => {
      if (!r.ok) throw r;
      return r.json();
    });
    renderFormat(rosterData.value_params);
    renderRosters(rosterData.teams);
  } catch (err) {
    const msg = err.json ? await err.json() : err;
    leagueFormatEl.innerHTML = `<p class="error">${(msg && msg.detail) || "Could not load Sleeper data. Make sure sleeper_league_id is set in data/leagues.json."}</p>`;
    rostersTab.innerHTML = "";
  }

  try {
    const valuesData = await fetch(`/api/leagues/${league.id}/values`).then((r) => {
      if (!r.ok) throw r;
      return r.json();
    });
    renderRankings(valuesData.players);
  } catch (err) {
    rankingsTab.innerHTML = `<p class="error">Could not load player values.</p>`;
  }
}

function renderFormat(params) {
  if (!params) return;
  leagueFormatEl.innerHTML = `
    <div class="format-grid">
      <div class="stat-box"><div class="label">Teams</div><div class="value">${params.num_teams}</div></div>
      <div class="stat-box"><div class="label">QB Format</div><div class="value">${params.is_superflex ? "Superflex" : "1 QB"}</div></div>
      <div class="stat-box"><div class="label">PPR</div><div class="value">${params.ppr}</div></div>
      <div class="stat-box"><div class="label">TE Premium Bonus</div><div class="value">${params.te_premium_bonus || 0}</div></div>
    </div>
  `;
}

function renderMoney(league) {
  const payouts = league.payouts || {};
  const rows = Object.entries(payouts)
    .filter(([k]) => k !== "notes")
    .map(([k, v]) => `<div class="stat-box"><div class="label">${k}</div><div class="value">$${v}</div></div>`)
    .join("");
  leagueMoneyEl.innerHTML = `
    <div class="money-grid">
      <div class="stat-box"><div class="label">Buy-in</div><div class="value">$${league.buy_in} ${league.currency || ""}</div></div>
      ${rows}
    </div>
    ${payouts.notes ? `<p class="meta">${payouts.notes}</p>` : ""}
  `;
}

function renderRosters(teams) {
  rostersTab.innerHTML = "";
  teams.forEach((team) => {
    const block = document.createElement("div");
    block.className = "team-block";
    const rec = team.record || {};
    block.innerHTML = `
      <h3>${team.team_name} <span class="record">${rec.wins ?? 0}-${rec.losses ?? 0}${rec.ties ? "-" + rec.ties : ""} | Total Value: ${team.total_value}</span></h3>
      <table>
        <thead><tr><th>Player</th><th>Pos</th><th>Team</th><th>Value</th><th>Rank</th></tr></thead>
        <tbody>
          ${team.players
            .map(
              (p) => `<tr><td>${p.name}</td><td>${p.position || ""}</td><td>${p.team || ""}</td><td>${p.value}</td><td>${p.league_rank ?? ""}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
    `;
    rostersTab.appendChild(block);
  });
}

function renderRankings(players) {
  const top = players.slice(0, 150);
  rankingsTab.innerHTML = `
    <table>
      <thead><tr><th>Rank</th><th>Player</th><th>Pos</th><th>Pos Rank</th><th>Team</th><th>Age</th><th>Value</th></tr></thead>
      <tbody>
        ${top
          .map(
            (p) => `<tr><td>${p.league_rank}</td><td>${p.name}</td><td>${p.position || ""}</td><td>${p.league_position_rank}</td><td>${p.team || ""}</td><td>${p.age ?? ""}</td><td>${p.league_value}</td></tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

loadLeagues();
