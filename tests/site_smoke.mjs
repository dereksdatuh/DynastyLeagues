// Loads the built site in headless Chrome and clicks through every league:
// rankings, teams (with projected records) and a sample trade with owner messages.
// Fails on any script error. Usage: node tests/site_smoke.mjs http://localhost:8000/
import { chromium } from "playwright-core";

const url = process.argv[2] || "http://localhost:8000/";
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || "chrome", executablePath: process.env.CHROME_PATH });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => r.status() >= 400 && !r.url().endsWith("favicon.ico") && errors.push(`${r.status()} ${r.url()}`));
page.on("requestfailed", (r) => errors.push(`failed ${r.url()}`));

await page.goto(url);
await page.waitForSelector("#league-select option", { state: "attached" });
const leagues = await page.$$eval("#league-select option", (os) => os.map((o) => o.value));
for (const id of leagues) {
  await page.selectOption("#league-select", id);
  await page.waitForLoadState("networkidle");
  await page.waitForSelector("#rankings tbody tr", { state: "attached" });
  const players = await page.$$eval("#rankings tbody tr", (r) => r.length);
  await page.click('button[data-tab="teams"]');
  const teams = await page.$$eval("#teams tbody tr", (rs) => rs.map((r) => [...r.cells].map((c) => c.textContent.trim())));
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
  await page.click('button[data-tab="rankings"]');
  console.log(`${id}: ${players} players, ${teams.length} teams, top team ${teams[0]?.slice(1, 4).join(" | ")}, impact rows ${impact}, owner messages ${pitches.length}`);
  if (pitches[0]) console.log(pitches[0].split("\n").map((l) => "    " + l).join("\n"));
  if (!players || !teams.length || impact !== 2 || !pitches.length) errors.push(`${id}: page did not render fully`);
}
await browser.close();
if (errors.length) {
  console.error("Site errors:\n" + errors.join("\n"));
  process.exit(1);
}
