const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V32 = require('../lib/game');
const {createMonitor} = require('../server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v32-'));
const ODDS = V32.simulate(50000);

test('true chances add up and favour the higher starting number', () => {
  const o = V32.simulate(200000);
  const sum = V32.PLAYERS.reduce((s, p) => s + o.win[p], 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(o.win[8] < o.win[9] && o.win[9] < o.win[10] && o.win[10] < o.win[11]);
  assert.ok(Math.abs(o.win[11] - 0.465) < 0.01, `Player 11 ${o.win[11]}`);
  for (const p of V32.PLAYERS) assert.ok(Math.abs(o.odd[p] - 0.5) < 0.01);
});

test('new results are found when the row moves along', () => {
  const before = [11, 9, 10, 11, 11, 11, 10, 11, 8, 9]; // newest on the right
  const after = [9, 10, 11, 11, 11, 10, 11, 8, 9, 10];
  assert.deepStrictEqual(V32.newResults(before, after, 'right').added, [10]);
  const two = [10, 11, 11, 11, 10, 11, 8, 9, 10, 8];
  assert.deepStrictEqual(V32.newResults(before, two, 'right').added, [10, 8]);
  assert.deepStrictEqual(V32.newResults(before, before, 'right').added, []);
});

test('newest-on-left rows and automatic side detection', () => {
  const before = [9, 8, 11, 10, 11, 11, 11, 10, 9, 11]; // newest on the left
  const after = [8, 9, 8, 11, 10, 11, 11, 11, 10, 9];
  assert.deepStrictEqual(V32.newResults(before, after, 'left').added, [8]);
  const r = V32.newResults(before, after, 'auto');
  assert.deepStrictEqual(r.added, [8]);
  assert.strictEqual(r.side, 'left');
});

test('a row that no longer lines up is kept whole and flagged as a gap', () => {
  const r = V32.newResults([8, 8, 8, 8, 8, 8], [9, 10, 11, 9, 10, 11], 'right');
  assert.strictEqual(r.gap, true);
  assert.deepStrictEqual(r.added, [9, 10, 11, 9, 10, 11]);
});

test('settings are checked', () => {
  assert.strictEqual(V32.checkSettings({budget: 0, lossLimit: 10}).ok, false);
  assert.strictEqual(V32.checkSettings({budget: 500, lossLimit: 600}).ok, false);
  const ok = V32.checkSettings({budget: 500, lossLimit: 200, profitTarget: '', timeLimitMin: 30});
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.settings.profitTarget, 0);
});

test('session status reaches the stop-loss, target and time limit', () => {
  const s = {budget: 1000, lossLimit: 200, profitTarget: 100, timeLimitMin: 30};
  const base = {active: true, startedAt: Date.now(), startBalance: 1000};
  assert.strictEqual(V32.sessionStatus(s, {...base, balance: 900}).reached, null);
  assert.strictEqual(V32.sessionStatus(s, {...base, balance: 800}).reached, 'loss');
  assert.strictEqual(V32.sessionStatus(s, {...base, balance: 1100}).reached, 'target');
  assert.strictEqual(V32.sessionStatus(s, {...base, balance: 1000, startedAt: Date.now() - 31 * 60000}).reached, 'time');
});

test('backtest picks only from earlier rounds', () => {
  const values = [11, 11, 11, 11, 10];
  const repeat = V32.backtest(values, ODDS.win).find(b => b.name === 'Repeat last winner');
  assert.strictEqual(repeat.picks, 4);
  assert.strictEqual(repeat.hitRate, 3 / 4);
});

async function withMonitor(fn) {
  const dataDir = tmp();
  const m = createMonitor({port: 0, dataDir, odds: ODDS});
  const port = await m.listen();
  const call = async (p, body) => {
    const r = await fetch(`http://localhost:${port}${p}`, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {});
    return r.headers.get('content-type').includes('json') ? r.json() : r.text();
  };
  try { await fn({m, call, dataDir, port}); } finally { await m.close(); }
}

