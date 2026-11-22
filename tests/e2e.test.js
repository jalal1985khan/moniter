// End-to-end: a real (headless) Chrome opens the demo table served by the monitor, and the
// monitor's captured results are compared with the table's true history. Skipped when no
// Chrome or Edge is installed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V32 = require('../lib/game');
const {createMonitor} = require('../server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v32-e2e-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

async function chromeAvailable() {
  try {
    const {chromium} = require('playwright-core');
    for (const channel of ['chrome', 'msedge']) {
      try { const b = await chromium.launch({channel, headless: true}); await b.close(); return true; } catch {}
    }
  } catch {}
  return false;
}

test('end to end with a real browser', async t => {
  if (!(await chromeAvailable())) { t.skip('Google Chrome / Microsoft Edge not installed'); return; }
  const m = createMonitor({port: 0, dataDir: tmp(), profileDir: tmp(), headless: true, demo: true});
  const port = await m.listen();
  const base = `http://localhost:${port}`;
  const post = (p, body = {}) => fetch(base + p, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}).then(r => r.json());
  const game = () => m.gamePages().find(p => p.url().includes('/demo'));
  const demo = fn => game().evaluate(fn);
  const truth = () => demo(() => window.__demo.history.slice());
  const settle = async () => { // Wait until the monitor has read the table's current row.
    const want = await truth();
    await until(() => { const v = m.state().values, k = Math.min(10, v.length, want.length); return k > 0 && v.slice(-k).join() === want.slice(-k).join(); }, 'the monitor to catch up', 8000).catch(() => {});
    await sleep(800);
  };

  try {
    await t.test('dashboard page and settings', async () => {
      assert.match(await (await fetch(base + '/')).text(), /V-32 Live Monitor/);
      assert.strictEqual((await post('/api/settings', {budget: 1000, lossLimit: 200, profitTarget: 0, timeLimitMin: 0, newestSide: 'auto'})).ok, true);
    });

    await t.test('capture goes live on the demo table', async () => {
      assert.strictEqual((await post('/api/start', {url: `${base}/demo?seconds=1`})).ok, true);
      await until(() => m.state().capture.status === 'live', 'capture to go live');
    });

    await t.test('every live round is captured in order, with no gaps', async () => {
      await until(() => m.state().values.length >= 12, '12 captured rounds', 40000);
      await demo(() => window.__demo.pause(true));
      await settle();
      const s = m.state(), h = await truth();
      assert.deepStrictEqual(s.values, h.slice(-s.values.length), 'captured results match the table');
      assert.deepStrictEqual(s.gaps, [], 'no gaps while live');
      assert.strictEqual(s.capture.side, 'right', 'newest side found automatically');
      assert.match(s.capture.round || '', /^V32C\d+$/);
      assert.deepStrictEqual(s.liveValues, s.values, 'live pick check counts every round since capture started');
    });

    await t.test('several rounds between readings are all caught', async () => {
      const before = m.state().values.length;
      await demo(() => window.__demo.burst(3));
      await settle();
      const s = m.state(), h = await truth();
      assert.strictEqual(s.values.length, before + 3);
      assert.deepStrictEqual(s.values, h.slice(-s.values.length));
      assert.deepStrictEqual(s.gaps, []);
    });

    await t.test('more rounds than the row holds are flagged as a gap', async () => {
      const before = m.state().values.length;
      await demo(() => window.__demo.burst(14));
      await settle();
      const s = m.state(), h = await truth();
      assert.strictEqual(s.values.length, before + 10, 'the whole visible row is added');
      assert.deepStrictEqual(s.values.slice(-10), h.slice(-10));
      assert.deepStrictEqual(s.gaps, [before], 'first added result is marked');
    });

    await t.test('inactivity disconnect is reconnected automatically (only the Reconnect button)', async () => {
      await demo(() => window.__demo.disconnect());
      await until(async () => (await demo(() => window.__demo.reconnected)) === 1, 'Reconnect to be clicked', 20000);
      await until(() => m.state().capture.reconnects === 1, 'the reconnect to be recorded', 5000);
    });

    await t.test('balance, session and stop-loss alarm', async () => {
      await demo(() => window.__demo.setBalance(1000));
      await until(() => m.state().capture.balance === 1000, 'balance 1000 to be read', 5000);
      assert.strictEqual((await post('/api/session/start', {})).ok, true);
      assert.strictEqual(m.state().session.startBalance, 1000);
      await demo(() => window.__demo.setBalance(900));
      await until(() => m.state().session.status.net === -100, 'net −100', 5000);
      assert.strictEqual(m.state().session.alarm, null, 'no alarm before the stop-loss');
      await demo(() => window.__demo.setBalance(790));
      await until(() => m.state().session.alarm, 'stop-loss alarm', 5000);
      assert.strictEqual(m.state().session.alarm.kind, 'loss');
      await demo(() => window.__demo.setBalance(950)); // Recovering does not clear the alarm.
      await until(() => m.state().capture.balance === 950, 'balance 950', 5000);
      assert.strictEqual(m.state().session.alarm.kind, 'loss');
      await post('/api/alarm/ack', {endSession: true});
      assert.strictEqual(m.state().session, null);
      assert.strictEqual(m.state().pastSessions[0].reason, 'limit: loss');
    });

    await t.test('capturing table odds and clicking number and amount in the game window', async () => {
      // 1. Verify odds are captured from the side-by-side table
      await until(() => m.state().tableOdds && m.state().tableOdds.back, 'table odds to be captured', 10000);
      const to = m.state().tableOdds;
      assert.strictEqual(to.back[11], 2.08, 'Player 11 Back odds captured correctly');
      assert.strictEqual(to.lay[11], 2.18, 'Player 11 Lay odds captured correctly');
      assert.strictEqual(to.odd[11], 1.97, 'Player 11 Odd odds captured correctly');

      // 2. Manual click on Player 11 with ₹20 (verifies Back odds 2.08 is clicked, stake 20 typed, and Place Bet pressed)
      const clickRes = await post('/api/click', {number: 11, amount: 20});
      assert.strictEqual(clickRes.ok, true);
      assert.strictEqual(clickRes.player, 11);
      assert.strictEqual(clickRes.amount, 20);
      assert.strictEqual(clickRes.detail.odds, 2.08, 'clicked the Back odds 2.08, not Lay or Odd/Even');
      const lastBet = await demo(() => window.__demo.lastBet);
      assert.ok(lastBet, 'bet was received and recorded by game table');
      assert.strictEqual(lastBet.player, 11);
      assert.strictEqual(lastBet.amount, 20);

      // 3. Immediate auto-click when enabled while betting is open
      await demo(() => { window.__demo.lastBet = null; });
      await post('/api/autoclick/toggle', {enabled: true, number: '11', amount: 20});
      await until(async () => {
        const b = await demo(() => window.__demo.lastBet);
        return b && b.player === 11 && b.amount === 20;
      }, 'immediate auto-click on enable', 10000);

      // 4. Auto-click for the next round after results update
      await demo(() => { window.__demo.lastBet = null; });
      await demo(() => window.__demo.burst(1));
      await until(async () => {
        const b = await demo(() => window.__demo.lastBet);
        return b && b.player === 11 && b.amount === 20;
      }, 'auto-click for next round to be placed', 15000);
      await post('/api/autoclick/toggle', {enabled: false});
    });

    await t.test('live view streams JPEG frames', async () => {
      const ctrl = new AbortController();
      const res = await fetch(base + '/preview', {signal: ctrl.signal});
      const reader = res.body.getReader();
      let buf = Buffer.alloc(0);
      const end = Date.now() + 8000;
      while (!buf.includes(Buffer.from([0xff, 0xd8])) && Date.now() < end) {
        const {value, done} = await reader.read(); if (done) break;
        buf = Buffer.concat([buf, Buffer.from(value)]);
      }
      ctrl.abort();
      assert.ok(buf.includes(Buffer.from([0xff, 0xd8])), 'a JPEG frame arrived');
    });

    await t.test('restarting capture marks the break as a gap', async () => {
      await post('/api/stop');
      assert.strictEqual(m.state().capture.status, 'stopped');
      const before = m.state().values.length;
      assert.strictEqual((await post('/api/start', {url: `${base}/demo?seconds=1`})).ok, true);
      await until(() => m.state().values.length > before, 'a new round after restart', 30000);
      const s = m.state();
      assert.ok(s.gaps.includes(before), 'first round after the restart is marked');
    });
  } finally {
    await m.close();
  }
});
