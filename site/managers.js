// ---------- deep manager profiles ----------
// Everything here is worked out in the visitor's browser from Sleeper's public API:
// every league the manager is in, back DEEP_SEASONS seasons (trades, waivers and FAAB,
// drops, lineups, drafts). Nothing about any manager is built into this public site.
// Derived profiles are cached in this browser's localStorage; your offer log, notes and
// pasted league chat live only there too. Values are today's values, not what the
// pieces were worth on the day of the deal.
const DEEP_SEASONS = 4;
const DEEP_MAX_LEAGUES = 14; // league-seasons per manager, newest dynasty leagues first
const DEEP_TTL = 6 * 3600 * 1000;
const DEEP_PARALLEL = 6;
const DEEP_VERSION = 1;
const deep = { mem: new Map(), profiles: new Map(), loading: new Map(), active: 0, queue: [], map: null };

function deepFetch(path) {
  if (deep.mem.has(path)) return deep.mem.get(path);
  const run = () => fetch(SLEEPER_API + path).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const p = new Promise((resolve) => {
    const go = () => { deep.active++; run().then((x) => { deep.active--; resolve(x); const n = deep.queue.shift(); if (n) n(); }); };
    if (deep.active < DEEP_PARALLEL) go(); else deep.queue.push(go);
  });
  deep.mem.set(path, p);
  return p;
}

const deepKey = (uid) => `deep.v${DEEP_VERSION}.${uid}`;
const uidOf = (rid) => { const t = state.data && state.data.teams.find((x) => x.roster_id === rid); return t ? t.owner_id || null : null; };
function deepGet(rid) {
  const uid = uidOf(rid);
  if (!uid) return null;
  if (deep.profiles.has(uid)) return deep.profiles.get(uid);
  try {
    const c = JSON.parse(localStorageGet(deepKey(uid)) || "null");
    if (c && c.prof && Date.now() - c.at < DEEP_TTL) { deep.profiles.set(uid, c.prof); return c.prof; }
  } catch { /* fall through */ }
  return null;
}

function deepPlayer(id) {
  const a = state.assetMap.get(id);
  if (a && a.kind !== "pick") return a;
  return (state.data.players || []).find((p) => p.id === id) || null;
}
const deepPlayerValue = (id) => { const p = deepPlayer(id); return p ? p.market || p.value || 0 : 0; };
let deepRoundCache = null;
function deepPickValue(round) {
  if (!deepRoundCache || deepRoundCache.data !== state.data) {
    const by = {};
    for (const pk of state.data.picks || []) (by[pk.round] = by[pk.round] || []).push(pk.value || 0);
    deepRoundCache = { data: state.data, by: Object.fromEntries(Object.entries(by).map(([r, xs]) => [r, xs.reduce((a, b) => a + b, 0) / xs.length])) };
  }
  return deepRoundCache.by[round] ?? ([0, 3000, 1200, 600, 300][round] || 150);
}