test('monitor records rounds, tracks the session and raises the stop-loss alarm', () => withMonitor(async ({m, call, dataDir}) => {
  assert.strictEqual((await call('/api/session/start', {})).ok, false, 'needs settings first');
  assert.strictEqual((await call('/api/settings', {budget: 500, lossLimit: 100, profitTarget: 0, timeLimitMin: 0, newestSide: 'right'})).ok, true);

  m.onSnapshot({results: [11, 9, 10, 11, 11, 11, 10, 11, 8, 9], round: 'V32C1', balance: 1000});
  assert.strictEqual((await call('/api/session/start', {})).ok, true);
  m.onSnapshot({results: [9, 10, 11, 11, 11, 10, 11, 8, 9, 10], round: 'V32C2', balance: 950});
  m.onSnapshot({results: [10, 11, 11, 11, 10, 11, 8, 9, 10, 11], round: 'V32C3', balance: 890});

  const s = await call('/api/state');
  assert.deepStrictEqual(s.values, [10, 11]);
  assert.strictEqual(s.session.status.net, -110);
  assert.strictEqual(s.session.alarm.kind, 'loss');
  assert.strictEqual(s.sessionRounds, 2);

  await call('/api/alarm/ack', {endSession: true});
  const after = await call('/api/state');
  assert.strictEqual(after.session, null);
  assert.strictEqual(after.pastSessions[0].net, -110);

  const csv = await call('/api/rounds.csv');
  assert.match(csv, /,10,/);
  assert.strictEqual(fs.readFileSync(path.join(dataDir, 'rounds.ndjson'), 'utf8').trim().split('\n').length, 2);
}));

test('other websites cannot drive the monitor', () => withMonitor(async ({port}) => {
  const r = await fetch(`http://localhost:${port}/api/stop`, {method: 'POST', headers: {Origin: 'https://evil.example', 'Content-Type': 'application/json'}, body: '{}'});
  assert.strictEqual(r.status, 403);
}));

test('resuming after a restart adds the rounds missed, or marks a gap', () => {
  const saved = [8, 9, 10, 11, 11, 10, 9, 11, 10, 11, 8, 11]; // oldest first
  const row = saved.slice(-8).concat([9, 10]); // newest on the right, two new rounds
  assert.deepStrictEqual(V32.resumeResults(saved, row, 'right'), {added: [9, 10], gap: false, side: null});
  assert.deepStrictEqual(V32.resumeResults(saved, saved.slice(-10), 'right').added, []);
  assert.strictEqual(V32.resumeResults(saved, [9, 9, 9, 9, 9, 9, 9, 9, 9, 9], 'right').gap, true);
});

test('restart through the monitor marks the first new round as a gap', () => withMonitor(async ({m}) => {
  m.onSnapshot({results: [11, 9, 10, 11, 11, 11, 10, 11, 8, 9]});
  m.onSnapshot({results: [9, 10, 11, 11, 11, 10, 11, 8, 9, 10]});
  await m.stop();
  m.onSnapshot({results: [8, 8, 9, 9, 8, 8, 9, 9, 8, 8]}); // doesn't line up: rounds were missed
  m.onSnapshot({results: [8, 9, 9, 8, 8, 9, 9, 8, 8, 11]});
  const s = m.state();
  assert.deepStrictEqual(s.values, [10, 11]);
  assert.deepStrictEqual(s.gaps, [1]);
}));

test('exact chances count every one of the 863,040 deals', () => {
  const e = V32.exact();
  assert.strictEqual(e.deals, 32 * 31 * 30 * 29);
  const outright = V32.PLAYERS.reduce((s, p) => s + e.outright[p], 0);
  assert.strictEqual(outright + e.ties[2] + e.ties[3] + e.ties[4], e.deals);
  assert.ok(Math.abs(V32.PLAYERS.reduce((s, p) => s + e.win[p], 0) - 1) < 1e-12);
  assert.ok(Math.abs(e.win[11] - 0.4649) < 0.0005, `Player 11 ${e.win[11]}`);
  assert.strictEqual(e.cardChance[11][13].chance, 1, 'Player 11 with a King (24) always wins');
  assert.strictEqual(e.cardChance[8][6].chance, 0, 'Player 8 with a 6 (14) never wins');
  // Close to the simulation of fair rounds.
  for (const p of V32.PLAYERS) assert.ok(Math.abs(e.win[p] - ODDS.win[p]) < 0.01);
  // Known cards: Player 11 has a 6 (17) and Player 8 a King (21), so Player 11 can't win.
  assert.strictEqual(V32.exact({11: 6, 8: 13}).win[11], 0);
  assert.strictEqual(V32.exact({8: 13, 9: 13, 10: 13, 11: 13}).deals, 1);
});

