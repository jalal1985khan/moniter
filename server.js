// V-32 Live Monitor. Opens the game in a Chrome window it controls, reads each finished round
// from the "Last Result" row, streams a live view of the game, and tracks your playing session
// against the budget, stop-loss, profit target and time limit you set. It never bets or types; its only click is the game's Reconnect button after an inactivity disconnect (optional),
// or bets in the game.
const http = require('http');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const V32 = require('./lib/game');
const Clicker = require('./lib/clicker');

// True chances counted exactly over every possible deal. Half the 32 cards are odd (7, 9, J, K),
// so each player's first total is odd exactly half the time.
function exactOdds() {
  const e = V32.exact(), odd = {};
  for (const p of V32.PLAYERS) odd[p] = 0.5;
  return {win: e.win, odd, rounds: e.deals, deals: e.deals, exact: true};
}
const {createStore} = require('./lib/store');

const PUBLIC_DIR = path.join(__dirname, 'public');
const CAPTURE_SCRIPT = path.join(__dirname, 'lib', 'capture.js');
const STAY_VISIBLE_SCRIPT = path.join(__dirname, 'lib', 'stay-visible.js');
const KEEP_RUNNING_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
];
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/charts.js': ['charts.js', 'text/javascript; charset=utf-8'],
};
const MAX_SENT_ROUNDS = 5000;

