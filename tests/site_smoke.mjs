// Loads the built site in headless Chrome, logs in with a Sleeper username and clicks
// through every league: rankings, teams (with projected records), a sample trade with
// owner messages and this week's tabs (matchups, players of the week, movers, news).
// Then it opens the first league again in quick-values mode (?lite), the path any
// league outside the hourly build takes. Fails on any script error.
// Usage: node tests/site_smoke.mjs http://localhost:8000/ [sleeper username]
// SLEEPER_FIXTURES=file.json answers api.sleeper.app from a {path: response} map
// instead of the network (for running it offline).
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

const site = process.argv[2] || "http://localhost:8000/";
const username = process.argv[3] || process.env.SMOKE_USER || "DS107";
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || "chrome", executablePath: process.env.CHROME_PATH });
const page = await browser.newPage();
const errors = [];
const live = {}; // the browser's own calls to Sleeper and ESPN: host -> [ok, failed]
// Those calls can fail (CORS, rate limits, no network) and the page falls back to
// the build's snapshot, so they are reported rather than failing the check.
const external = (u) => /api\.sleeper\.app|espn\.com/.test(u);
const tally = (u, ok) => { const h = new URL(u).host; (live[h] = live[h] || [0, 0])[ok ? 0 : 1]++; };
page.on("pageerror", (e) => errors.push(e.stack || e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && !/CORS|sleeper|espn/i.test(m.text()) && errors.push(m.text()));
page.on("response", (r) => (external(r.url()) ? tally(r.url(), r.ok()) : r.status() >= 400 && !r.url().endsWith("favicon.ico") && errors.push(`${r.status()} ${r.url()}`)));
page.on("requestfailed", (r) => (external(r.url()) ? tally(r.url(), false) : errors.push(`failed ${r.url()}`)));
if (process.env.SLEEPER_FIXTURES) {
  const fx = JSON.parse(readFileSync(process.env.SLEEPER_FIXTURES, "utf8"));
  await page.route("https://api.sleeper.app/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/v1\//, "");
    route.fulfill(path in fx ? { json: fx[path], headers: { "access-control-allow-origin": "*" } } : { status: 404, body: "null", headers: { "access-control-allow-origin": "*" } });
  });
}