test('the dashboard is warned when rounds stop arriving, and recovers when they return', async () => {
  const m = createMonitor({port: 0, dataDir: tmp(), odds: ODDS, staleMs: 120});
  await m.listen();
  try {
    m.onSnapshot({results: [11, 9, 10, 11, 11, 11, 10, 11, 8, 9]});
    assert.strictEqual(m.state().capture.status, 'live');
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(m.state().capture.status, 'stale');
    m.onSnapshot({results: [11, 9, 10, 11, 11, 11, 10, 11, 8, 9], balance: 900}); // balance only: still stale
    assert.strictEqual(m.state().capture.status, 'stale');
    m.onSnapshot({results: [9, 10, 11, 11, 11, 10, 11, 8, 9, 10]});
    assert.strictEqual(m.state().capture.status, 'live');
  } finally { await m.close(); }
});

test('a zero balance shown while the page loads is ignored', () => withMonitor(async ({m}) => {
  m.onSnapshot({balance: 0});
  assert.strictEqual(m.state().capture.balance, null);
  m.onSnapshot({results: [11, 9, 10, 11, 11, 11, 10, 11, 8, 9], balance: 1861.07});
  assert.strictEqual(m.state().capture.firstBalance, 1861.07);
  m.onSnapshot({results: [9, 10, 11, 11, 11, 10, 11, 8, 9, 10], balance: 1841.07});
  assert.strictEqual(m.state().capture.balance, 1841.07);
  assert.strictEqual(m.state().capture.firstBalance, 1861.07);
}));

test('practice autoplay settles pretend bets at the table odds and stops at its limits', () => {
  assert.strictEqual(V32.checkPractice({stake: 0, startBalance: 100}).ok, false);
  assert.strictEqual(V32.checkPractice({stake: 50, startBalance: 100, stopLoss: 200}).ok, false);
  const p = V32.checkPractice({method: 'Always Player 11', stake: 100, startBalance: 1000, stopLoss: 250, target: 0, maxRounds: 0}).practice;
  let run = V32.newPractice(p, [10, 9], Date.now(), TEST_ODDS);
  assert.strictEqual(run.nextPick, 11);
  run = V32.practiceStep(run, [10, 9], 11, {odds: TEST_ODDS}); // win: 100 x (2.08 - 1)
  assert.strictEqual(run.balance, 1108);
  run = V32.practiceStep(run, [10, 9, 11], 9, {gap: true, odds: TEST_ODDS}); // void
  assert.strictEqual(run.balance, 1108);
  assert.strictEqual(run.rounds, 1);
  for (const r of [8, 9, 10]) run = V32.practiceStep(run, [], r, {odds: TEST_ODDS});
  assert.strictEqual(run.balance, 808);
  assert.strictEqual(run.active, true);
  run = V32.practiceStep(run, [], 10, {odds: TEST_ODDS}); // 708: down 292, past the 250 stop-loss
  assert.strictEqual(run.active, false);
  assert.strictEqual(run.stopped, 'loss');
  const after = V32.practiceStep(run, [], 11, {odds: TEST_ODDS});
  assert.strictEqual(after.balance, 708, 'a stopped run takes no more bets');
});

test('practice martingale doubles after a loss and resets after a win', () => {
  const p = V32.checkPractice({method: 'Always Player 8', stake: 10, startBalance: 1000, progression: 'double'}).practice;
  let run = V32.newPractice(p, [], Date.now(), TEST_ODDS);
  const o = {odds: TEST_ODDS};
  run = V32.practiceStep(run, [], 11, o); run = V32.practiceStep(run, [], 11, o);
  assert.strictEqual(run.nextStake, 40);
  run = V32.practiceStep(run, [], 8, o); // 40 x 11.2 = 448
  assert.strictEqual(run.balance, 1000 - 30 + 448);
  assert.strictEqual(run.nextStake, 10);
});

