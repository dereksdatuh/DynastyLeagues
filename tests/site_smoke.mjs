// Loads the built site in headless Chrome and clicks through every league:
// rankings, teams (with projected records), a sample trade with owner messages and
// this week's tabs (matchups, players of the week, movers, news).
// Fails on any script error. Usage: node tests/site_smoke.mjs http://localhost:8000/
import { chromium } from "playwright-core";

const url = process.argv[2] || "http://localhost:8000/";
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || "chrome", executablePath: process.env.CHROME_PATH });
const page = await browser.newPage();
const errors = [];
const live = {}; // the browser's own calls to Sleeper and ESPN: host -> [ok, failed]
// Those calls can fail (CORS, rate limits, no network) and the page falls back to
// the build's snapshot, so they are reported rather than failing the check.
const external = (u) => /api\.sleeper\.app|espn\.com/.test(u);
const tally = (u, ok) => { const h = new URL(u).host; (live[h] = live[h] || [0, 0])[ok ? 0 : 1]++; };
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && !/CORS|sleeper|espn/i.test(m.text()) && errors.push(m.text()));
page.on("response", (r) => (external(r.url()) ? tally(r.url(), r.ok()) : r.status() >= 400 && !r.url().endsWith("favicon.ico") && errors.push(`${r.status()} ${r.url()}`)));
page.on("requestfailed", (r) => (external(r.url()) ? tally(r.url(), false) : errors.push(`failed ${r.url()}`)));

await page.goto(url);
await page.waitForSelector("#league-select option", { state: "attached" });
const leagues = await page.$$eval("#league-select option", (os) => os.map((o) => o.value));
for (const id of leagues) {
  // Wait for this league's data rather than an idle network: the page's live
  // Sleeper/ESPN calls can stay open.
  if ((await page.$eval("#league-select", (s) => s.value)) !== id) {
    const loaded = page.waitForResponse((r) => r.url().includes(`data/${id}.json`));
    await page.selectOption("#league-select", id);
    await loaded;
  }
  await page.waitForFunction((id) => document.querySelector("#rankings tbody tr") && document.querySelector("#league-select").value === id, id);
  await page.waitForTimeout(500);
  const players = await page.$$eval("#rankings tbody tr", (r) => r.length);
  await page.click('button[data-tab="teams"]');
  const teams = await page.$$eval("#teams tbody tr", (rs) => rs.map((r) => [...r.cells].map((c) => c.textContent.trim())));
  // Sorting: click "Proj. max PF" and check the column comes out high to low.
  const maxCol = await page.$$eval("#teams thead th", (ths) => ths.findIndex((th) => th.textContent.includes("max PF")));
  await page.click(`#teams thead th:nth-child(${maxCol + 1})`);
  const maxPF = await page.$$eval("#teams tbody tr", (rs, c) => rs.map((r) => Number(r.cells[c].dataset.sort)), maxCol);
  if (maxCol < 0 || maxPF.some((v, i) => i && v > maxPF[i - 1]) || maxPF.some((v) => !(v > 0))) errors.push(`${id}: max PF column missing or not sorted: ${maxPF}`);
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
  const pitches = await page.$$eval(".pitch textarea", (ts) => ts.map((t) => t.value));
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
  await page.click('button[data-tab="rookie"]');
  const mock = await page.$$eval("#rookie table[id^=mock] tbody tr", (rs) => rs.map((r) => [...r.cells].slice(0, 5).map((c) => c.textContent.trim().replace(/\s+/g, " "))));
  const prospects = await page.$$eval("#prospects tbody tr", (r) => r.length);
  const weekNote = await page.$eval("#matchups", (e) => (e.querySelector("p") || e).textContent.trim().slice(0, 120));
  await page.click('button[data-tab="rankings"]');
  console.log(`${id}: ${weekNote}`);
  console.log(`  matchups ${matchups.length} (lineup rows shown ${lineupRows}), players of the week rows ${potwRows}, movers ${movers}, news ${news}, injuries ${injuries}`);
  if (matchups[0]) console.log(`  first matchup: ${matchups[0]}`);
  if (potw.length) console.log(`  top scorers: ${potw.join("; ")}`);
  if (matchups.length && !lineupRows) errors.push(`${id}: matchup lineups did not open`);
  console.log(`  rookie mock: ${mock.length} picks, ${prospects} prospects; ${mock.slice(0, 3).map((m) => `${m[0]} ${m[1]} → ${m[3]} ${m[4]}`).join("; ")}`);
  if (!mock.length) errors.push(`${id}: rookie mock did not render`);
  console.log(`${id}: ${players} players, ${teams.length} teams, top team ${teams[0]?.slice(1, 5).join(" | ")}, max PF high ${maxPF[0]?.toFixed(0)}, impact rows ${impact}, owner messages ${pitches.length}`);
  if (pitches[0]) console.log(pitches[0].split("\n").map((l) => "    " + l).join("\n"));
  if (!players || !teams.length || impact !== 2 || !pitches.length) errors.push(`${id}: page did not render fully`);
}
await browser.close();
console.log("Live calls from the browser (ok, failed):", JSON.stringify(live));
if (errors.length) {
  console.error("Site errors:\n" + errors.join("\n"));
  process.exit(1);
}