// Nothing shows until someone logs in.
await page.goto(site);
await page.waitForSelector("#welcome:not(.hidden)");
if (await page.$("main:not(.hidden)")) errors.push("league tabs showed before logging in");
await page.fill("#username", "no-such-user-zz9");
await page.click("#login button");
await page.waitForFunction(() => /no user|failed/i.test(document.querySelector("#login-status").textContent));
await page.fill("#username", username);
await page.click("#login button");
await page.waitForSelector("#league-select option", { state: "attached" });
const leagues = await page.$$eval("#league-select option", (os) => os.map((o) => o.value));
console.log(`logged in as ${await page.$eval("#who", (e) => e.textContent)}: ${leagues.length} leagues`);
const runs = [...leagues.map((id) => [id, false]), [leagues[0], true]];
for (const [id, liteRun] of runs) {
  if (liteRun) {
    // Quick-values mode on a built league: everything must still render.
    await page.goto(`${site}?user=${encodeURIComponent(username)}&lite`);
    await page.waitForSelector("#league-select option", { state: "attached" });
  }
  // Wait for this league's data rather than an idle network: the page's live
  // Sleeper/ESPN calls can stay open.
  if ((await page.$eval("#league-select", (s) => s.value)) !== id) await page.selectOption("#league-select", id);
  await page.waitForFunction((id) => document.querySelector("#rankings tbody tr") && document.querySelector("#league-select").value === id
    && /Values updated/.test(document.querySelector("#updated").textContent), id, { timeout: 60000 });
  await page.waitForTimeout(500);
  const lite = await page.$eval("#lite-note", (e) => !e.classList.contains("hidden"));
  if (lite !== (liteRun || !id.startsWith("league-"))) errors.push(`${id}: quick-values note ${lite ? "shown" : "missing"}`);
  if (lite) console.log(`${id} quick values: ${await page.$eval("#lite-note", (e) => e.textContent.replace(/\s+/g, " ").trim().slice(0, 200))}`);
  const players = await page.$$eval("#rankings tbody tr", (r) => r.length);
  // A new league that hasn't drafted yet has empty rosters: no max PF, no trades to judge.
  const drafted = await page.evaluate(() => state.data.teams.some((t) => t.players.length));
  if (!drafted) console.log(`${id}: rosters are empty (not drafted yet), skipping roster-based checks`);
  // Player page: open the top player, check the pieces, close it.
  await page.click("#rankings .player-link");
  await page.waitForSelector("#player-modal:not(.hidden) .buyers tbody tr");
  await page.waitForFunction(() => !/Loading/.test(document.querySelector("#player-history").textContent));
  const playerPage = await page.$eval("#player-body", (b) => `${b.querySelector("h2").textContent.trim()}: ${b.querySelectorAll(".buyers tbody tr").length} team prices, top buyer ${b.querySelector(".buyers tbody tr td").textContent.trim()}, trend ${b.querySelector("#player-history svg") ? "chart" : b.querySelector("#player-history").textContent.trim()}`);
  console.log(`  player page: ${playerPage}`);
  await page.click("#player-modal .modal-close");
  if (!(await page.$("#player-modal.hidden"))) errors.push(`${id}: player page did not close`);
  await page.click('button[data-tab="teams"]');
  const teams = await page.$$eval("#teams tbody tr", (rs) => rs.map((r) => [...r.cells].map((c) => c.textContent.trim())));
  // Sorting: click "Proj. max PF" and check the column comes out high to low.
  const builds = await page.$$eval("#build-legend .card", (cs) => cs.map((c) => c.querySelector("h4").textContent.trim() + " (" + c.querySelectorAll("p")[1].textContent.split(",").length + ")"));
  console.log(`  builds: ${builds.join(", ")}`);
  const fut = await page.$$eval("#future-table tbody tr", (rs) => rs.slice(0, 3).map((r) => [...r.cells].slice(1, 8).map((c) => c.textContent.trim().replace(/\s+/g, " ")).join(" | ")));
  console.log(`  future: ${fut.join("  //  ")}`);
  if (!fut.length && !lite) errors.push(`${id}: future power rankings did not render`);
  if (!builds.length) errors.push(`${id}: team builds did not render`);
  await page.click("#teams tbody tr.clickable");
  if (!(await page.$("#team-detail .build-card"))) errors.push(`${id}: build card missing in team detail`);
  const maxCol = await page.$$eval("#teams thead th", (ths) => ths.findIndex((th) => th.textContent.includes("max PF")));
  await page.click(`#teams thead th:nth-child(${maxCol + 1})`);
  const maxPF = await page.$$eval("#teams tbody tr", (rs, c) => rs.map((r) => Number(r.cells[c].dataset.sort)), maxCol);
  if (maxCol < 0 || maxPF.some((v, i) => i && v > maxPF[i - 1]) || (drafted && maxPF.some((v) => !(v > 0)))) errors.push(`${id}: max PF column missing or not sorted: ${maxPF}`);
  await page.click(`#teams thead th:nth-child(${maxCol + 1})`);
  await page.click(`#teams thead th:nth-child(${maxCol + 1})`); // back to original order
  await page.click('button[data-tab="trade"]');
  const picks = await page.$$(".team-pick");
  const optA = await picks[0].$$eval("option", (os) => os.filter((o) => o.value).map((o) => o.value));
  await picks[0].selectOption(optA[0]);
  await (await page.$$(".team-pick"))[1].selectOption(optA[1]);
  for (const i of [0, 1]) {
    const opt = await page.$eval(`#assets-${i} option`, (o) => o.value);
    const inp = (await page.$$(".asset-search"))[i];
    await inp.fill(opt);
    await inp.dispatchEvent("change");
  }
  const impact = await page.$$eval(".impact tbody tr", (r) => r.length);
  const adjustCard = await page.$eval("#trade-result .adjust", (e) => e.textContent.replace(/\s+/g, " ").trim().slice(0, 240)).catch(() => "");
  const direction = await page.$$eval(".impact tbody tr", (rs) => rs.map((r) => r.cells[1].textContent.replace(/\s+/g, " ").trim()));
  console.log(`  value adjustment: ${adjustCard}\n  direction: ${direction.join(" / ")}`);
  if (drafted && (!adjustCard || direction.some((d) => !d))) errors.push(`${id}: value adjustment or direction missing`);
  // The same trade judged by each team's own situation.
  const lens = await page.$$eval("#trade-result table.net tbody tr", (rs) => rs.map((r) => [...r.cells].map((c) => c.textContent.trim()).join(" | ")));
  const toThem = await page.$$eval(".trade-side .tv", (r) => r.length);
  const pitches = await page.$$eval(".pitch textarea", (ts) => ts.map((t) => t.value));
  // The Lineups tab shows a team's lineup with this trade applied.
  if (drafted && (await page.$("#to-lab"))) {
    await page.click("#to-lab");
    const lab = await page.$eval("#lab .lab-score", (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
    const labRows = await page.$$eval("#lab .lab-col.after .lab-row", (r) => r.length);
    console.log(`  lineups: ${lab} (${labRows} rows after the trade)`);
    if (!lab || !labRows) errors.push(`${id}: lineups after the trade missing`);
    await page.click('button[data-tab="trade"]');
  }
  // The offer grader reads a Sleeper Trade Summary: one top player each way.
  if (drafted) {
    const summary = await page.evaluate(() => {
      const ts = state.data.teams.filter((t) => t.owner && t.players.length).slice(0, 2);
      if (ts.length < 2) return "";
      const top = (t) => state.data.players.filter((p) => p.roster_id === t.roster_id).sort((a, b) => b.value - a.value)[0];
      const [a, b] = ts, pa = top(a), pb = top(b);
      const item = (p) => `${p.name}\n${p.pos} • ${p.team || "FA"}`;
      return `Trade Summary\n${a.owner}\nRECEIVES\nSENDS\n${item(pb)}\nFrom ${b.owner}\n${item(pa)}\nTo ${b.owner}\n${b.owner}\nRECEIVES\nSENDS\n${item(pa)}\nFrom ${a.owner}\n${item(pb)}\nTo ${a.owner}`;
    });
    if (summary) {
      if (!(await page.$eval("#offer-box", (d) => d.open))) await page.click("#offer-box summary");
      await page.fill("#offer-text", summary);
      await page.click("#offer-grade");
      const graded = await page.$$eval("#offer-out table.net tbody tr", (r) => r.length);
      const loaded = await page.evaluate(() => state.trade.sides.map((x) => x.assets.length).join("+"));
      console.log(`  offer grader: ${graded} teams graded, calculator loaded ${loaded}`);
      if (graded !== 2 || loaded !== "1+1") errors.push(`${id}: offer grader didn't read the trade summary (${graded} rows, ${loaded})`);
    }
  }
  // The 2027, 2028 and 2029 classes draw from the research file plus KTC devy values.
  await page.click('button[data-tab="devy"]');
  await page.waitForFunction(() => document.querySelector("#devy .devy-card, #devy p"), null, { timeout: 15000 });
  const devyCards = await page.$$eval("#devy .devy-card", (r) => r.length);
  console.log(`  future rookies: ${devyCards} prospects, top ${await page.$$eval("#devy .devy-name b", (bs) => bs.slice(0, 3).map((b) => b.textContent).join(", "))}`);
  if (!devyCards) errors.push(`${id}: 2027-2029 rookie classes missing`);
  // Pick projections draw a board for every year with tradable picks.
  await page.click('button[data-tab="picks"]');
  const pickCards = await page.$$eval("#pickproj .pick-card", (r) => r.length);
  const hasPicks = await page.evaluate(() => (state.data.picks || []).length > 0);
  console.log(`  pick projections: ${pickCards} cards, yours: ${await page.$$eval("#pickproj .my-pick b", (bs) => bs.slice(0, 4).map((b) => b.textContent).join(", "))}`);
  if (hasPicks && !pickCards) errors.push(`${id}: pick projections missing`);
  await page.click('button[data-tab="trade"]');
  // This week's tabs.
  await page.click('button[data-tab="matchups"]');
  const matchups = await page.$$eval("#matchups .matchup", (ms) => ms.map((m) => [...m.querySelectorAll(".side")].map((s) => s.querySelector(".team").textContent.trim() + " " + s.querySelector(".score").textContent + " (" + s.querySelector(".muted").textContent + ")").join("  vs  ")));
  if (matchups.length && !(await page.$("#matchups .matchup.open"))) await page.click("#matchups .matchup .head");
  const lineupRows = await page.$$eval("#matchups .lineup tbody tr", (r) => r.length);
  await page.click('button[data-tab="potw"]');
  const potw = await page.$$eval("#potw table tbody tr", (rs) => rs.slice(0, 3).map((r) => [...r.cells].slice(1, 5).map((c) => c.textContent.trim()).join(" ")));
  const potwRows = await page.$$eval("#potw table tbody tr", (r) => r.length);
  await page.click('button[data-tab="movers"]');
  const movers = await page.$$eval("#risers tbody tr, #fallers tbody tr", (r) => r.length);
  await page.click('button[data-tab="news"]');
  const news = await page.$$eval("#news ul.news li", (r) => r.length);
  const injuries = await page.$$eval("#injuries tbody tr", (r) => r.length);
  await page.click('button[data-tab="schedule"]');
  const sos = await page.$$eval("#sos tbody tr", (rs) => rs.slice(0, 3).map((r) => [...r.cells].map((c) => c.textContent.trim().replace(/\s+/g, " ")).join(" | ")));
  const sosWeeks = await page.$$eval("#sos-weeks thead th", (r) => r.length - 1);
  await page.click('button[data-tab="finder"]');
  // Lock your most valuable asset, then check no finder deal offers it.
  const lockOpt = await page.$eval("#finder-send-list option", (o) => o.value).catch(() => null);
  if (lockOpt) { await page.fill("#finder-lock", lockOpt); await page.dispatchEvent("#finder-lock", "change"); }
  const lockedLabel = await page.$eval(".untouchables li span", (s) => s.textContent.replace("🔒", "").trim()).catch(() => "");
  if (lockOpt && lockedLabel !== lockOpt) errors.push(`${id}: untouchable did not save (${lockedLabel})`);
  const finderRuns = [];
  for (const kind of ["send", "get"]) {
    // Send your best piece; ask for a mid-priced one (the very top rarely has a fair price from a bench).
    const opt = await page.$$eval(`#finder-${kind}-list option`, (os, k) => (os.length ? os[k === "get" ? Math.min(25, os.length - 1) : 0].value : null), kind).catch(() => null);
    if (!opt) continue;
    await page.fill(`#finder-${kind}`, opt);
    await page.dispatchEvent(`#finder-${kind}`, "change");
    if (kind === "get") { await page.click("#offer-picks"); await page.click("#offer-bench"); }
    // Only what's in "You send" or "OK to add" may ever be offered.
    const allowed = await page.$$eval("#finder .finder-grid .trade-side:first-child .assets li span:first-child", (ss) => ss.map((x) => x.textContent.trim()));
    const t0 = Date.now();
    await page.click("#finder-run");
    await page.waitForFunction(() => !/Searching/.test(document.querySelector("#finder-out").textContent), null, { timeout: 30000 });
    const sentLocked = await page.$$eval("#finder-out .finder-deal", (ds, l) => ds.filter((d) => d.querySelectorAll(".card")[1]?.textContent.includes(l)).length, lockedLabel);
    if (lockedLabel && kind === "get" && sentLocked) errors.push(`${id}: finder offered untouchable ${lockedLabel}`);
    const sent = await page.$$eval("#finder-out .finder-deal", (ds) => ds.flatMap((d) => [...(d.querySelectorAll(".card")[1]?.querySelectorAll("li span:first-child") || [])].map((x) => x.textContent.trim())));
    const stray = sent.filter((x) => !allowed.includes(x));
    if (stray.length) errors.push(`${id}: finder offered pieces not picked: ${[...new Set(stray)].slice(0, 3).join(", ")}`);
    const dir = await page.$eval("#finder-out .finder-deal", (d) => d.textContent.includes("Your direction")).catch(() => true);
    if (!dir) errors.push(`${id}: finder deal has no direction line`);
    const deals = await page.$$eval("#finder-out .finder-deal", (ds) => ds.map((d) => d.textContent.replace(/\s+/g, " ").trim().slice(0, 420)));
    const note = await page.$eval("#finder-out", (e) => e.textContent.replace(/\s+/g, " ").trim().slice(0, 160));
    finderRuns.push(`${kind} ${opt}: ${deals.length} deals in ${Date.now() - t0} ms${deals[0] ? "\n      " + deals[0] : " (" + note + ")"}`);
    await page.click("#finder-out .finder-open").catch(() => {});
    await page.click('button[data-tab="finder"]');
    for (let i = 0; i < 6 && (await page.$("#finder .assets button[data-kind]")); i++) await page.click("#finder .assets button[data-kind]");
  }
  // Three-team finder: you plus two teams, still only offering what you picked.
  if (drafted && (await page.evaluate(() => state.data.teams.length >= 3))) {
    await page.click('button[data-tab="finder"]');
    await page.click('#finder-mode [data-mode="3"]');
    const opts = await page.$$eval('.three-team[data-k="0"] option', (os) => os.map((o) => o.value).filter(Boolean));
    await page.selectOption('.three-team[data-k="0"]', opts[0]);
    await page.selectOption('.three-team[data-k="1"]', opts[1]);
    await page.click("#offer-picks"); await page.click("#offer-bench");
    const allowed3 = await page.$$eval("#finder .finder-grid .trade-side:first-child .assets li span:first-child", (ss) => ss.map((x) => x.textContent.trim()));
    const t3 = Date.now();
    await page.click("#finder-run");
    await page.waitForFunction(() => !/Searching/.test(document.querySelector("#finder-out").textContent), null, { timeout: 60000 });
    const gives3 = await page.$$eval("#finder-out .finder-deal .trade-grid > .trade-side:first-child ul:nth-of-type(2) li span:first-child", (ss) => ss.map((x) => x.textContent.trim()));
    const stray3 = gives3.filter((x) => !allowed3.includes(x));
    if (stray3.length) errors.push(`${id}: three-team finder offered pieces not picked: ${[...new Set(stray3)].slice(0, 3).join(", ")}`);
    const n3 = await page.$$eval("#finder-out .finder-deal", (r) => r.length);
    const err3 = await page.$eval("#finder-out .error", (e) => e.textContent).catch(() => "");
    console.log(`  three-team finder: ${n3} deals in ${Date.now() - t3} ms${err3 ? " (" + err3 + ")" : ""}`);
    await page.click('#finder-mode [data-mode="2"]');
  }
  await page.click('button[data-tab="trades"]');
  await page.waitForTimeout(1500); // the tab also asks Sleeper for trades since the build
  const trades = await page.$$eval("#trades .trade-log", (ts) => ts.map((t) => t.textContent.replace(/\s+/g, " ").trim().slice(0, 260)));
  await page.click('button[data-tab="rookie"]');
  const mock = await page.$$eval("#rookie table[id^=mock] tbody tr", (rs) => rs.map((r) => [...r.cells].slice(0, 6).map((c) => c.textContent.trim().replace(/\s+/g, " "))));
  const prospects = await page.$$eval("#prospects tbody tr", (r) => r.length);
  const standings = await page.$$eval("#standings-now tbody tr", (rs) => rs.map((r) => [...r.cells].map((c) => c.textContent.trim().replace(/\s+/g, " ")).join(" | ")));
  const weekNote = await page.$eval("#matchups", (e) => (e.querySelector("p") || e).textContent.trim().slice(0, 120));
  await page.click('button[data-tab="formula"]');
  const formulaRows = await page.$$eval("#formula-table tbody tr", (r) => r.length);
  const myCalls = await page.$$eval("#formula .calls-grid .card", (cs) => cs.map((c) => c.querySelector("h4").textContent.trim().split(" ")[0] + " " + c.querySelectorAll("li b").length));
  const topFormula = await page.$$eval("#formula-table tbody tr", (rs) => rs.slice(0, 3).map((r) => [...r.cells].slice(1, 4).map((c) => c.textContent.trim().replace(/\s+/g, " ")).join(" ")));
  await page.selectOption("#formula-signal", "BUY");
  const buys = await page.$$eval("#formula-table tbody tr", (r) => r.length);
  await page.selectOption("#formula-signal", "ALL");
  // Trade ideas need a team of your own with players on it.
  const hasTeam = await page.evaluate(() => state.data.teams.some((t) => t.is_me && t.players.length));
  if (hasTeam) {
    const ideaT0 = Date.now();
    await page.click("#ideas-run");
    await page.waitForFunction(() => !/Working/.test(document.querySelector("#ideas-out").textContent), null, { timeout: 120000 });
    const ideaList = await page.$$eval("#ideas-out .idea", (ds) => ds.map((d) => d.textContent.replace(/\s+/g, " ").trim().slice(0, 200)));
    console.log(`  trade ideas: ${ideaList.length} in ${Date.now() - ideaT0} ms\n${ideaList.slice(0, 3).map((x) => "      " + x).join("\n")}`);
    if (!ideaList.length) errors.push(`${id}: trade ideas did not render`);
  } else {
    console.log("  trade ideas: skipped, no team of yours (or no players yet) in this league");
    if (drafted && (await page.$("#ideas-run"))) errors.push(`${id}: trade ideas offered without a team`);
  }
  console.log(`  formula: ${formulaRows} players, ${buys} buys; top ${topFormula.join("; ")}; my calls ${myCalls.join(", ")}`);
  if (!formulaRows) errors.push(`${id}: formula rankings did not render`);
  await page.click('button[data-tab="rankings"]');
  console.log(`${id}: ${weekNote}`);
  console.log(`  trade finder:\n${finderRuns.map((r) => "    " + r).join("\n")}`);
  if (!finderRuns.length) errors.push(`${id}: trade finder had no assets to pick`);
  console.log(`  schedule: ${sosWeeks} weeks left; hardest ${sos.join("  //  ")}`);
  console.log(`  trades ${trades.length}${trades.length ? ": " + trades[0] : ""}`);
  console.log(`  matchups ${matchups.length} (lineup rows shown ${lineupRows}), players of the week rows ${potwRows}, movers ${movers}, news ${news}, injuries ${injuries}`);
  if (matchups[0]) console.log(`  first matchup: ${matchups[0]}`);
  if (potw.length) console.log(`  top scorers: ${potw.join("; ")}`);
  if (matchups.length && !lineupRows) errors.push(`${id}: matchup lineups did not open`);
  console.log(`  rookie mock: ${mock.length} picks, ${prospects} prospects; ${mock.slice(0, 3).map((m) => `${m[0]} (today ${m[1]}) ${m[2]} → ${m[4]} ${m[5]}`).join("; ")}`);
  if (!mock.length && !lite) errors.push(`${id}: rookie mock did not render`);
  console.log(`  standings today:\n${standings.map((r) => "    " + r).join("\n")}`);
  if (mock.length && !standings.length) errors.push(`${id}: standings today did not render`);
  console.log(`${id}: ${players} players, ${teams.length} teams, top team ${teams[0]?.slice(1, 5).join(" | ")}, max PF high ${maxPF[0]?.toFixed(0)}, impact rows ${impact}, owner messages ${pitches.length}`);
  if (pitches[0]) console.log(pitches[0].split("\n").map((l) => "    " + l).join("\n"));
  console.log(`  by each team's situation: ${lens.join("; ")} (to-them values shown ${toThem})`);
  if (lens.length !== 2) errors.push(`${id}: team-situation trade view did not render`);
  if (!players || !teams.length || impact !== 2 || !pitches.length) errors.push(`${id}: page did not render fully`);
}
// Money Bank: add a season for every league, fill one in, and check it survives a reload
// (the ?user= link logs back in).
await page.click('button[data-tab="bank"]');
await page.click("#bank-add-all");
const bankRows = await page.$$eval("#bank-ledger tbody tr[data-id]", (r) => r.length);
if (bankRows !== leagues.length) errors.push(`money bank: expected ${leagues.length} rows, got ${bankRows}`);
await page.fill('#bank-ledger tr[data-id] [data-f="dues"]', "100");
await page.dispatchEvent('#bank-ledger tr[data-id] [data-f="dues"]', "change");
await page.check('#bank-ledger tr[data-id] [data-f="paid"]');
await page.fill('#bank-ledger tr[data-id] [data-f="winnings"]', "250");
await page.dispatchEvent('#bank-ledger tr[data-id] [data-f="winnings"]', "change");
await page.reload();
await page.waitForSelector("#bank .stats", { state: "attached" });
const bank = await page.$$eval("#bank .stats div", (ds) => ds.map((d) => d.textContent.replace(/\s+/g, " ").trim()));
console.log(`money bank after reload: ${bank.join(" | ")}`);
if (!bank.some((t) => t.includes("Net") && t.includes("$150"))) errors.push(`money bank totals wrong after reload: ${bank}`);
await page.evaluate(() => localStorage.removeItem("moneybank.v1"));
await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("untouchable.")).forEach((k) => localStorage.removeItem(k)));
await browser.close();
console.log("Live calls from the browser (ok, failed):", JSON.stringify(live));
if (errors.length) {
  console.error("Site errors:\n" + errors.join("\n"));
  process.exit(1);
}