test('practice autoplay runs on captured rounds through the monitor', () => withMonitor(async ({m, call}) => {
  m.onSnapshot({results: [11, 9, 10, 11, 11, 11, 10, 11, 8, 9]});
  assert.strictEqual((await call('/api/practice/start', {method: 'Always Player 11', stake: 100, startBalance: 1000})).ok, false, 'needs odds read from the table');
  m.onSnapshot({results: [11, 9, 10, 11, 11, 11, 10, 11, 8, 9], odds: {back: TEST_ODDS, lay: {8: 13.7, 9: 6.45, 10: 3.45, 11: 2.18}}});
  assert.deepStrictEqual((await call('/api/state')).tableOdds.back, TEST_ODDS);
  assert.strictEqual((await call('/api/practice/start', {method: 'Always Player 11', stake: 100, startBalance: 1000})).ok, true);
  m.onSnapshot({results: [9, 10, 11, 11, 11, 10, 11, 8, 9, 11]}); // 11 won
  m.onSnapshot({results: [10, 11, 11, 11, 10, 11, 8, 9, 11, 8]}); // 8 won
  let s = await call('/api/state');
  assert.strictEqual(s.practice.rounds, 2);
  assert.strictEqual(s.practice.balance, 1008);
  await call('/api/practice/stop', {});
  s = await call('/api/state');
  assert.strictEqual(s.practice.active, false);
  assert.strictEqual(s.practice.stopped, 'you');
}));

const Models = require('../lib/models');
// Test-only data: a seeded generator and fair rounds dealt from the 32-card rules. The app itself
// never uses simulated rounds; it trains only on rounds captured from the game.
function rng(seed = 1) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function simulateRounds(n, seed) {
  const rand = rng(seed), out = [], d = V32.DECK.slice();
  for (let r = 0; r < n; r++) {
    let top = d.length;
    const draw = () => { const j = Math.floor(rand() * top); top--; const t = d[j]; d[j] = d[top]; d[top] = t; return t; };
    const total = V32.PLAYERS.slice();
    let alive = [0, 1, 2, 3];
    while (alive.length > 1 && top >= alive.length) {
      for (const i of alive) total[i] += draw();
      const best = Math.max(...alive.map(i => total[i]));
      alive = alive.filter(i => total[i] === best);
    }
    out.push(V32.PLAYERS[alive[Math.floor(rand() * alive.length)]]);
  }
  return out;
}
const TEST_ODDS = {8: 12.2, 9: 5.95, 10: 3.2, 11: 2.08}; // as read from the table in a real capture


test('trained models never beat the 32-card math on a fair game', () => {
  const res = Models.train(simulateRounds(60000, 11), {prior: V32.exact().win, odds: TEST_ODDS, warmup: 500});
  assert.strictEqual(res[0].name, '32-card math (exact)');
  for (const m of res.slice(1)) {
    assert.ok(m.z < 2.5, `${m.name} z ${m.z}`);
    assert.ok(m.logScore >= res[0].logScore - 0.002, `${m.name} log ${m.logScore}`);
    assert.ok(m.net < 0, `${m.name} would have made money`);
  }
  assert.strictEqual(res[0].nextPick, 11);
});

test('a trained model does find a pattern when the game has one', () => {
  // A rigged game: Player 9 always follows Player 8. The sequence model should learn it.
  const rand = rng(5), values = [];
  for (let i = 0; i < 6000; i++) values.push(values.at(-1) === 8 ? 9 : V32.PLAYERS[Math.floor(rand() * 4)]);
  const seq = Models.train(values, {prior: V32.exact().win}).find(m => m.name === 'Sequence model (last 1)');
  assert.ok(seq.z > 2.5, `z ${seq.z}`);
});

test('without odds read from the table, a pretend bet is void, not settled at made-up odds', () => {
  const p = V32.checkPractice({method: 'Always Player 11', stake: 100, startBalance: 1000}).practice;
  let run = V32.newPractice(p, [], Date.now(), null);
  run = V32.practiceStep(run, [], 11);
  assert.strictEqual(run.balance, 1000);
  assert.strictEqual(run.bets[0].void, 'odds');
});