function createMonitor({
  port = 4330,
  dataDir = path.join(__dirname, 'data'),
  profileDir = path.join(__dirname, 'browser-profile'),
  headless = false,
  launch = null, // Tests pass their own browser launcher.
  demo = false, // Serves /demo, a practice table used only by the end-to-end tests.
  staleMs = 150000, // No new round for this long while live = warn on the dashboard.
  odds = exactOdds(),
} = {}) {
  const store = createStore(dataDir);
  let settings = store.loadSettings();
  let rounds = store.loadRounds();
  let session = store.loadSession();
  let practice = store.loadPractice();
  let tableOdds = store.loadTableOdds(); // The latest odds read from the table: {back, lay, odd, even, at}. // Practice autoplay: pretend bets scored on real results.
  let url = store.loadUrl();
  let capture = {status: 'stopped', note: 'Enter the game address and click Start capture.', lastSnapshotAt: 0, lastRoundAt: 0, round: null, balance: null, side: null};
  let lastStrip = null; // The "Last Result" row as last read, in page order.
  let resumeGap = false; // The next new result follows a break in capture.
  let context = null, stopping = false, gamePage = null, gameFrame = null;
  let lastAutoClickRound = null, lastAutoClickAt = 0, lastAutoClickAction = null, autoClicking = false, autoClickTries = {};
  const clients = new Set(), viewers = new Set();
  let frame = null, castPage = null, castSession = null, lastFrameAt = 0, grabbing = false;

  // ---------------------------------------------------------------- state sent to the page
  function state() {
    const values = rounds.slice(-MAX_SENT_ROUNDS);
    return {
      settings, configured: !!settings, url, capture, odds,
      session: session && {...session, status: V32.sessionStatus(settings || {}, session)},
      sessionRounds: session && session.active ? rounds.filter(r => r.t >= session.startedAt).length : 0,
      total: rounds.length,
      liveValues: capture.startedAt ? rounds.filter(r => r.t >= capture.startedAt).map(r => r.n) : [],
      values: values.map(r => r.n),
      gaps: values.map((r, i) => (r.gap ? i : -1)).filter(i => i >= 0),
      recent: rounds.slice(-40).reverse(),
      pastSessions: store.loadFinishedSessions().slice(-30).reverse(),
      practice, practiceMethods: [V32.AUTO, ...Object.keys(V32.SYSTEMS)], tableOdds,
      autoClick: {
        enabled: !!(settings && settings.autoClick),
        number: (settings && settings.autoClickNumber) || 'auto',
        amount: (settings && settings.autoClickAmount > 0) ? settings.autoClickAmount : null,
        lastAction: lastAutoClickAction,
      },
    };
  }
  let broadcastTimer = null;
  function broadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      const msg = `data: ${JSON.stringify(state())}\n\n`;
      for (const res of clients) res.write(msg);
    }, 100);
  }
  const setCapture = patch => { capture = {...capture, ...patch}; broadcast(); };

  // ---------------------------------------------------------------- session and limits
  function saveSession() { store.saveSession(session); }
  function checkLimits() {
    if (!session || !session.active || !settings) return;
    const st = V32.sessionStatus(settings, session);
    if (st && st.reached && (!session.alarm || session.alarm.kind !== st.reached)) {
      session.alarm = {kind: st.reached, at: Date.now(), acknowledged: false, net: st.net, minutes: st.minutes};
      saveSession();
    }
  }
  const limitTimer = setInterval(() => { if (session && session.active) { checkLimits(); broadcast(); } }, 5000);

  function startSession(body = {}) {
    if (!settings) return {ok: false, error: 'Set your budget and stop-loss first (⚙ Settings).'};
    if (session && session.active) return {ok: false, error: 'A session is already running.'};
    const typed = body.startBalance === '' || body.startBalance == null ? null : Number(body.startBalance);
    if (typed != null && !(Number.isFinite(typed) && typed >= 0)) return {ok: false, error: 'Enter your balance as a number.'};
    const startBalance = typed != null ? typed : capture.balance;
    if (startBalance == null) return {ok: false, error: 'Your balance could not be read from the game yet. Type it in to start.'};
    const t0 = Date.now();
    session = {active: true, startedAt: t0, startBalance, balance: startBalance, balanceFrom: typed != null ? 'typed' : 'game', alarm: null, settings: {...settings}, balances: [{t: t0, b: startBalance}]};
    saveSession(); broadcast();
    return {ok: true};
  }
  function setBalance(value, from) {
    if (!session || !session.active || !Number.isFinite(value)) return;
    if (session.balance === value) return;
    session.balance = value; session.balanceFrom = from;
    // Every change, for the win/loss charts (the newest 5,000).
    (session.balances = session.balances || []).push({t: Date.now(), b: value});
    if (session.balances.length > 5000) session.balances.splice(0, session.balances.length - 5000);
    checkLimits(); saveSession(); broadcast();
  }
  function endSession(reason = 'ended') {
    if (!session || !session.active) return {ok: false, error: 'No session is running.'};
    const st = V32.sessionStatus(settings || {}, session);
    const {balances, ...rest} = session;
    const done = {...rest, active: false, endedAt: Date.now(), reason, net: st ? st.net : null,
      rounds: rounds.filter(r => r.t >= session.startedAt).length};
    store.addFinishedSession(done);
    session = null;
    // Practice autoplay runs with the session: ending the session stops it.
    if (practice && practice.active) { practice = {...practice, active: false, stopped: 'session', stoppedAt: Date.now()}; store.savePractice(practice); }
    store.saveSession(null);
    broadcast();
    return {ok: true};
  }

  // ---------------------------------------------------------------- snapshots from the game
  function onSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    const now = Date.now();
    const patch = {lastSnapshotAt: now};
    if (snap.round) patch.round = String(snap.round).slice(0, 40);
    const o = snap.odds;
    const okTable = t => t && V32.PLAYERS.every(p => Number(t[p]) > 1 && Number(t[p]) < 1000);
    if (o && (okTable(o.back) || okTable(o.odd))) {
      const pick = t => (okTable(t) ? Object.fromEntries(V32.PLAYERS.map(p => [p, Number(t[p])])) : null);
      const next = {back: pick(o.back), lay: pick(o.lay), odd: pick(o.odd), even: pick(o.even)};
      const prev = tableOdds || {};
      for (const k of Object.keys(next)) if (!next[k] && prev[k]) next[k] = prev[k]; // keep a table that's locked now
      const changed = JSON.stringify({...next, at: 0}) !== JSON.stringify({back: prev.back, lay: prev.lay, odd: prev.odd, even: prev.even, at: 0});
      tableOdds = {...next, at: now};
      if (changed) store.saveTableOdds(tableOdds);
    }
    const onTable = Array.isArray(snap.results) && snap.results.filter(v => V32.isPlayer(Number(v))).length >= 5;
    // While the page (or the table) is loading, the game can show "Bal: 0". A drop to 0 from a real
    // balance is only believed once it has been showing for 8 seconds; until then it's ignored.
    let balOk = Number.isFinite(snap.balance);
    if (balOk && snap.balance <= 0) {
      if (!zeroSince) zeroSince = now;
      balOk = onTable && now - zeroSince >= 8000;
    } else if (balOk) zeroSince = 0;
    if (balOk) {
      if (snap.balance !== capture.balance) patch.balanceAt = now;
      if ((capture.firstBalance == null || capture.firstBalance <= 0) && onTable && snap.balance > 0) patch.firstBalance = snap.balance; // for "change since capture started"
      patch.balance = snap.balance; setBalance(snap.balance, 'game');
    }
    const strip = Array.isArray(snap.results) ? snap.results.map(Number).filter(V32.isPlayer) : null;
    if (strip && strip.length >= 5) {
      // From "stale", only a new round counts as being back (a balance change alone doesn't).
      if (capture.status !== 'live' && capture.status !== 'stale') { patch.status = 'live'; patch.liveAt = now; patch.note = 'Reading results live.'; }
      const side = settings && settings.newestSide !== 'auto' ? settings.newestSide : 'auto';
      const fallback = capture.side || 'right';
      let r;
      const resuming = !lastStrip;
      if (!lastStrip) {
        // First reading after (re)starting capture: line the row up with the saved rounds, so
        // rounds that finished while the monitor was off are added, or the break is marked.
        r = V32.resumeResults(rounds.slice(-30).map(x => x.n), strip, side === 'auto' ? capture.side || 'auto' : side, fallback);
        if (r.gap) { resumeGap = true; r = {added: [], gap: false, side: null}; }
      } else {
        r = V32.newResults(lastStrip, strip, side, fallback);
      }
      if (r.side && side === 'auto') patch.side = r.side;
      lastStrip = strip;
      if (r.added.length) {
        const gapFirst = r.gap || resumeGap;
        resumeGap = false;
        // Rounds found on resume finished while capture was off: their Round IDs aren't known.
        // A Round ID already given to the previous result isn't reused: the row moved before the
        // header changed (for example right after a reconnect), so this result's ID isn't known.
        let label = resuming ? null : (patch.round || capture.round);
        if (label && rounds.length && rounds[rounds.length - 1].round === label) label = null;
        const rows = r.added.map((n, i) => ({n, t: now, round: i === r.added.length - 1 ? label : null, ...(gapFirst && i === 0 ? {gap: true} : {})}));
        // Practice autoplay settles its pretend bet on each new result, in order.
        if (practice && practice.active) {
          let hist = rounds.map(x => x.n);
          for (const row of rows) {
            practice = V32.practiceStep(practice, hist, row.n, {gap: !!row.gap, round: row.round, now, odds: tableOdds && tableOdds.back});
            hist = hist.concat(row.n);
            if (!practice.active) break;
          }
          store.savePractice(practice);
        }
        rounds.push(...rows);
        store.appendRounds(rows);
        patch.lastRoundAt = now;
        if (capture.status === 'stale') { patch.status = 'live'; patch.note = 'Rounds are arriving again.'; }
        if (gapFirst) patch.note = r.gap
          ? `More rounds passed than the row holds; the whole row was added and marked as a gap (${new Date(now).toLocaleTimeString()}).`
          : 'Capture restarted: rounds played while it was off are missing, so the first new result is marked as a gap.';
        else if (/gap|restarted/.test(capture.note || '')) patch.note = 'Reading results live.';
        if (settings && settings.autoClick) {
          setTimeout(() => checkAndTriggerAutoClick(patch.round || snap.round || capture.round), 1000);
        }
      }
    }
    if (settings && settings.autoClick) {
      if (snap.round && snap.round !== capture.round) {
        checkAndTriggerAutoClick(snap.round);
      } else if (tableOdds && (tableOdds.back || (snap.odds && snap.odds.back))) {
        const roundKey = String(capture.round || (rounds.length + 1));
        if (lastAutoClickRound !== roundKey && Date.now() - lastAutoClickAt >= 2500 && !autoClicking) {
          checkAndTriggerAutoClick(roundKey);
        }
      }
    }
    setCapture(patch);
  }

  // ---------------------------------------------------------------- live view of the game
  function writeFrame(res, jpeg) {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    res.write(jpeg); res.write('\r\n');
  }
  function pushFrame(jpeg) {
    frame = jpeg; lastFrameAt = Date.now();
    for (const res of viewers) writeFrame(res, jpeg);
  }
  // The screencast only sends a picture when the page repaints; fill quiet moments with a screenshot.
  const grabTimer = setInterval(async () => {
    if (!viewers.size || !castPage || grabbing || Date.now() - lastFrameAt < 1000) return;
    grabbing = true;
    try { pushFrame(await castPage.screenshot({type: 'jpeg', quality: 50, scale: 'css', timeout: 1500})); } catch {}
    finally { grabbing = false; }
  }, 600);

  // Watchdog: if the table stops producing rounds (logged out, table closed, connection lost),
  // say so on the dashboard so you can fix it before missing much.
  const staleTimer = setInterval(() => {
    if (capture.status !== 'live') return;
    const since = Math.max(capture.lastRoundAt || 0, capture.liveAt || 0);
    if (since && Date.now() - since > staleMs) {
      setCapture({status: 'stale', staleAt: Date.now(), note: `No new round for ${Math.round((Date.now() - since) / 60000)} min. The game may have logged you out or left the table: check the game window (Show game window).`});
    }
  }, Math.min(5000, staleMs));

  // Keep-awake: many sites sign you out after a few minutes without mouse movement. Every 40 s the
  // pointer is moved by one pixel in the top-left corner of the game window. It never clicks or types.
  let nudge = 0;
  const awakeTimer = setInterval(async () => {
    const page = gamePage || castPage;
    if (!page || !context) return;
    try { nudge ^= 1; await page.mouse.move(2 + nudge, 2 + nudge); } catch {}
  }, 40000);

  let ownPageWarnedAt = 0, zeroSince = 0;

  // Auto-reconnect: when the game shows "Disconnection due to inactivity", click that dialog's own
  // "Reconnect" button, and nothing else. At most once every 15 s and 20 times an hour; can be
  // turned off in Settings. This is the only click the monitor ever makes.
  let reconnectAt = 0, reconnects = [], reconnecting = false;

  // Auto-open: on Broplay's Virtual Games list, search "32" and click the VR 32 Cards tile from
  // MAC88 (its picture comes from /mac88/), so you don't have to. Only on that list page, only while
  // no results are being read, and at most once every 20 s. Can be turned off in Settings.
  const TILE = 'img[alt="VR 32 Cards"][src*="/mac88/"]';
  let openingAt = 0;
  async function autoOpenGame(page) {
    if (settings && settings.autoOpenGame === false) return;
    if (!context || capture.status === 'live' || Date.now() - openingAt < 20000) return;
    let u = '';
    try { u = page.url(); } catch { return; }
    if (!/broplay247\.com\/virtual-games/i.test(u)) return;
    openingAt = Date.now();
    try {
      let tile = page.locator(TILE).first();
      if (!(await tile.count())) {
        const search = page.locator('input[placeholder="Search game"]').first();
        await search.fill('32', {timeout: 5000});
        await tile.waitFor({state: 'attached', timeout: 8000});
      }
      await tile.scrollIntoViewIfNeeded({timeout: 5000});
      await tile.click({timeout: 5000});
      setCapture({note: 'Opened VR 32 Cards (MAC88) from the Virtual Games list automatically.'});
    } catch {
      setCapture({note: "Couldn't open VR 32 Cards automatically. Click it in the game window (Virtual Game → search 32 → VR 32 Cards, MAC88)."});
    }
  }
  function watchForGamesList(page) {
    page.on('framenavigated', f => { if (f === page.mainFrame()) setTimeout(() => autoOpenGame(page), 4000); });
    page.on('load', () => setTimeout(() => autoOpenGame(page), 4000));
  }
  async function reconnect(frame) {
    const now = Date.now();
    if (settings && settings.autoReconnect === false) {
      setCapture({note: 'The game disconnected you for inactivity. Click Reconnect in the game window (auto-reconnect is off in Settings).'});
      return;
    }
    reconnects = reconnects.filter(t => now - t < 3600000);
    if (reconnecting || now - reconnectAt < 15000) return;
    if (reconnects.length >= 20) { setCapture({note: 'The game keeps disconnecting; auto-reconnect paused for this hour. Click Reconnect in the game window.'}); return; }
    reconnecting = true;
    try {
      const btn = frame.getByText('Reconnect', {exact: true}).first();
      await btn.click({timeout: 5000});
      reconnectAt = now; // a successful click waits 15 s before the next; a failed one retries
      reconnects.push(now);
      setCapture({reconnects: (capture.reconnects || 0) + 1, lastReconnectAt: now, note: `The game disconnected for inactivity; reconnected automatically at ${new Date(now).toLocaleTimeString()}.`});
    } catch (e) {
      setCapture({note: 'The game disconnected for inactivity and the Reconnect button could not be clicked yet; retrying. You can also click it in the game window.'});
    } finally { reconnecting = false; }
  }

  // ---------------------------------------------------------------- in-game number and amount clicker
  async function clickGameNumberAndAmount(number, amount) {
    const page = gamePage || castPage || (context && context.pages()[0]);
    if (!page || !context) return { ok: false, error: 'The game window is not open. Start capture first.' };
    const targetFrame = await Clicker.findGameFrame(page, gameFrame);
    if (!targetFrame) return { ok: false, error: 'The game frame could not be found in the browser window.' };
    return await Clicker.executeClick(targetFrame, number, amount, { odds: tableOdds && tableOdds.back });
  }

  // The player and amount to bet: the amount always comes from you; "auto" player = the pick made from
  // the rounds captured from your game. Nothing is filled in with a default.
  function chooseClick(number, amount) {
    const amt = Number(amount);
    if (!(amt > 0)) return {error: 'enter the amount to bet (₹).'};
    let num = Number(number);
    if (!number || number === 'auto') {
      if (!rounds.length) return {error: 'no rounds captured yet, so there is no prediction pick. Choose a player.'};
      num = V32.autoChoose(rounds.map(x => x.n)).pick;
    }
    if (![8, 9, 10, 11].includes(num)) return {error: 'choose Player 8, 9, 10 or 11.'};
    return {number: num, amount: amt};
  }

  async function checkAndTriggerAutoClick(triggerRound) {
    if (!settings || !settings.autoClick) return;
    if (!context || stopping || autoClicking) return;

    const roundKey = String(triggerRound || capture.round || (rounds.length + 1));
    if (lastAutoClickRound === roundKey) return;

    const now = Date.now();
    const wait = 2000 - (now - lastAutoClickAt);
    if (wait > 0) {
      setTimeout(() => {
        if (settings && settings.autoClick && lastAutoClickRound !== roundKey) {
          checkAndTriggerAutoClick(roundKey);
        }
      }, wait);
      return;
    }

    if (session && session.active) {
      const st = V32.sessionStatus(settings, session);
      if (st && st.reached) {
        lastAutoClickAction = {
          at: now,
          round: triggerRound,
          ok: false,
          error: `Auto-click paused: session ${st.reached} limit reached.`,
        };
        broadcast();
        return;
      }
    }

    const pick = chooseClick(settings.autoClickNumber, settings.autoClickAmount);
    if (pick.error) {
      lastAutoClickAction = { at: now, round: roundKey, ok: false, error: `Auto-click paused: ${pick.error}` };
      broadcast();
      return;
    }
    const num = pick.number, amt = pick.amount;

    if (capture.balance != null && capture.balance > 0 && capture.balance < amt) {
      lastAutoClickAction = {
        at: now,
        round: roundKey,
        number: num,
        amount: amt,
        ok: false,
        error: `Auto-click paused: game balance (₹${capture.balance}) is lower than stake (₹${amt}).`,
      };
      broadcast();
      return;
    }

    if (!(roundKey in autoClickTries)) autoClickTries = {[roundKey]: 0};
    lastAutoClickRound = roundKey;
    lastAutoClickAt = now;
    autoClicking = true;
    try {
      await new Promise(r => setTimeout(r, 400));
      const res = await clickGameNumberAndAmount(num, amt);
      lastAutoClickAction = {
        at: Date.now(),
        round: roundKey,
        number: num,
        amount: amt,
        ok: res.ok,
        error: res.ok ? null : res.error,
        detail: res,
      };
      if (res.ok) {
        setCapture({ note: `Auto-clicked Player ${num} with amount ₹${amt} for round ${roundKey}.` });
      } else if (res.closed && (autoClickTries[roundKey] = (autoClickTries[roundKey] || 0) + 1) < 15) {
        // The round changed before betting opened (odds still locked): try this round again shortly.
        lastAutoClickAction.error = `Waiting for betting to open (try ${autoClickTries[roundKey]} of 15): ${res.error}`;
        lastAutoClickRound = null; lastAutoClickAt = 0;
        setTimeout(() => { if (lastAutoClickRound === null && settings && settings.autoClick) checkAndTriggerAutoClick(roundKey); }, 1500);
      }
    } catch (e) {
      lastAutoClickAction = {
        at: Date.now(),
        round: roundKey,
        number: num,
        amount: amt,
        ok: false,
        error: e.message,
      };
    } finally {
      autoClicking = false;
      broadcast();
    }
  }
  function isOwnPage(u) {
    try {
      const x = new URL(u);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)) return false;
      if (demo && x.pathname === '/demo') return false; // the tests' practice table
      return !boundPort || x.port === String(boundPort);
    } catch { return false; }
  }

  async function keepFocused(page) {
    try {
      const s = await page.context().newCDPSession(page);
      await s.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    } catch {}
  }
  async function watchPage(page) {
    if (castPage === page || !context) return;
    const old = castSession;
    castPage = page; castSession = null;
    if (old) old.detach().catch(() => {});
    try {
      const s = await page.context().newCDPSession(page);
      s.on('Page.screencastFrame', ({data, sessionId}) => {
        s.send('Page.screencastFrameAck', {sessionId}).catch(() => {});
        if (castSession === s) pushFrame(Buffer.from(data, 'base64'));
      });
      castSession = s;
      await s.send('Page.startScreencast', {format: 'jpeg', quality: 50, maxWidth: 960, maxHeight: 540, everyNthFrame: 2});
    } catch {}
    page.on('close', () => {
      if (castPage !== page || !context) return;
      castPage = null;
      const next = gamePage || context.pages().at(-1);
      if (next) watchPage(next);
    });
  }

  // ---------------------------------------------------------------- the game window
  async function openBrowser() {
    if (launch) return launch();
    const {chromium} = require('playwright-core');
    const options = {headless, viewport: null, args: ['--no-first-run', '--no-default-browser-check', ...KEEP_RUNNING_ARGS]};
    const errors = [];
    for (const channel of ['chrome', 'msedge', undefined]) {
      try { return await chromium.launchPersistentContext(profileDir, {...options, channel}); }
      catch (e) { errors.push(String(e.message || e).split('\n')[0]); }
    }
    throw new Error(`Could not open Google Chrome or Microsoft Edge. Install Google Chrome and try again. (${errors[0]})`);
  }

  async function start(rawUrl) {
    let u;
    try { u = new URL(String(rawUrl || '').trim()); } catch {}
    if (!u || !['http:', 'https:'].includes(u.protocol)) return {ok: false, error: 'Enter the full game address, starting with https://'};
    if (context) await stop('');
    url = u.href; store.saveUrl(url);
    lastStrip = null;
    setCapture({status: 'starting', note: 'Opening the game window…', url, lastSnapshotAt: 0, startedAt: Date.now(), firstBalance: null});
    try { context = await openBrowser(); }
    catch (e) { context = null; setCapture({status: 'error', note: e.message}); return {ok: false, error: e.message}; }
    const ctx = context;
    ctx.on('close', () => {
      if (context === ctx) context = null;
      castPage = null; frame = null;
      if (!stopping) setCapture({status: 'stopped', note: 'The game window was closed. Click Start capture to open it again.'});
    });
    await ctx.exposeBinding('__v32Report', (src, snap) => {
      // Never read the monitor's own pages (the dashboard shows results, balances and tables that
      // would look like a game). Only the game is read.
      let frameUrl = '';
      try { frameUrl = src.frame ? src.frame.url() : src.page.url(); } catch {}
      if (isOwnPage(frameUrl)) {
        if (Date.now() - ownPageWarnedAt > 10000) {
          ownPageWarnedAt = Date.now();
          setCapture({note: 'The game window is showing this monitor, not the game. Open V-32 Cards in that window (Virtual Game → V-32 Cards); this dashboard is not read.'});
        }
        return;
      }
      if (snap && Array.isArray(snap.results) && src.page && src.page !== gamePage) {
        gamePage = src.page;
        watchPage(gamePage);
        // The table's address is shown but not saved: on Broplay, opening it directly sends you
        // to the logged-out home page, so the start address stays the one you entered.
        try { setCapture({gameUrl: gamePage.url()}); } catch {}
      }
      if (snap && snap.disconnected && src.frame) reconnect(src.frame);
      if (src.frame) gameFrame = src.frame;
      onSnapshot(snap);
    });
    await ctx.addInitScript({path: STAY_VISIBLE_SCRIPT});
    await ctx.addInitScript({path: CAPTURE_SCRIPT});
    const page = ctx.pages()[0] || await ctx.newPage();
    keepFocused(page); watchPage(page); watchForGamesList(page);
    ctx.on('page', p => { keepFocused(p); watchForGamesList(p); if (!gamePage) watchPage(p); });
    setCapture({status: 'waiting', note: 'Game window open. Log in if asked and open V-32 Cards; results appear here as rounds finish.'});
    page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60000}).catch(e => {
      if (context === ctx && capture.status === 'waiting') setCapture({note: `The page did not load (${String(e.message).split('\n')[0]}). Check the address, or load it in the game window.`});
    });
    return {ok: true};
  }

  // Brings the monitor's own game window to the front, so it is easy to tell apart from other browsers.
  async function showWindow() {
    const page = gamePage || castPage || (context && context.pages().at(-1));
    if (!page) return {ok: false, error: 'The game window is not open. Click Start capture first.'};
    try { await page.bringToFront(); } catch {}
    return {ok: true, pages: context ? context.pages().map(p => p.url()) : []};
  }

  async function stop(note = 'Capture stopped.') {
    const ctx = context;
    context = null; castPage = null; castSession = null; gamePage = null; gameFrame = null; frame = null; lastStrip = null;
    stopping = true;
    try { if (ctx) await ctx.close(); } catch {} finally { stopping = false; }
    setCapture({status: 'stopped', note});
    return {ok: true};
  }

  // ---------------------------------------------------------------- HTTP
  function readJson(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e5) { reject(Object.assign(new Error('Too large'), {statusCode: 413})); req.destroy(); } });
      req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(Object.assign(new Error('Bad JSON'), {statusCode: 400})); } });
    });
  }
  function csv() {
    const lines = ['time,winner,round_id,gap'];
    for (const r of rounds) lines.push(`${new Date(r.t).toISOString()},${r.n},${r.round || ''},${r.gap ? 1 : 0}`);
    return lines.join('\n') + '\n';
  }

  let boundPort = port;
  async function handle(req, res) {
    // Local use only: other websites can't drive it (checked by Host, and by Origin on POST).
    const host = String(req.headers.host || '');
    const allowed = [`localhost:${boundPort}`, `127.0.0.1:${boundPort}`];
    if (!allowed.includes(host)) { res.writeHead(403).end('forbidden'); return; }
    if (req.method === 'POST' && req.headers.origin && !allowed.map(h => `http://${h}`).includes(req.headers.origin)) { res.writeHead(403).end('forbidden'); return; }
    const {pathname} = new URL(req.url, `http://${host}`);
    const json = (code, body) => res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}).end(JSON.stringify(body));

    if (req.method === 'GET') {
      if (demo && pathname === '/demo') {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        return fs.createReadStream(path.join(PUBLIC_DIR, 'demo.html')).pipe(res);
      }
      if (STATIC[pathname]) {
        const [file, type] = STATIC[pathname];
        res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store'});
        return fs.createReadStream(path.join(PUBLIC_DIR, file)).pipe(res);
      }
      if (pathname === '/models.js') {
        res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store'});
        return fs.createReadStream(path.join(__dirname, 'lib', 'models.js')).pipe(res);
      }
      if (pathname === '/game.js') {
        res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store'});
        return fs.createReadStream(path.join(__dirname, 'lib', 'game.js')).pipe(res);
      }
      if (pathname === '/api/state') return json(200, state());
      if (pathname === '/api/rounds.csv') {
        return res.writeHead(200, {'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="v32-rounds.csv"'}).end(csv());
      }
      if (pathname === '/events') {
        res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
        res.write(`data: ${JSON.stringify(state())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (pathname === '/preview') {
        res.writeHead(200, {'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
        viewers.add(res);
        if (frame) writeFrame(res, frame);
        req.on('close', () => viewers.delete(res));
        return;
      }
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (pathname === '/api/start') return json(200, await start(body.url));
      if (pathname === '/api/stop') return json(200, await stop());
      if (pathname === '/api/show') return json(200, await showWindow());
      if (pathname === '/api/settings') {
        const r = V32.checkSettings(body);
        if (!r.ok) return json(400, r);
        settings = r.settings; store.saveSettings(settings);
        if (session && session.active) { session.alarm = null; checkLimits(); saveSession(); }
        broadcast();
        if (settings.autoClick && settings.autoClickAmount > 0) {
          setTimeout(() => checkAndTriggerAutoClick(), 100);
        }
        return json(200, {ok: true});
      }
      if (pathname === '/api/practice/start') {
        const c = V32.checkPractice(body);
        if (!c.ok) return json(400, c);
        if (!tableOdds || !tableOdds.back) return json(400, {ok: false, error: "The table's odds haven't been read yet. Open V-32 Cards and wait until betting opens (the odds show instead of locks)."});
        practice = V32.newPractice(c.practice, rounds.map(x => x.n), Date.now(), tableOdds.back);
        store.savePractice(practice); broadcast();
        return json(200, {ok: true});
      }
      if (pathname === '/api/practice/stop') {
        if (practice && practice.active) { practice = {...practice, active: false, stopped: 'you', stoppedAt: Date.now()}; store.savePractice(practice); broadcast(); }
        return json(200, {ok: true});
      }
      if (pathname === '/api/session/start') { const r = startSession(body); return json(r.ok ? 200 : 400, r); }
      if (pathname === '/api/session/end') { const r = endSession(body.reason || 'ended'); return json(r.ok ? 200 : 400, r); }
      if (pathname === '/api/session/balance') {
        const v = Number(body.balance);
        if (!(Number.isFinite(v) && v >= 0)) return json(400, {ok: false, error: 'Enter your balance as a number.'});
        if (!session || !session.active) return json(400, {ok: false, error: 'No session is running.'});
        setBalance(v, 'typed');
        return json(200, {ok: true});
      }
      if (pathname === '/api/alarm/ack') {
        if (session && session.alarm) {
          session.alarm.acknowledged = true; saveSession();
          // A reached stop-loss, budget or time limit ends the session once you confirm you stopped.
          if (body.endSession) endSession(`limit: ${session.alarm.kind}`);
          broadcast();
        }
        return json(200, {ok: true});
      }
      if (pathname === '/api/click') {
        const pick = chooseClick(body.number, body.amount);
        if (pick.error) return json(400, {ok: false, error: pick.error[0].toUpperCase() + pick.error.slice(1)});
        const num = pick.number, amt = pick.amount;
        const res = await clickGameNumberAndAmount(num, amt);
        lastAutoClickAction = {
          at: Date.now(),
          round: capture.round || 'manual',
          number: num,
          amount: amt,
          ok: res.ok,
          error: res.ok ? null : res.error,
          detail: res,
        };
        broadcast();
        return json(res.ok ? 200 : 400, res);
      }
      if (pathname === '/api/autoclick' || pathname === '/api/autoclick/toggle') {
        if (!settings) settings = store.loadSettings() || {};
        if (body.enabled !== undefined) settings.autoClick = !!body.enabled;
        if (body.number !== undefined) settings.autoClickNumber = String(body.number);
        if (body.amount !== undefined) settings.autoClickAmount = Number(body.amount) > 0 ? Number(body.amount) : null;
        if (settings.autoClick && !(settings.autoClickAmount > 0)) { settings.autoClick = false; return json(400, {ok: false, error: 'Enter the amount to bet (₹) before turning auto-click on.'}); }
        store.saveSettings(settings);
        broadcast();
        if (settings.autoClick) {
          setTimeout(() => checkAndTriggerAutoClick(), 100);
        }
        return json(200, {ok: true, settings});
      }
    }
    return json(404, {ok: false, error: 'Not found'});
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
      if (res.headersSent) return res.destroy();
      res.writeHead(e.statusCode || 500, {'Content-Type': 'application/json'}).end(JSON.stringify({ok: false, error: e.statusCode ? e.message : 'Request failed. Check the server log.'}));
      if (!e.statusCode) console.error(e);
    });
  });

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { boundPort = server.address().port; resolve(boundPort); });
    }),
    close: async () => {
      clearInterval(grabTimer); clearInterval(limitTimer); clearInterval(staleTimer); clearInterval(awakeTimer);
      for (const res of [...clients, ...viewers]) res.end();
      await stop('');
      await new Promise(r => server.close(r));
    },
    onSnapshot, state, start, stop, isOwnPage,
    gamePages: () => (context ? context.pages() : []), // For the end-to-end tests.
    clickNumberAndAmount: (num, amt) => clickGameNumberAndAmount(num, amt),
    triggerAutoClick: checkAndTriggerAutoClick,
  };
}

module.exports = {createMonitor};

if (require.main === module) {
  const port = Number(process.env.PORT) || 4330;
  const monitor = createMonitor({port, headless: process.env.MONITOR_HEADLESS === '1'});
  monitor.listen().then(p => {
    const link = `http://localhost:${p}`;
    console.log(`V-32 Live Monitor is running at ${link}  (press Ctrl+C to quit)`);
    if (process.env.MONITOR_NO_OPEN !== '1') {
      const [cmd, args] = process.platform === 'darwin' ? ['open', [link]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]] : ['xdg-open', [link]];
      try { spawn(cmd, args, {stdio: 'ignore', detached: true}).unref(); } catch {}
    }
  }).catch(e => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy. Is the monitor already running? Open http://localhost:${port}` : e);
    process.exit(1);
  });
  let quitting = false;
  const quit = () => {
    if (quitting) process.exit(0);
    quitting = true;
    console.log('Closing… (press Ctrl+C again to force)');
    setTimeout(() => process.exit(0), 5000).unref();
    monitor.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}