// One league-season seen from one manager.
async function deepLeague(lg, uid, curSeason, curWeek) {
  const lid = lg.league_id;
  const [rosters, users] = await Promise.all([deepFetch(`league/${lid}/rosters`), deepFetch(`league/${lid}/users`)]);
  if (!Array.isArray(rosters)) return null;
  const mine = rosters.find((r) => r.owner_id === uid || (r.co_owners || []).includes(uid));
  if (!mine) return null;
  const rid = mine.roster_id;
  const ownerOf = new Map(rosters.map((r) => [r.roster_id, r.owner_id]));
  const nameOf = new Map((users || []).map((u) => [u.user_id, u.display_name]));
  const live = String(lg.season) === String(curSeason);
  const lastWeek = live ? Math.min(18, Math.max(1, curWeek + 1)) : 18;
  const weeks = Array.from({ length: lastWeek + 1 }, (_, i) => i);
  const txs = (await Promise.all(weeks.map((w) => deepFetch(`league/${lid}/transactions/${w}`)))).flat().filter(Boolean);
  const seen = new Set();
  const tx = txs.filter((t) => t.status === "complete" && !seen.has(t.transaction_id) && seen.add(t.transaction_id));
  // Lineups: only this season's leagues, weeks already played.
  let lineup = null;
  if (live && curWeek > 1) {
    const wk = Array.from({ length: Math.min(curWeek - 1, 17) }, (_, i) => i + 1);
    const ms = await Promise.all(wk.map((w) => deepFetch(`league/${lid}/matchups/${w}`)));
    lineup = { weeks: 0, slots: 0, empty: 0, zero: 0, lastEmpty: 0 };
    ms.forEach((m, k) => {
      const e = (m || []).find((x) => x.roster_id === rid);
      if (!e || !Array.isArray(e.starters)) return;
      lineup.weeks++;
      e.starters.forEach((pid, j) => {
        lineup.slots++;
        if (!pid || pid === "0") { lineup.empty++; if (k === wk.length - 1) lineup.lastEmpty++; }
        else if ((e.starters_points || [])[j] === 0) lineup.zero++;
      });
    });
  }
  // Drafts: their own picks against what those players are worth now.
  const drafts = (await deepFetch(`league/${lid}/drafts`)) || [];
  const picks = [];
  for (const d of drafts.filter((x) => x.status === "complete")) {
    const [rows, full] = await Promise.all([deepFetch(`draft/${d.draft_id}/picks`), deepFetch(`draft/${d.draft_id}`)]);
    if (!Array.isArray(rows) || !rows.length) continue;
    const startup = (d.settings?.rounds || 0) >= 10 && String(d.season) === String(lg.season) && !lg.previous_league_id;
    const valued = rows.map((r) => ({ r, v: deepPlayerValue(r.player_id) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
    const vRank = new Map(valued.map((x, i) => [x.r.pick_no, i + 1]));
    const slotRoster = (full && full.slot_to_roster_id) || {};
    for (const r of rows.filter((x) => x.picked_by === uid || x.roster_id === rid)) {
      const p = deepPlayer(r.player_id), m = r.metadata || {};
      picks.push({ startup, pick: r.pick_no, round: r.round, vrank: vRank.get(r.pick_no) || null, pid: r.player_id,
        name: p ? p.name : `${m.first_name || ""} ${m.last_name || ""}`.trim(), pos: p ? p.pos : m.position, team: p ? p.team : m.team,
        college: p ? p.college || null : null, bought: slotRoster[r.draft_slot] != null && slotRoster[r.draft_slot] !== rid });
    }
  }
  return { lid, name: lg.name, season: String(lg.season), dynasty: (lg.settings || {}).type === 2, rid, ownerOf, nameOf, tx, lineup, picks,
    players: mine.players || [], taxi: mine.taxi || [], reserve: mine.reserve || [], waiverBudget: (lg.settings || {}).waiver_budget || 100 };
}

async function deepLoad(rid, onStep) {
  const uid = uidOf(rid);
  if (!uid) throw new Error("This team has no Sleeper owner yet.");
  if (deep.loading.has(uid)) return deep.loading.get(uid);
  const job = (async () => {
    const cur = Number((state.nfl && (state.nfl.league_season || state.nfl.season)) || state.data.league.season || new Date().getFullYear());
    const curWeek = Number((state.nfl && state.nfl.week) || state.data.league.week || 1);
    const seasons = Array.from({ length: DEEP_SEASONS }, (_, i) => cur - i);
    const lists = await Promise.all(seasons.map((y) => deepFetch(`user/${uid}/leagues/nfl/${y}`)));
    let leagues = lists.flat().filter(Boolean);
    leagues.sort((a, b) => ((b.settings || {}).type === 2) - ((a.settings || {}).type === 2) || Number(b.season) - Number(a.season));
    leagues = leagues.slice(0, DEEP_MAX_LEAGUES);
    let done = 0;
    const got = await Promise.all(leagues.map((lg) => deepLeague(lg, uid, cur, curWeek).then((x) => { done++; if (onStep) onStep(done, leagues.length); return x; })));
    const prof = deepDerive(uid, got.filter(Boolean), cur);
    deep.profiles.set(uid, prof);
    localStorageSet(deepKey(uid), JSON.stringify({ at: Date.now(), prof }));
    return prof;
  })();
  deep.loading.set(uid, job);
  try { return await job; } finally { deep.loading.delete(uid); }
}

// ---------- turning history into traits ----------
const AGE_BUCKET = (a) => (a == null ? null : a <= 24 ? "young (24 and under)" : a <= 28 ? "prime (25-28)" : "veterans (29+)");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function inc(o, k, n = 1) { if (k != null) o[k] = (o[k] || 0) + n; }
const topKeys = (o, n = 3) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function deepDerive(uid, leagues, curSeason) {
  const trades = [], waivers = [], drops = [], times = [], acquired = {}, rostered = {}, partners = {}, sharedWith = {};
  const nflTeams = {}, colleges = {}, pickTiming = { buy: {}, sell: {} };
  let lineup = { weeks: 0, slots: 0, empty: 0, zero: 0, lastEmpty: 0 };
  const picks = [];
  let taxi = 0, ir = 0;
  const now = Date.now();
  for (const L of leagues) {
    for (const [r, u] of L.ownerOf) if (u && u !== uid) inc(sharedWith, u);
    for (const [u, n] of L.nameOf) if (u !== uid && n) partners[u] = partners[u] || { name: n, trades: 0, leagues: 0 };
    for (const [r, u] of L.ownerOf) if (u && u !== uid && partners[u]) partners[u].leagues++;
    if (String(L.season) === String(curSeason)) {
      for (const pid of L.players) {
        inc(rostered, pid);
        const p = deepPlayer(pid);
        if (p && p.team) inc(nflTeams, p.team);
        if (p && p.college) inc(colleges, p.college);
      }
      taxi += L.taxi.length; ir += L.reserve.length;
      if (L.lineup) for (const k of Object.keys(lineup)) lineup[k] += L.lineup[k];
    }
    for (const pk of L.picks) { picks.push(pk); inc(acquired, pk.pid); }
    for (const t of L.tx) {
      const at = t.status_updated || t.created;
      if (t.creator === uid) times.push(at);
      if (t.type === "trade") {
        if (!(t.roster_ids || []).includes(L.rid)) continue;
        if (t.creator !== uid) times.push(at);
        const ins = [], outs = [];
        for (const [pid, to] of Object.entries(t.adds || {})) {
          const p = deepPlayer(pid), a = { kind: "player", id: pid, name: p ? p.name : pid, pos: p ? p.pos : "", age: p ? p.age : null, team: p ? p.team : null, v: deepPlayerValue(pid) };
          if (to === L.rid) { ins.push(a); inc(acquired, pid); }
          else if ((t.drops || {})[pid] === L.rid) outs.push(a);
        }
        for (const pk of t.draft_picks || []) {
          const a = { kind: "pick", name: `${pk.season} round ${pk.round}`, pos: "PICK", season: pk.season, round: pk.round, v: Number(pk.season) >= curSeason ? deepPickValue(pk.round) : deepPickValue(pk.round) * 0.8 };
          if (pk.owner_id === L.rid) ins.push(a); else if (pk.previous_owner_id === L.rid) outs.push(a);
        }
        for (const w of t.waiver_budget || []) {
          const a = { kind: "faab", name: `$${w.amount} FAAB`, pos: "FAAB", v: w.amount * 8 };
          if (w.receiver === L.rid) ins.push(a); else if (w.sender === L.rid) outs.push(a);
        }
        const vin = ins.reduce((s, a) => s + a.v, 0), vout = outs.reduce((s, a) => s + a.v, 0);
        const others = (t.roster_ids || []).filter((r) => r !== L.rid).map((r) => L.ownerOf.get(r)).filter(Boolean);
        others.forEach((u) => { if (partners[u]) partners[u].trades++; });
        const m = new Date(at).getMonth();
        if (ins.some((a) => a.kind === "pick")) inc(pickTiming.buy, MONTHS[m]);
        if (outs.some((a) => a.kind === "pick")) inc(pickTiming.sell, MONTHS[m]);
        trades.push({ at, league: L.name, season: L.season, leg: t.leg, proposed: t.creator === uid, partners: others.map((u) => L.nameOf.get(u) || "?"), partnerIds: others,
          ins: ins.map(({ name, pos, age, v, kind, id, team }) => ({ name, pos, age, v: Math.round(v), kind, id, team })),
          outs: outs.map(({ name, pos, age, v, kind, id, team }) => ({ name, pos, age, v: Math.round(v), kind, id, team })),
          vin: Math.round(vin), vout: Math.round(vout), net: (vin - vout) / Math.max(vin, vout, 1) });
      } else if (t.type === "waiver" || t.type === "free_agent") {
        if (!(t.roster_ids || []).includes(L.rid)) continue;
        for (const [pid, to] of Object.entries(t.adds || {})) if (to === L.rid) {
          const p = deepPlayer(pid);
          inc(acquired, pid);
          waivers.push({ at, bid: t.type === "waiver" ? Number((t.settings || {}).waiver_bid || 0) : null, budget: L.waiverBudget, pos: p ? p.pos : "?", name: p ? p.name : pid });
        }
      }
      if ((t.type === "waiver" || t.type === "free_agent" || t.type === "commissioner") && t.drops) {
        for (const [pid, from] of Object.entries(t.drops)) if (from === L.rid && !(t.adds || {})[pid]) {
          const p = deepPlayer(pid);
          drops.push({ at, name: p ? p.name : pid, age: p ? p.age : null, v: deepPlayerValue(pid), pos: p ? p.pos : "?", leg: t.leg });
        }
      }
    }
  }
  trades.sort((a, b) => b.at - a.at);
  const seasonsSeen = new Set(leagues.map((L) => L.season)).size || 1;
  const leagueSeasons = leagues.length || 1;

  // 1. Value bias by what they went and got (the biggest piece coming in).
  const bias = {};
  for (const t of trades) {
    if (!t.ins.length || !t.vin) continue;
    const top = t.ins.slice().sort((a, b) => b.v - a.v)[0];
    const over = (t.vout - t.vin) / Math.max(t.vin, 1);
    for (const k of [top.pos, top.kind === "player" ? AGE_BUCKET(top.age) : null]) if (k) (bias[k] = bias[k] || []).push(over);
  }
  const biasOut = Object.entries(bias).filter(([, xs]) => xs.length >= 2).map(([k, xs]) => ({ k, pct: mean(xs), n: xs.length }))
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  // 2. Overpay / underpay rate.
  const valued = trades.filter((t) => t.vin + t.vout > 0);
  const overpay = valued.filter((t) => t.net < -0.05).length, underpay = valued.filter((t) => t.net > 0.05).length;
  // 3. Crushes: the same player brought in more than once, or rostered in several leagues now.
  const crushes = Object.entries(acquired).filter(([, n]) => n >= 2).map(([pid, n]) => ({ pid, n, on: rostered[pid] || 0 }))
    .concat(Object.entries(rostered).filter(([pid, n]) => n >= 3 && !(acquired[pid] >= 2)).map(([pid, n]) => ({ pid, n: 0, on: n })))
    .map((c) => ({ ...c, name: (deepPlayer(c.pid) || {}).name || null, v: deepPlayerValue(c.pid) }))
    .filter((c) => c.name && c.v > 300).sort((a, b) => b.n + b.on - (a.n + a.on) || b.v - a.v).slice(0, 6);
  // 4. Loyalty: an NFL team or school far over its fair share of their players.
  const totalTeam = Object.values(nflTeams).reduce((a, b) => a + b, 0);
  const teamLoyal = topKeys(nflTeams, 3).filter(([, n]) => n >= 4 && n / Math.max(totalTeam, 1) >= 2.5 / 32).map(([k, n]) => ({ k, n, share: n / totalTeam }));
  const totalCol = Object.values(colleges).reduce((a, b) => a + b, 0);
  const draftCol = {};
  picks.forEach((p) => p.college && inc(draftCol, p.college));
  const schoolLoyal = topKeys(Object.fromEntries(Object.keys({ ...colleges, ...draftCol }).map((k) => [k, (colleges[k] || 0) + 2 * (draftCol[k] || 0)])), 3)
    .filter(([, n]) => n >= 4 && totalCol >= 10 && n / (totalCol + picks.length) >= 0.07).map(([k, n]) => ({ k, n }));
  // 5. Window: what the last year of trades says, picks and ages in vs out.
  const yearAgo = now - 365 * 86400000;
  const recent = trades.filter((t) => t.at >= yearAgo);
  const pIn = recent.reduce((s, t) => s + t.ins.filter((a) => a.kind === "pick").reduce((x, a) => x + a.v, 0), 0);
  const pOut = recent.reduce((s, t) => s + t.outs.filter((a) => a.kind === "pick").reduce((x, a) => x + a.v, 0), 0);
  const agesIn = recent.flatMap((t) => t.ins.filter((a) => a.age).map((a) => a.age)), agesOut = recent.flatMap((t) => t.outs.filter((a) => a.age).map((a) => a.age));
  const ageGap = agesIn.length && agesOut.length ? mean(agesIn) - mean(agesOut) : 0;
  const lean = (pIn - pOut) / Math.max(pIn + pOut, 2000) - ageGap / 4;
  const window = recent.length < 2 ? null : lean > 0.2 ? "rebuild" : lean < -0.2 ? "contend" : "retool";
  // 6. Consolidator or spreader: pieces in vs pieces out.
  const pcsIn = trades.reduce((s, t) => s + t.ins.filter((a) => a.kind !== "faab").length, 0), pcsOut = trades.reduce((s, t) => s + t.outs.filter((a) => a.kind !== "faab").length, 0);
  const pieceRatio = trades.length >= 2 ? pcsOut / Math.max(pcsIn, 1) : 1;
  const style = trades.length < 2 ? null : pieceRatio >= 1.35 ? "consolidator" : pieceRatio <= 0.75 ? "spreader" : "even";
  // 8. Appetite.
  const perSeason = trades.length / leagueSeasons;
  const proposedShare = trades.length ? trades.filter((t) => t.proposed).length / trades.length : null;
  // 9/activity clock.
  times.sort((a, b) => b - a);
  const dow = {}, hour = {};
  times.forEach((t) => { const d = new Date(t); inc(dow, DAYS[d.getDay()]); inc(hour, d.getHours()); });
  const last = times[0] || null;
  const gaps = times.slice(0, 40).map((t, i, xs) => (i ? (xs[i - 1] - t) / 3600000 : null)).filter((x) => x != null).sort((a, b) => a - b);
  const medianGapHrs = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const moves30 = times.filter((t) => now - t < 30 * 86400000).length;
  // FAAB habits.
  const bids = waivers.filter((w) => w.bid != null);
  const faab = bids.length ? { n: bids.length, avgPct: mean(bids.map((w) => w.bid / Math.max(w.budget, 1))), maxPct: Math.max(...bids.map((w) => w.bid / Math.max(w.budget, 1))),
    zero: bids.filter((w) => !w.bid).length / bids.length } : null;
  const chase = {};
  waivers.forEach((w) => inc(chase, w.pos));
  // 10. Panic: talent cut loose, quick flips, sells at a loss in season.
  const valuableDrops = drops.filter((d) => d.v >= 1500);
  const youngDrops = drops.filter((d) => d.age && d.age <= 24 && d.v >= 600);
  const vetDrops = drops.filter((d) => d.age && d.age >= 29);
  const lossSells = trades.filter((t) => t.leg >= 3 && t.leg <= 14 && t.net < -0.12).length;
  const flips = trades.filter((t) => t.outs.some((a) => a.kind === "player" && trades.some((u) => u.at < t.at && t.at - u.at < 21 * 86400000 && u.ins.some((b) => b.id === a.id)))).length;
  const panic = Math.min(100, 22 * valuableDrops.length + 12 * lossSells + 10 * flips + 6 * youngDrops.length);
  // 11. Friends and the ones they never deal with.
  const plist = Object.entries(partners).map(([u, p]) => ({ uid: u, ...p }));
  const friends = plist.filter((p) => p.trades >= 2).sort((a, b) => b.trades - a.trades).slice(0, 4);
  const avoids = trades.length >= 4 ? plist.filter((p) => p.trades === 0 && p.leagues >= 2).sort((a, b) => b.leagues - a.leagues).slice(0, 4) : [];
  // Drafts: reaches against today's values; positions they reach on.
  const scored = picks.filter((p) => p.vrank);
  const reachPos = {};
  scored.forEach((p) => (reachPos[p.pos] = reachPos[p.pos] || []).push(p.vrank - p.pick));
  const reaches = Object.entries(reachPos).filter(([, xs]) => xs.length >= 2).map(([pos, xs]) => ({ pos, avg: mean(xs), n: xs.length })).sort((a, b) => b.avg - a.avg);
  const draft = { n: picks.length, rookie: picks.filter((p) => !p.startup).length, bought: picks.filter((p) => p.bought).length,
    avgReach: scored.length ? mean(scored.map((p) => p.vrank - p.pick)) : null, reaches,
    best: scored.slice().sort((a, b) => (a.vrank - a.pick) - (b.vrank - b.pick))[0] || null };

  return {
    uid, at: now, leagues: leagues.map((L) => ({ name: L.name, season: L.season, dynasty: L.dynasty })), seasons: seasonsSeen, leagueSeasons,
    trades: trades.slice(0, 40), tradeCount: trades.length, perSeason, proposedShare,
    bias: biasOut.slice(0, 4), overpay: valued.length ? overpay / valued.length : null, underpay: valued.length ? underpay / valued.length : null, valuedN: valued.length,
    crushes, teamLoyal, schoolLoyal, window, pickLean: { pIn: Math.round(pIn), pOut: Math.round(pOut), ageGap }, style, pieceRatio,
    pickTiming: { buy: topKeys(pickTiming.buy, 2), sell: topKeys(pickTiming.sell, 2) },
    clock: { dow: topKeys(dow, 2), hour: topKeys(hour, 2), last, medianGapHrs, moves30, n: times.length },
    faab, chase: topKeys(chase, 3), waivers: waivers.length,
    drops: { n: drops.length, valuable: valuableDrops.slice(0, 3).map((d) => d.name), young: youngDrops.length, vets: vetDrops.length },
    taxi, ir, lineup, panic, flips, lossSells, friends, avoids, draft,
  };
}

// ---------- your private side: offer log and pasted chat ----------
const OFFER_KEY = "offers.v1";
function offerLog() { try { return JSON.parse(localStorageGet(OFFER_KEY) || "[]"); } catch { return []; } }
function logOffer(entry) { const xs = offerLog(); xs.push(entry); localStorageSet(OFFER_KEY, JSON.stringify(xs.slice(-400))); }
const offersWith = (uid) => offerLog().filter((o) => o.uid === uid);
const chatKey = (uid) => `chat.${uid}`;

function negotiationRead(text) {
  if (!text || text.trim().length < 20) return null;
  const t = text.toLowerCase(), c = (re) => (t.match(re) || []).length;
  const counters = c(/\bcounter|how about|what if|would you do|could you do|instead\b/g);
  const throwIns = c(/throw in|add (a|in|on)|sweeten|one more|a little more|small add|plus a/g);
  const firm = c(/\bfirm\b|final offer|not moving|won'?t budge|take it or leave|non.?negotiable|best i can do/g);
  const picks = c(/\bpicks?\b|\b1st\b|\b2nd\b|\bfirsts?\b|\bseconds?\b|\b20(2[6-9]|3\d)\b/g);
  const no = c(/\bpass\b|\bno thanks\b|\bnah\b|not interested|i'?m good/g);
  const yes = c(/\bdeal\b|\baccept(ed)?\b|\blet'?s do it\b|\bsend it\b|\bsounds good\b/g);
  const bits = [];
  if (counters >= 2) bits.push("counters instead of saying no, so open a little high and leave room");
  if (throwIns >= 2) bits.push("always asks for a throw-in, so hold a small pick back to add at the end");
  if (firm >= 1) bits.push("talks firm; give them a clean, finished offer");
  if (picks >= 3) bits.push("talks picks a lot; lead with picks");
  if (no >= 2 && yes === 0) bits.push("says no fast; send your best version first");
  if (yes >= 2) bits.push("closes deals in chat; worth working a deal there");
  return bits.length ? bits : ["nothing stands out in the chat yet"];
}

// ---------- reading a profile ----------
const pctTxt = (x) => `${Math.round(Math.abs(x) * 100)}%`;
function deepRead(prof, rid) {
  if (!prof) return [];
  const out = [];
  const ctx = teamCtx(rid);
  const win = prof.window || (ctx ? (ctx.label === "contending" ? "contend" : ctx.label === "middle" ? "retool" : "rebuild") : null);
  if (win) out.push({ k: "Window", v: { contend: "Contending: buys points now, sells picks", retool: "Retooling: trades sideways, keeps a foot in both", rebuild: "Rebuilding: buys picks and youth" }[win] + (ctx ? ` (here: ${ctx.label})` : "") });
  if (prof.bias.length) out.push({ k: "Value bias", v: prof.bias.slice(0, 3).map((b) => `${b.pct > 0 ? "pays" : "gets"} ${pctTxt(b.pct)} ${b.pct > 0 ? "over" : "under"} for ${b.k === "PICK" ? "picks" : b.k === "FAAB" ? "FAAB" : /^[A-Z]{1,3}$/.test(b.k) ? b.k + "s" : b.k} (${b.n} deals)`).join("; ") });
  if (prof.overpay != null && prof.valuedN >= 2) out.push({ k: "Overpay rate", v: `loses ${pctTxt(prof.overpay)} of trades by 5%+, wins ${pctTxt(prof.underpay)} (on today's values, ${prof.valuedN} trades)` });
  if (prof.crushes.length) out.push({ k: "Player crushes", v: prof.crushes.slice(0, 4).map((c) => `${c.name}${c.n >= 2 ? ` (got him ${c.n}x)` : ""}${c.on >= 2 ? ` (on ${c.on} of their rosters)` : ""}`).join(", ") });
  const loyal = prof.teamLoyal.map((t) => `${t.k} (${t.n} players)`).concat(prof.schoolLoyal.map((s) => `${s.k} (${s.n})`));
  if (loyal.length) out.push({ k: "Team and school loyalty", v: loyal.join(", ") });
  if (prof.style) out.push({ k: "Deal shape", v: prof.style === "consolidator" ? `consolidator: sends ${prof.pieceRatio.toFixed(1)} pieces for every 1 back` : prof.style === "spreader" ? `spreader: takes more pieces back than they send (${(1 / prof.pieceRatio).toFixed(1)} for 1)` : "even pieces both ways" });
  const pt = prof.pickTiming;
  if (pt.buy.length || pt.sell.length) out.push({ k: "Pick timing", v: [pt.buy.length ? `buys picks in ${pt.buy.map((x) => x[0]).join("/")}` : "", pt.sell.length ? `sells picks in ${pt.sell.map((x) => x[0]).join("/")}` : ""].filter(Boolean).join(", ") });
  out.push({ k: "Trade appetite", v: `${prof.tradeCount} trades in ${prof.leagueSeasons} league-seasons (${prof.perSeason.toFixed(1)} a season)${prof.proposedShare != null && prof.tradeCount >= 3 ? `; proposes ${pctTxt(prof.proposedShare)} of them` : ""}` });
  const c = prof.clock;
  const mine = offersWith(prof.uid).filter((o) => o.outcome && o.outcome !== "pending");
  const answered = mine.filter((o) => o.outcome !== "ignored");
  out.push({ k: "Responsiveness", v: (mine.length ? `answered ${answered.length} of ${mine.length} offers you logged. ` : "")
    + (c.last ? `Last move ${ago(c.last)}; ${c.moves30} moves in 30 days${c.medianGapHrs != null ? `, usually ${c.medianGapHrs < 24 ? `${Math.round(c.medianGapHrs)} hours` : `${Math.round(c.medianGapHrs / 24)} days`} between moves` : ""}` : "no moves found")
    + (c.dow.length ? `; most active ${c.dow.map((x) => x[0]).join("/")} around ${c.hour.map((x) => hourTxt(Number(x[0]))).join("/")}` : "") });
  out.push({ k: "Panic score", v: `${prof.panic}/100${prof.drops.valuable.length ? `; cut ${prof.drops.valuable.join(", ")}` : ""}${prof.lossSells ? `; ${prof.lossSells} in-season sells at a loss` : ""}${prof.flips ? `; ${prof.flips} quick flips` : ""}` });
  const fr = prof.friends.map((f) => `${f.name} (${f.trades})`), av = prof.avoids.map((f) => f.name);
  if (fr.length || av.length) out.push({ k: "Friends and rivals", v: [fr.length ? `trades most with ${fr.join(", ")}` : "", av.length ? `never trades with ${av.join(", ")}` : ""].filter(Boolean).join("; ") });
  if (prof.faab || prof.waivers) out.push({ k: "Waivers and FAAB", v: `${prof.waivers} pickups${prof.faab ? `; bids ${pctTxt(prof.faab.avgPct)} of budget on average, top ${pctTxt(prof.faab.maxPct)}${prof.faab.zero > 0.3 ? `, ${pctTxt(prof.faab.zero)} at $0` : ""}` : ""}${prof.chase.length ? `; chases ${prof.chase.map((x) => x[0]).join(", ")}` : ""}` });
  const L = prof.lineup;
  if (L.slots) out.push({ k: "Lineups", v: `${L.empty} empty slots and ${L.zero} zero-point starts in ${L.weeks} weeks this season${L.lastEmpty ? ` (${L.lastEmpty} empty last week)` : ""}` });
  const d = prof.draft;
  if (d.n) out.push({ k: "Drafting", v: `${d.n} picks (${d.rookie} rookie)${d.avgReach != null ? `, ${d.avgReach >= 0 ? "takes value" : "reaches"} by ${Math.abs(d.avgReach).toFixed(1)} spots on today's values` : ""}${d.reaches.length && d.reaches[d.reaches.length - 1].avg < -1 ? `; reaches most on ${d.reaches[d.reaches.length - 1].pos}` : ""}${d.bought ? `; ${d.bought} picks made with acquired slots` : ""}` });
  out.push({ k: "Roster habits", v: `${prof.taxi} on taxi, ${prof.ir} on IR now; dropped ${prof.drops.young} young players and ${prof.drops.vets} vets 29+` });
  return out;
}
function ago(ts) {
  const h = (Date.now() - ts) / 3600000;
  return h < 1 ? "under an hour ago" : h < 48 ? `${Math.round(h)} hours ago` : `${Math.round(h / 24)} days ago`;
}
const an = (pos) => `${/^[AEFHILMNORSX]/.test(pos) ? "an" : "a"} ${pos}`;
const hourTxt = (h) => `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;

// A plain-English paragraph that leads with what matters for a trade.
function deepSummary(prof, rid) {
  if (!prof) return "";
  const t = teamOf(rid), who = managerOf(t) || t.name, bits = [];
  const w = prof.window;
  bits.push(`${who} has made ${prof.tradeCount} trade${prof.tradeCount === 1 ? "" : "s"} across ${prof.leagueSeasons} league-season${prof.leagueSeasons === 1 ? "" : "s"}${w ? ` and trades like a ${w === "contend" ? "contender" : w === "rebuild" ? "rebuilder" : "retooler"}` : ""}.`);
  const b = prof.bias.find((x) => x.pct > 0.08);
  if (b) bits.push(`They pay about ${pctTxt(b.pct)} over for ${/^[A-Z]{1,4}$/.test(b.k) ? (b.k === "PICK" ? "picks" : b.k + "s") : b.k}, so that's what to sell them.`);
  const u = prof.bias.find((x) => x.pct < -0.08);
  if (u) bits.push(`They only buy ${/^[A-Z]{1,4}$/.test(u.k) ? (u.k === "PICK" ? "picks" : u.k + "s") : u.k} at a discount.`);
  if (prof.crushes[0]) bits.push(`Soft spot: ${prof.crushes[0].name.replace(/\.$/, "")}.`);
  if (prof.style === "consolidator") bits.push("They like 2-for-1s where they get the best player.");
  else if (prof.style === "spreader") bits.push("They like getting several pieces back for one.");
  if (prof.clock.last && Date.now() - prof.clock.last > 30 * 86400000) bits.push("They haven't made a move in over a month, so they may be checked out.");
  else if (prof.panic >= 40) bits.push("They react fast to bad news, so pitch them right after an injury or a loss.");
  return bits.join(" ");
}

// ---------- accept chance ----------
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
// theyGet / theySend: assets from that team's side. gain: their market gain (fraction),
// needs: their gain on their own needs. Works without a deep profile, just rougher.
function acceptChance(rid, theyGet, theySend, gain, needs) {
  if (managerNotes(rid).block) return { p: 0, why: ["you marked them as won't trade with you"], rough: false };
  const prof = deepGet(rid), why = [];
  let g = 0.5 * (gain || 0) + 0.5 * (needs ?? gain ?? 0);
  if (prof) {
    const vin = theyGet.reduce((s, a) => s + (a.value || 0), 0) || 1;
    for (const b of prof.bias) {
      const hit = theyGet.filter((a) => (b.k === "PICK" ? a.kind === "pick" : a.pos === b.k || (a.kind === "player" && AGE_BUCKET(a.age) === b.k)));
      if (!hit.length) continue;
      const share = hit.reduce((s, a) => s + (a.value || 0), 0) / vin;
      g += 0.5 * b.pct * share;
      if (b.pct > 0.08 && share > 0.3) why.push(`they pay over for ${b.k === "PICK" ? "picks" : /^[A-Z]{1,3}$/.test(b.k) ? b.k + "s" : b.k}`);
    }
  }
  let z = -0.35 + 9 * g;
  if (g > 0.03) why.push(`they gain about ${Math.round(g * 100)}% the way they value things`);
  else if (g < -0.03) why.push(`they lose about ${Math.round(-g * 100)}% the way they value things`);
  const h = managerHistory(rid);
  if (prof) {
    z += Math.max(-1, Math.min(0.8, Math.log((prof.perSeason + 0.3) / 2))) * 0.6;
    if (prof.perSeason >= 4) why.push("they trade a lot"); else if (prof.perSeason < 1) why.push("they rarely trade");
    const picksIn = theyGet.some((a) => a.kind === "pick"), ages = (xs) => mean(xs.filter((a) => a.kind === "player" && a.age).map((a) => a.age));
    const ai = ages(theyGet), ao = ages(theySend);
    if (prof.window === "rebuild") { if (picksIn || (ai != null && ao != null && ai < ao)) { z += 0.35; why.push("fits their rebuild"); } else if (ai != null && ai >= 28) z -= 0.35; }
    if (prof.window === "contend") { if (ai != null && (ao == null || ai >= ao) && !picksIn) { z += 0.3; why.push("helps them win now"); } else if (picksIn && !theyGet.some((a) => a.kind === "player")) z -= 0.4; }
    const nIn = theyGet.length, nOut = theySend.length;
    if (prof.style === "consolidator" && nIn < nOut) { z += 0.3; why.push("they get the best player, which they like"); }
    if (prof.style === "spreader" && nIn > nOut) { z += 0.3; why.push("they get more pieces, which they like"); }
    const crush = theyGet.find((a) => prof.crushes.some((c) => c.pid === a.id));
    if (crush) { z += 0.5; why.push(`they've chased ${crush.name || crush.label} before`); }
    if (prof.clock.last && Date.now() - prof.clock.last > 30 * 86400000) { z -= 0.8; why.push("no moves in a month"); }
    const myUid = state.user && state.user.user_id, f = prof.friends.find((x) => x.uid === myUid);
    if (f) { z += 0.3; why.push(`you've traded ${f.trades} times before`); }
    else if (prof.avoids.some((x) => x.uid === myUid)) { z -= 0.5; why.push("they've never traded with you in shared leagues"); }
  } else {
    if (h.trades >= 3) z += 0.3; else if (!h.trades) z -= 0.2;
    if (h.withMe) z += 0.2;
  }
  // Your logged offers to them pull the estimate toward what actually happened.
  const uid = uidOf(rid);
  const logged = uid ? offersWith(uid).filter((o) => o.outcome && o.outcome !== "pending" && o.p != null) : [];
  if (logged.length) {
    const score = { accepted: 1, countered: 0.5, declined: 0, ignored: 0 };
    const resid = mean(logged.map((o) => score[o.outcome] - o.p));
    z += 2 * resid * Math.min(logged.length, 5) / 5;
    why.push(`${logged.filter((o) => o.outcome === "accepted").length} of ${logged.length} of your logged offers accepted`);
  }
  return { p: Math.max(0.03, Math.min(0.95, sigmoid(z))), why: why.slice(0, 4), rough: !prof };
}
const acceptTxt = (a) => `${Math.round(a.p * 100)}% chance they say yes${a.rough ? " (rough: load their deep profile for a better read)" : ""}`;

// Extra pitch lines that lean on what this manager cares about. Only true things.
function deepPitch(rid, getsA, sendsA) {
  const prof = deepGet(rid), out = [];
  if (!prof) return out;
  const crush = getsA.find((a) => prof.crushes.some((c) => c.pid === a.id));
  if (crush) out.push(`You've gone after ${crush.name} before, and here's your chance to land him.`);
  const b = prof.bias.find((x) => x.pct > 0.08 && getsA.some((a) => (x.k === "PICK" ? a.kind === "pick" : a.pos === x.k)));
  if (b) out.push(b.k === "PICK" ? "You get picks without paying the usual premium." : `You get ${an(b.k)} without paying the premium ${b.k}s usually cost.`);
  if (prof.style === "consolidator" && getsA.length < sendsA.length) out.push("You consolidate into the best player in the deal and open a roster spot.");
  if (prof.style === "spreader" && getsA.length > sendsA.length) out.push("You turn one piece into several, which adds depth for byes and injuries.");
  const loyal = prof.teamLoyal[0];
  if (loyal && getsA.some((a) => a.team === loyal.k)) out.push(`Another ${loyal.k} guy for your roster.`);
  return out;
}

// ---------- alerts and league map ----------
const OUT_STATUS = new Set(["Out", "IR", "Doubtful", "PUP", "Sus", "NA"]);
function deepAlerts() {
  const out = [], meRid = myTeam()?.roster_id;
  for (const t of state.data.teams) {
    if (t.roster_id === meRid) continue;
    const who = managerOf(t) || t.name, prof = deepGet(t.roster_id);
    const hurt = (t.lineup || []).map((x) => deepPlayer(x.id)).filter((p) => p && p.injury && OUT_STATUS.has(p.injury));
    for (const p of hurt.slice(0, 2)) {
      let line = `${who} has a starter down: ${p.name} (${p.pos}, ${p.injury}).`;
      if (prof) {
        const last = prof.trades.slice(0, 6), bought = last.filter((tr) => tr.ins.some((a) => a.pos === p.pos)).length;
        if (bought >= 2) line += ` They bought ${an(p.pos)} in ${bought} of their last ${last.length} trades. Offer them one.`;
        else line += ` They may need ${an(p.pos)}.`;
      } else line += ` They may need ${an(p.pos)}.`;
      out.push({ tone: "warn", text: line, rid: t.roster_id });
    }
    if (prof) {
      const c = prof.clock;
      if (c.last && Date.now() - c.last < 3 * 86400000 && prof.tradeCount) out.push({ tone: "up", text: `${who} is active right now (last move ${ago(c.last)}).`, rid: t.roster_id });
      else if (c.last && Date.now() - c.last > 30 * 86400000) out.push({ tone: "muted", text: `${who} looks checked out: no moves in ${Math.round((Date.now() - c.last) / 86400000)} days.`, rid: t.roster_id });
      if (prof.lineup.lastEmpty) out.push({ tone: "muted", text: `${who} left ${prof.lineup.lastEmpty} lineup slot${prof.lineup.lastEmpty > 1 ? "s" : ""} empty last week somewhere.`, rid: t.roster_id });
    }
  }
  const rank = { warn: 0, up: 1, muted: 2 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone] || /Offer them/.test(b.text) - /Offer them/.test(a.text)).slice(0, 10);
}

// Trades between this league's managers, this league and its past seasons.
async function deepLeagueMap() {
  const lid = state.data.league.sleeper_league_id;
  if (!lid) return null;
  if (deep.map && deep.map.lid === lid) return deep.map;
  const pairs = {}, count = {};
  let id = lid, hops = 0;
  while (id && hops < DEEP_SEASONS) {
    const [lg, rosters] = await Promise.all([deepFetch(`league/${id}`), deepFetch(`league/${id}/rosters`)]);
    if (!lg || !Array.isArray(rosters)) break;
    const ownerOf = new Map(rosters.map((r) => [r.roster_id, r.owner_id]));
    const weeks = Array.from({ length: 19 }, (_, i) => i);
    const txs = (await Promise.all(weeks.map((w) => deepFetch(`league/${id}/transactions/${w}`)))).flat().filter((t) => t && t.type === "trade" && t.status === "complete");
    const seen = new Set();
    for (const t of txs) {
      if (seen.has(t.transaction_id)) continue;
      seen.add(t.transaction_id);
      const us = (t.roster_ids || []).map((r) => ownerOf.get(r)).filter(Boolean);
      us.forEach((u) => inc(count, u));
      for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++) { const k = [us[i], us[j]].sort().join("|"); inc(pairs, k); }
    }
    id = lg.previous_league_id && lg.previous_league_id !== "0" ? lg.previous_league_id : null;
    hops++;
  }
  deep.map = { lid, pairs, count, seasons: hops };
  return deep.map;
}

function leagueMapHtml(map) {
  const teams = state.data.teams.filter((t) => t.owner_id);
  const short = (t) => esc((managerOf(t) || t.name).slice(0, 10));
  const max = Math.max(1, ...Object.values(map.pairs));
  const rows = teams.map((a) => {
    const ctx = teamCtx(a.roster_id), prof = deepGet(a.roster_id);
    const cells = teams.map((b) => {
      if (a === b) return `<td class="muted">·</td>`;
      const n = map.pairs[[a.owner_id, b.owner_id].sort().join("|")] || 0;
      return `<td class="num" style="${n ? `background: color-mix(in srgb, var(--accent, #2bd9a0) ${Math.round(15 + 55 * n / max)}%, transparent)` : ""}">${n || ""}</td>`;
    }).join("");
    const status = prof && prof.clock.last ? (Date.now() - prof.clock.last > 30 * 86400000 ? "checked out" : Date.now() - prof.clock.last < 7 * 86400000 ? "active" : "quiet") : "";
    return `<tr><th>${short(a)}</th><td>${esc(ctx ? ctx.label : a.outlook || "")}</td><td class="muted">${status}</td><td class="num">${map.count[a.owner_id] || 0}</td>${cells}</tr>`;
  }).join("");
  return `<p class="muted">Trades between each pair in this league over the last ${map.seasons} season${map.seasons > 1 ? "s" : ""}. Status needs that manager's deep profile loaded.</p>
    <div class="table-wrap"><table class="league-map"><thead><tr><th>Manager</th><th>Window</th><th>Status</th><th>Trades</th>${teams.map((t) => `<th>${short(t)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------- what the Manager profiles panel shows ----------
function deepCardHtml(rid) {
  const uid = uidOf(rid);
  if (!uid) return "";
  const prof = deepGet(rid), loading = deep.loading.has(uid);
  const chat = localStorageGet(chatKey(uid)) || "";
  const neg = negotiationRead(chat);
  const mine = offersWith(uid);
  const btn = `<button class="chip deep-load" data-rid="${rid}" ${loading ? "disabled" : ""}>${loading ? "Loading..." : prof ? "Refresh deep profile" : "Load deep profile"}</button>`;
  if (!prof) return `<div class="deep">${btn} <span class="muted small deep-progress" data-rid="${rid}"></span></div>`;
  const traits = deepRead(prof, rid);
  const recent = prof.trades.slice(0, 5).map((t) => `<li><span class="muted">${new Date(t.at).toLocaleDateString()} · ${esc(t.league)}${t.partners.length ? ` · with ${esc(t.partners.join(", "))}` : ""}</span><br>
    Got ${esc(t.ins.map((a) => a.name).join(", ") || "nothing")}; sent ${esc(t.outs.map((a) => a.name).join(", ") || "nothing")}
    <span class="${t.net > 0.05 ? "up" : t.net < -0.05 ? "down" : "muted"}">${t.net > 0.05 ? `won by ${pctTxt(t.net)}` : t.net < -0.05 ? `lost by ${pctTxt(t.net)}` : "about even"}</span></li>`).join("");
  return `<div class="deep">
    <p>${esc(deepSummary(prof, rid))}</p>
    <details><summary>Traits <span class="muted">(${prof.leagues.length} leagues, ${prof.seasons} seasons, as of ${new Date(prof.at).toLocaleDateString()})</span></summary>
      <dl class="traits">${traits.map((x) => `<dt>${esc(x.k)}</dt><dd>${esc(x.v)}</dd>`).join("")}
        <dt>Negotiation style</dt><dd>${neg ? esc(neg.join("; ")) : "Paste your chat with them below to read it."}</dd></dl></details>
    ${recent ? `<details><summary>Recent trades</summary><ul class="deep-trades">${recent}</ul></details>` : ""}
    <details><summary>Your offers and chat <span class="muted">(this browser only)</span></summary>
      ${mine.length ? `<ul class="deep-trades">${mine.slice(-6).reverse().map((o) => `<li>${new Date(o.at).toLocaleDateString()}: ${esc(o.text || "offer")} <span class="muted">(we said ${Math.round(o.p * 100)}%)</span> <b>${esc(o.outcome)}</b></li>`).join("")}</ul>` : `<p class="muted small">Log offers from the Trade Finder ideas and the odds learn from what they actually do.</p>`}
      <textarea class="deep-chat" data-uid="${esc(uid)}" rows="4" placeholder="Paste your DMs or league chat with them. It stays in this browser.">${esc(chat)}</textarea></details>
    ${btn}</div>`;
}

function deepPanelHtml() {
  const alerts = deepAlerts();
  const loaded = state.data.teams.filter((t) => t.roster_id !== finder.me && deepGet(t.roster_id)).length;
  const others = state.data.teams.filter((t) => t.roster_id !== finder.me && t.owner_id).length;
  return `<div class="deep-top">
    <div class="toolbar"><button class="chip" id="deep-all">${loaded < others ? `Load all deep profiles (${loaded}/${others} loaded)` : "Refresh all deep profiles"}</button>
      <span class="muted small" id="deep-all-status"></span></div>
    <p class="muted small">Deep profiles read every league each manager is in on Sleeper, back ${DEEP_SEASONS} seasons: trades, waivers and FAAB, drops, lineups and drafts. It's all worked out in your browser and kept here for ${DEEP_TTL / 3600000} hours; nothing is saved to the site. Trade values are today's values.</p>
    ${alerts.length ? `<div class="deep-alerts"><h4>Alerts</h4><ul>${alerts.map((a) => `<li class="${a.tone === "warn" ? "down" : a.tone === "up" ? "up" : "muted"}">${esc(a.text)}</li>`).join("")}</ul></div>` : ""}
    <details class="deep-map" ${deep.mapOpen ? "open" : ""}><summary>League map</summary><div id="deep-map-body">${deep.map && deep.map.lid === state.data.league.sleeper_league_id ? leagueMapHtml(deep.map) : '<p class="muted">Loading...</p>'}</div></details>
  </div>`;
}

function bindDeep(el) {
  const rerender = () => { finder.last = null; renderFinder(); };
  el.querySelectorAll(".deep-load").forEach((b) => (b.onclick = async () => {
    const rid = Number(b.dataset.rid), uid = uidOf(rid);
    if (uid) { deep.profiles.delete(uid); localStorageSet(deepKey(uid), ""); }
    b.disabled = true; b.textContent = "Loading...";
    const prog = el.querySelector(`.deep-progress[data-rid="${rid}"]`);
    try { await deepLoad(rid, (d, n) => { const p = document.querySelector(`.deep-progress[data-rid="${rid}"]`); if (p) p.textContent = `${d}/${n} leagues`; }); }
    catch (e) { if (prog) prog.textContent = e.message; }
    rerender();
  }));
  const all = el.querySelector("#deep-all");
  if (all) all.onclick = async () => {
    all.disabled = true;
    const st = el.querySelector("#deep-all-status");
    const todo = state.data.teams.filter((t) => t.roster_id !== finder.me && t.owner_id);
    let done = 0;
    for (const t of todo) {
      if (st) st.textContent = `Reading ${managerOf(t) || t.name} (${done + 1}/${todo.length})...`;
      try { await deepLoad(t.roster_id); } catch { /* skip that one */ }
      done++;
    }
    rerender();
  };
  el.querySelectorAll(".deep-chat").forEach((ta) => (ta.onchange = () => { localStorageSet(chatKey(ta.dataset.uid), ta.value); rerender(); }));
  const map = el.querySelector("details.deep-map");
  if (map) {
    map.addEventListener("toggle", () => (deep.mapOpen = map.open));
    if (!deep.map || deep.map.lid !== state.data.league.sleeper_league_id) {
      const data = state.data;
      deepLeagueMap().then((m) => { if (state.data !== data) return; const body = document.getElementById("deep-map-body"); if (body) body.innerHTML = m ? leagueMapHtml(m) : '<p class="muted">No league history on Sleeper.</p>'; });
    }
  }
}
// Offer log buttons on Trade Finder ideas (rendered outside the profiles panel).
document.addEventListener("click", (e) => {
  const b = e.target.closest(".offer-log button");
  if (!b) return;
  const box = b.closest(".offer-log"), d = finder.last && finder.last.picked && finder.last.picked[Number(box.dataset.i)];
  if (!d) return;
  logOffer({ uid: uidOf(d.B), lg: state.data.league.id, at: Date.now(), p: d.accept ? d.accept.p : null, outcome: b.dataset.outcome,
    text: `you get ${d.gets.map((a) => a.label).join(", ")}; they get ${d.gives.map((a) => a.label).join(", ")}` });
  box.innerHTML = `<span class="muted">Logged as ${esc(b.dataset.outcome)}. The odds for ${esc(teamName(d.B))} learn from this.</span>`;
});
const offerLogHtml = (i) => `<div class="offer-log chips small" data-i="${i}"><span class="muted">Sent it? Log what happened:</span>
  ${["accepted", "countered", "declined", "ignored"].map((o) => `<button class="chip" data-outcome="${o}">${o[0].toUpperCase() + o.slice(1)}</button>`).join("")}</div>`;