test('model money figures need odds read from the table', () => {
  const res = Models.train([11, 10, 11, 9, 11, 8, 10, 11], {prior: V32.exact().win});
  assert.strictEqual(res[0].net, null);
  assert.ok(res[0].hitRate != null);
});

test("the monitor never reads its own dashboard as if it were the game", () => withMonitor(async ({m, port}) => {
  assert.strictEqual(m.isOwnPage(`http://localhost:${port}/`), true);
  assert.strictEqual(m.isOwnPage(`http://127.0.0.1:${port}/#x`), true);
  assert.strictEqual(m.isOwnPage('https://d.broplay247.com/game-screen-play'), false);
  assert.strictEqual(m.isOwnPage(`http://localhost:${port}/demo`), true, 'demo table only exists in test mode');
}));

test('rounds found when capture resumes have no Round ID (they finished while it was off)', () => withMonitor(async ({m}) => {
  let row = [11, 9, 10, 11, 11, 11, 10, 11, 8, 9, 10, 11]; // newest on the right
  m.onSnapshot({results: row, round: 'V32C0'});
  const next = [8, 9, 10, 11, 11, 10, 9, 11, 10, 8];
  next.forEach((n, i) => { row = row.slice(1).concat(n); m.onSnapshot({results: row, round: 'V32C' + (i + 1)}); });
  assert.strictEqual(m.state().recent[0].round, 'V32C10');
  await m.stop();
  row = row.slice(1).concat(9); // 9 finished while capture was off
  m.onSnapshot({results: row, round: 'V32C12'});
  const r = m.state().recent;
  assert.strictEqual(r[0].n, 9);
  assert.strictEqual(r[0].round, null);
}));

test('Auto picks the method with the best record on the captured rounds, and plays it', () => {
  assert.strictEqual(V32.autoChoose([11, 10, 9]).method, 'Always Player 11', 'too few rounds: highest true chance');
  const h = []; for (let i = 0; i < 120; i++) h.push(i % 2 ? 9 : 10); // 10, 9, 10, 9 ...: "same as 2 rounds ago" always right
  const c = V32.autoChoose(h);
  assert.strictEqual(c.method, 'Same as 2 rounds ago');
  assert.ok(c.hitRate > 0.99, String(c.hitRate)); // the very first round has no round 2 before it
  const p = V32.checkPractice({stake: 10, startBalance: 100}).practice;
  assert.strictEqual(p.method, V32.AUTO, 'Auto is the default');
  const run = V32.newPractice(p, h, Date.now(), TEST_ODDS);
  assert.strictEqual(run.nextPick, 10);
  assert.strictEqual(run.nextChosen.method, 'Same as 2 rounds ago');
  const after = V32.practiceStep(run, h, 10, {odds: TEST_ODDS});
  assert.strictEqual(after.bets[0].by, 'Same as 2 rounds ago');
  assert.strictEqual(after.balance, 100 + 10 * (3.2 - 1));
});

test('a brief "Bal: 0" while the table reloads never triggers the stop-loss', () => withMonitor(async ({m, call}) => {
  await call('/api/settings', {budget: 500, lossLimit: 100, profitTarget: 0, timeLimitMin: 0, newestSide: 'right'});
  const row = [11, 9, 10, 11, 11, 11, 10, 11, 8, 9];
  m.onSnapshot({results: row, balance: 1861.07});
  assert.strictEqual((await call('/api/session/start', {})).ok, true);
  m.onSnapshot({results: row, balance: 0}); // table reloading
  let s = await call('/api/state');
  assert.strictEqual(s.capture.balance, 1861.07);
  assert.strictEqual(s.session.alarm, null);
  m.onSnapshot({results: row, balance: 1861.07});
  s = await call('/api/state');
  assert.strictEqual(s.session.alarm, null);
}));

test('a Round ID is never given to two different results', () => withMonitor(async ({m}) => {
  let row = [11, 9, 10, 11, 11, 11, 10, 11, 8, 9];
  m.onSnapshot({results: row, round: 'V32C1'});
  row = row.slice(1).concat(10); m.onSnapshot({results: row, round: 'V32C1'});
  row = row.slice(1).concat(8); m.onSnapshot({results: row, round: 'V32C1'}); // header didn't move
  const r = m.state().recent;
  assert.strictEqual(r[1].round, 'V32C1');
  assert.strictEqual(r[0].round, null);
}));

test('ending the session also stops practice autoplay', () => withMonitor(async ({m, call}) => {
  await call('/api/settings', {budget: 500, lossLimit: 100, profitTarget: 0, timeLimitMin: 0, newestSide: 'right'});
  m.onSnapshot({results: [11, 9, 10, 11, 11, 11, 10, 11, 8, 9], balance: 1000, odds: {back: TEST_ODDS}});
  assert.strictEqual((await call('/api/practice/start', {stake: 50, startBalance: 1000, stopLoss: 100})).ok, true);
  assert.strictEqual((await call('/api/session/start', {})).ok, true);
  await call('/api/session/end', {});
  const s = await call('/api/state');
  assert.strictEqual(s.practice.active, false);
  assert.strictEqual(s.practice.stopped, 'session');
}));

test('autoplay refuses a stake bigger than its stop-loss', () => {
  assert.strictEqual(V32.checkPractice({stake: 500, startBalance: 1861, stopLoss: 100}).ok, false);
  assert.strictEqual(V32.checkPractice({stake: 50, startBalance: 1861, stopLoss: 100}).ok, true);
});

test('settings support autoClick, autoClickNumber and autoClickAmount', () => {
  const s = V32.checkSettings({budget: 500, lossLimit: 100, autoClick: true, autoClickNumber: '11', autoClickAmount: 200, autoClickPauseAfterLoss: true});
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.settings.autoClick, true);
  assert.strictEqual(s.settings.autoClickNumber, '11');
  assert.strictEqual(s.settings.autoClickAmount, 200);
  assert.strictEqual(s.settings.autoClickPauseAfterLoss, true);
});

test('auto-pause signal compares each result with a prediction made from earlier rounds', () => {
  const history = Array(30).fill(11);
  const prediction = V32.autoPrediction(history);
  assert.strictEqual(prediction.number, 11, 'the low-history fallback is explicit and testable');
  assert.ok(prediction.method);
  assert.strictEqual(V32.autoPrediction([...history, 9]).number, V32.SYSTEMS[V32.autoChoose([...history, 9]).method]([...history, 9]));
});

test('auto-click loss gate pauses on one loss and resumes only after a later prediction hit', () => {
  let gate = V32.advanceAutoClickLossGate(false, {pauseAfterLoss: true, loss: true, prediction: 11, result: 9});
  assert.deepStrictEqual(gate, {waiting: true, paused: true, matched: false});
  gate = V32.advanceAutoClickLossGate(gate.waiting, {pauseAfterLoss: true, prediction: 11, result: 10});
  assert.deepStrictEqual(gate, {waiting: true, paused: false, matched: false});
  gate = V32.advanceAutoClickLossGate(gate.waiting, {pauseAfterLoss: true, prediction: 11, result: 11});
  assert.deepStrictEqual(gate, {waiting: false, paused: false, matched: true});
  gate = V32.advanceAutoClickLossGate(true, {pauseAfterLoss: false, prediction: 11, result: 10});
  assert.deepStrictEqual(gate, {waiting: false, paused: false, matched: false});
});

test('autoclick toggle and state endpoint work through the monitor', () => withMonitor(async ({call}) => {
  await call('/api/settings', {budget: 500, lossLimit: 100, profitTarget: 0, timeLimitMin: 0, newestSide: 'right', autoClickPauseAfterLoss: true});
  let s = await call('/api/state');
  assert.strictEqual(s.autoClick.enabled, false);
  assert.strictEqual(s.autoClick.pauseAfterLoss, true);
  assert.strictEqual(s.autoClick.waitingForPrediction, false);

  const toggled = await call('/api/autoclick/toggle', {enabled: true, number: '10', amount: 50});
  assert.strictEqual(toggled.ok, true);

  s = await call('/api/state');
  assert.strictEqual(s.autoClick.enabled, true);
  assert.strictEqual(s.autoClick.number, '10');
  assert.strictEqual(s.autoClick.amount, 50);
}));
