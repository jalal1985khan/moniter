// Dashboard: listens to the monitor's live state and draws it. All analysis runs here, from the
// captured results, with the shared rules in game.js (window.V32).
(() => {
  const $ = id => document.getElementById(id);
  const money = v => v == null ? '–' : (v < 0 ? '−' : '') + '₹' + Math.abs(v).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const PLAYER_COLOR = {8: 'var(--series-1)', 9: 'var(--series-2)', 10: 'var(--series-3)', 11: 'var(--series-4)'};
  const pct = x => x == null ? '–' : (x * 100).toFixed(1) + '%';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  let S = null, firstState = true, settingsOpenedOnce = false, lastTotal = null;

  async function post(path, body = {}) {
    const r = await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    return r.json().catch(() => ({ok: false, error: 'No answer from the monitor.'}));
  }

  // ---------------------------------------------------------------- alarm: sound, title, notification
  let audio = null, beepTimer = 0, titleTimer = 0;
  document.addEventListener('click', () => { if (!audio) try { audio = new AudioContext(); } catch {} }, {once: true});
  function beep() {
    if (!audio) return;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'square'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.4);
    o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.4);
  }
  let alarmKey = '';
  function alarm(sessionObj) {
    const a = sessionObj && sessionObj.alarm;
    const on = a && !a.acknowledged;
    const key = a ? a.kind + a.at + a.acknowledged : '';
    const banner = $('banner');
    if (!a) { banner.className = 'banner'; stopNoise(); alarmKey = ''; return; }
    // The amounts when the limit was reached: the alarm stays on even if the balance recovers.
    const st = {net: a.net != null ? a.net : (sessionObj.status || {}).net, minutes: a.minutes};
    const text = {
      loss: ['Stop-loss reached. Stop playing now.', `You were down ${money(st.net != null ? -st.net : null)} when it was reached. Turn off any Auto Play in the game and walk away.`],
      target: ['Profit target reached.', `You are up ${money(st.net)}. This is your planned point to stop and keep it.`],
      time: ['Time limit reached.', `You have played ${Math.round(st.minutes || 0)} minutes. Time to stop.`],
    }[a.kind] || ['Limit reached', ''];
    $('bannerTitle').textContent = text[0];
    $('bannerText').textContent = text[1];
    banner.className = `banner show ${a.kind}${on ? '' : ' ack'}`;
    $('bannerKeep').classList.toggle('hidden', !on);
    if (key === alarmKey) return;
    alarmKey = key;
    stopNoise();
    if (!on) return;
    if (S.settings && S.settings.alarmSound) { beep(); beepTimer = setInterval(beep, 1200); }
    let flip = false;
    titleTimer = setInterval(() => { document.title = (flip = !flip) ? '⚠ ' + text[0] : 'V-32 Live Monitor'; }, 900);
    try { if (Notification.permission === 'granted') new Notification('V-32 Monitor: ' + text[0], {body: text[1]}); } catch {}
  }
  function stopNoise() { clearInterval(beepTimer); clearInterval(titleTimer); document.title = 'V-32 Live Monitor'; }
  $('bannerAck').onclick = () => post('/api/alarm/ack', {endSession: true});
  $('bannerKeep').onclick = () => post('/api/alarm/ack', {endSession: false});

  // ---------------------------------------------------------------- settings
  const form = $('settingsForm');
  function openSettings() {
    const s = (S && S.settings) || {budget: '', lossLimit: '', profitTarget: 0, timeLimitMin: 60, newestSide: 'auto', alarmSound: true, autoReconnect: true, autoOpenGame: true, autoClick: false, autoClickNumber: 'auto', autoClickAmount: '', autoClickPauseAfterLoss: false};
    for (const k of ['budget', 'lossLimit', 'profitTarget', 'timeLimitMin', 'newestSide']) form.elements[k].value = s[k];
    form.elements.alarmSound.checked = s.alarmSound !== false;
    form.elements.autoReconnect.checked = s.autoReconnect !== false;
    form.elements.autoOpenGame.checked = s.autoOpenGame !== false;
    form.elements.autoClick.checked = s.autoClick === true;
    form.elements.autoClickNumber.value = s.autoClickNumber || 'auto';
    form.elements.autoClickAmount.value = s.autoClickAmount > 0 ? s.autoClickAmount : '';
    form.elements.autoClickPauseAfterLoss.checked = s.autoClickPauseAfterLoss === true;
    $('settingsErr').textContent = '';
    $('settings').showModal();
  }
  $('openSettings').onclick = openSettings;
  $('cancelSettings').onclick = () => $('settings').close();
  form.onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(['budget', 'lossLimit', 'profitTarget', 'timeLimitMin', 'newestSide'].map(k => [k, form.elements[k].value]));
    body.alarmSound = form.elements.alarmSound.checked;
    body.autoReconnect = form.elements.autoReconnect.checked;
    body.autoOpenGame = form.elements.autoOpenGame.checked;
    body.autoClick = form.elements.autoClick.checked;
    body.autoClickNumber = form.elements.autoClickNumber.value;
    body.autoClickAmount = form.elements.autoClickAmount.value;
    body.autoClickPauseAfterLoss = form.elements.autoClickPauseAfterLoss.checked;
    const r = await post('/api/settings', body);
    if (!r.ok) { $('settingsErr').textContent = r.error; return; }
    $('settings').close();
  };

  // ---------------------------------------------------------------- all the ways to win (exact)
  let waysDone = false;
  const EX = V32.exact();
  function renderWays() {
    if (waysDone) return;
    waysDone = true;
    const n = EX.deals, num = v => v.toLocaleString();
    $('waysSum').textContent = `There are ${num(n)} ways to deal one card to each player (32 × 31 × 30 × 29). `
      + V32.PLAYERS.map(p => `Player ${p} wins ${num(EX.outright[p])} outright`).join(', ')
      + `. ${num(EX.ties[2] + EX.ties[3] + EX.ties[4])} deals end in a tie for the top total (${num(EX.ties[2])} two-way, ${num(EX.ties[3])} three-way, ${num(EX.ties[4])} four-way) and the tied players draw again; each then has an equal chance.`;
    const rows = [];
    for (let v = 6; v <= 13; v++) {
      const tds = V32.PLAYERS.map(p => {
        const c = EX.cardChance[p][v];
        const a = Math.min(1, c.chance * 0.85 + (c.chance > 0 ? 0.05 : 0));
        return `<td class="cell${c.chance > 0.55 ? ' dark' : ''}" style="--a:${a.toFixed(3)}">${pct(c.chance)}<small>(${c.total})</small></td>`;
      });
      rows.push(`<tr><td>${V32.CARD_NAMES[v]}</td>${tds.join('')}</tr>`);
    }
    $('waysT').innerHTML = rows.join('');
    const opts = '<option value="">?</option>' + Object.entries(V32.CARD_NAMES).reverse().map(([v, name]) => `<option value="${v}">${name}</option>`).join('');
    $('waysPick').innerHTML = V32.PLAYERS.map(p => `<label>Player ${p}<select data-p="${p}">${opts}</select></label>`).join('');
    const update = () => {
      const known = {};
      for (const sel of $('waysPick').querySelectorAll('select')) if (sel.value) known[sel.dataset.p] = Number(sel.value);
      const r = V32.exact(known);
      $('waysIf').innerHTML = r ? V32.PLAYERS.map(p => `<tr><td>Player ${p}${known[p] ? ` · ${V32.CARD_NAMES[known[p]]} = ${p + known[p]}` : ''}</td><td>${pct(r.win[p])}</td></tr>`).join('')
        : '<tr><td colspan="2">A card value appears only 4 times in the deck: pick fewer of the same card.</td></tr>';
    };
    $('waysPick').addEventListener('change', update);
    update();
  }

  // ---------------------------------------------------------------- capture and session buttons
  $('start').onclick = async () => {
    const r = await post('/api/start', {url: $('url').value});
    if (!r.ok) $('note').textContent = r.error;
  };
  $('stop').onclick = () => post('/api/stop');
  $('show').onclick = async () => {
    // On a server the Chrome window sits on the server's own screen, so open the remote view of it
    // (noVNC behind /vnc/). Opened before any await so the browser does not block the new tab.
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    const remote = local ? null : window.open('/vnc/vnc.html?autoconnect=1&resize=scale&path=vnc/websockify', 'v32-game');
    const r = await post('/api/show');
    if (!r.ok) $('note').textContent = r.error;
    else if (!local && !remote) $('note').textContent = 'Your browser blocked the new tab. Allow pop-ups for this site, or open /vnc/vnc.html yourself.';
  };
  $('startSession').onclick = () => {
    try { if (Notification.permission === 'default') Notification.requestPermission(); } catch {}
    const f = $('startForm').elements, st = S.settings || {}, last = S.practice || {};
    if (!$('sdMethod').options.length && S.practiceMethods) $('sdMethod').innerHTML = S.practiceMethods.map(m => `<option>${esc(m)}</option>`).join('');
    f.budget.value = st.budget || ''; f.lossLimit.value = st.lossLimit || '';
    f.profitTarget.value = st.profitTarget || 0; f.timeLimitMin.value = st.timeLimitMin || 0;
    f.method.value = last.method || (S.practiceMethods || [])[0] || '';
    f.stake.value = last.stake || ''; f.progression.value = last.progression || 'flat'; f.maxRounds.value = last.maxRounds || 0;
    $('sdBal').textContent = S.capture.balance > 0 ? money(S.capture.balance) : (Number($('startBal').value) > 0 ? money(Number($('startBal').value)) + ' (typed)' : 'not read yet');
    $('startErr').textContent = '';
    $('startDlg').showModal();
  };
  $('cancelStart').onclick = () => $('startDlg').close();
  $('startForm').elements.autoplay.onchange = e => { $('sdAuto').style.opacity = e.target.checked ? 1 : 0.4; for (const el of $('sdAuto').querySelectorAll('input,select')) el.disabled = !e.target.checked; };
  $('startForm').onsubmit = async e => {
    e.preventDefault();
    const f = $('startForm').elements, err = $('startErr');
    const liveBal = S.capture.balance > 0 && ['live', 'stale'].includes(S.capture.status);
    const typed = Number($('startBal').value);
    if (!liveBal && !(typed > 0)) { err.textContent = "Your balance can't be read from the game yet. Open V-32 Cards in the game window, or type it in the session card."; return; }
    const startBal = liveBal ? S.capture.balance : typed;
    // 1. Limits are saved as your settings.
    const st = {...(S.settings || {alarmSound: true, autoReconnect: true, newestSide: 'auto'}), budget: f.budget.value, lossLimit: f.lossLimit.value, profitTarget: f.profitTarget.value, timeLimitMin: f.timeLimitMin.value};
    let r = await post('/api/settings', st);
    if (!r.ok) { err.textContent = r.error; return; }
    // 2. Autoplay (pretend money) from the same balance and limits.
    if (f.autoplay.checked) {
      if (!(Number(f.stake.value) > 0)) { err.textContent = 'Enter the pretend stake per round for autoplay (or untick autoplay).'; return; }
      if (S.practice && S.practice.active) await post('/api/practice/stop');
      r = await post('/api/practice/start', {method: f.method.value, stake: f.stake.value, startBalance: startBal, stopLoss: f.lossLimit.value, target: f.profitTarget.value, maxRounds: f.maxRounds.value, progression: f.progression.value});
      if (!r.ok) { err.textContent = r.error; return; }
    }
    // 3. The session itself, from the live game balance.
    r = await post('/api/session/start', liveBal ? {} : {startBalance: typed});
    if (!r.ok) { if (f.autoplay.checked) await post('/api/practice/stop'); err.textContent = r.error; return; }
    $('startDlg').close();
  };
  $('endSession').onclick = () => { if (confirm('End this session?')) post('/api/session/end', {reason: 'ended'}); };
  $('setBal').onclick = async () => {
    const r = await post('/api/session/balance', {balance: $('manualBal').value});
    if (r.ok) $('manualBal').value = ''; else alert(r.error);
  };

  // ---------------------------------------------------------------- live view
  let previewOn = false;
  function preview(active) {
    if (active === previewOn) return;
    previewOn = active;
    $('preview').innerHTML = active ? '<img src="/preview" alt="Live view of the game window">' : '<div class="empty">Start capture to see the game here.</div>';
  }

  // ---------------------------------------------------------------- game stopped producing rounds
  let staleKey = null;
  function staleWarning(c) {
    if (c.status !== 'stale') { staleKey = null; return; }
    if (staleKey === c.staleAt) return;
    staleKey = c.staleAt;
    if (S.settings && S.settings.alarmSound !== false) { beep(); setTimeout(beep, 400); setTimeout(beep, 800); }
    try { if (Notification.permission === 'granted') new Notification('V-32 Monitor: no new rounds', {body: c.note || ''}); } catch {}
  }

  // ---------------------------------------------------------------- win % overlay on the live view
  // Each player's true chance, their share of the last 20 captured rounds, and how far that share
  // is from the true chance. The arrow shows which way the share moved with the latest round.
  const OV_N = 20;
  let ovOn = true;
  try { ovOn = localStorage.getItem('v32-ov') !== 'off'; } catch {}
  $('ovToggle').checked = ovOn;
  $('ovToggle').onchange = () => { ovOn = $('ovToggle').checked; try { localStorage.setItem('v32-ov', ovOn ? 'on' : 'off'); } catch {} renderOverlay(true); };
  let ovKey = null, ovSize = 'normal';
  try { ovSize = localStorage.getItem('v32-ov-size') || 'normal'; } catch {}
  $('ov').addEventListener('click', e => {
    const b = e.target.closest('[data-ov]');
    if (!b) return;
    ovSize = b.dataset.ov;
    try { localStorage.setItem('v32-ov-size', ovSize); } catch {}
    renderOverlay(true);
  });
  function share(vals) {
    const out = {}; for (const p of V32.PLAYERS) out[p] = vals.length ? vals.filter(v => v === p).length / vals.length : null;
    return out;
  }
  // The live pick check, as a strip on the overlay: next pick, how the last round went, hit rate.
  function pickStrip(best, last, win) {
    // Auto's live pick: before each round, the method with the best record on your captured rounds.
    // Scored walk-forward over the rounds since capture started (each pick from earlier rounds only).
    const values = S.values || [], live = S.liveValues || [];
    const nextAuto = V32.autoChoose(values), nextPick = V32.SYSTEMS[nextAuto.method](values);
    const k0 = values.length - live.length;
    let aHits = 0, aN = 0, lastAuto = null;
    for (let k = Math.max(1, k0); k < values.length; k++) {
      const h = values.slice(0, k), g = V32.SYSTEMS[V32.autoChoose(h).method](h);
      aN++; if (g === values[k]) aHits++;
      if (k === values.length - 1) lastAuto = g;
    }
    const b11 = live.filter(v => v === best).length;
    const lastCell = last == null ? '<span class="flat">waiting</span>'
      : `<b>P${last} won</b> · ${lastAuto == null ? '' : lastAuto === last ? '<span class="up">✓ auto hit</span> ' : `<span class="down">✗ auto missed</span> <span class="flat">(picked P${lastAuto})</span> `}`;
    const rateCell = aN ? `<b>${pct(aHits / aN)}</b> <span class="flat">auto · ${aHits} of ${aN}</span> &nbsp; <b>${pct(b11 / Math.max(1, live.length))}</b> <span class="flat">always ${best} · ${b11} of ${live.length}</span>` : '<span class="flat">waiting for the first round</span>';
    return `<div class="pick"><div><span class="k">Next round · auto</span><b>Player ${nextPick}</b> <span class="flat">· ${esc(nextAuto.method)}${nextAuto.hitRate != null ? ` (${pct(nextAuto.hitRate)} over last ${nextAuto.rounds})` : ''}</span></div>`
      + `<div><span class="k">Best odds</span>Player ${best} · ${pct(win[best])} · fair odds ${(1 / win[best]).toFixed(2)}</div>`
      + `<div><span class="k">Last round</span>${lastCell}</div><div><span class="k">Hit rate (this capture)</span>${rateCell}</div>${autoplayCell()}</div>`;
  }
  // While practice autoplay runs, its own next pretend bet (which can differ from the pick above).
  function autoplayCell() {
    const P = S.practice;
    if (!P || !P.active) return '';
    const st = Math.min(P.nextStake, P.balance), by = P.nextChosen ? P.nextChosen.method : P.method, net = P.balance - P.startBalance;
    const lastBet = P.bets.filter(b => !b.void).at(-1);
    return `<div class="auto"><span class="k">Autoplay (pretend)</span><b>Player ${P.nextPick}</b> · ${money(st)}${P.nextOdds ? ` @ ${P.nextOdds}` : ''} <span class="flat">· ${esc(by)}</span>`
      + `<br><span class="k"></span>${lastBet ? `last bet ${lastBet.win ? '<span class="up">won ' : '<span class="down">lost '}${money(Math.abs(lastBet.change))}</span> · ` : ''}`
      + `balance ${money(P.balance)} <span class="${net > 0 ? 'up' : net < 0 ? 'down' : 'flat'}">(${net >= 0 ? '+' : '−'}${money(Math.abs(net))})</span> · won ${P.wins} of ${P.rounds}</div>`;
  }

  function renderTimer(c) {
    const el = $('ovTimer');
    if (!el) return;
    const t = c && c.timer;
    if (t == null || !['waiting', 'live', 'stale'].includes(c && c.status)) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    $('ovTimerSec').textContent = t;
    $('ovTimerDigits').innerHTML = String(t).padStart(2, '0').split('').map(d => `<i>${d}</i>`).join('');
    el.className = 'ov-timer' + (t <= 5 ? (t === 0 ? ' zero' : ' low') : '');
    $('ovTimerIcon').textContent = t > 0 ? '⏳' : '🔒';
    $('ovTimerLbl').textContent = t > 0 ? 'BETS CLOSE' : 'CLOSED';
  }

  function renderOverlay(force) {
    const ov = $('ov');
    const show = ovOn && ['waiting', 'live', 'stale'].includes(S.capture.status);
    ov.hidden = !show;
    if (!show) return;
    const values = S.values || [];
    const P = S.practice;
    const key = values.length + ':' + values.at(-1) + ':' + S.capture.balance + ':' + S.capture.timer + ':' + (S.liveValues || []).length
      + ':' + (P ? [P.active, P.rounds, P.bets.length, P.nextPick, P.nextOdds].join() : '');
    if (!force && key === ovKey) return;
    ovKey = key;
    const win = S.odds.win;
    const now = share(values.slice(-OV_N)), before = share(values.slice(-OV_N - 1, -1));
    const last = values.at(-1);
    const n = Math.min(OV_N, values.length);
    const pp = x => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x * 100).toFixed(1);
    // The most likely winner of the next round is the player with the highest true chance.
    // Recent results don't change it: every round is a new shuffle.
    const likely = V32.PLAYERS.reduce((a, b) => (win[b] > win[a] ? b : a));
    const rows = V32.PLAYERS.map(p => {
      const diff = now[p] == null ? null : now[p] - win[p];
      const move = now[p] == null || before[p] == null || values.length < 2 ? 0 : now[p] - before[p];
      const arrow = move > 1e-9 ? '<span class="up">▲</span>' : move < -1e-9 ? '<span class="down">▼</span>' : '<span class="flat">•</span>';
      return `<tr class="${p === likely ? 'likely' : ''}"><td><span class="dot" style="background:${PLAYER_COLOR[p]}"></span>P${p}${p === likely ? ' <span class="star">★ most likely</span>' : ''}${p === last ? ' <span class="lastw">last</span>' : ''}</td>`
        + `<td>${pct(win[p])}</td><td>${now[p] == null ? '–' : pct(now[p])} ${arrow}</td>`
        + `<td class="${diff == null ? 'flat' : diff > 0.0005 ? 'up' : diff < -0.0005 ? 'down' : 'flat'}">${diff == null ? '–' : pp(diff)}</td></tr>`;
    }).join('');
    const live = S.liveValues || [], hitsL = live.filter(v => v === likely).length;
    const btns = `<span class="ov-btns"><button data-ov="min" title="Minimise">–</button><button data-ov="${ovSize === 'max' ? 'normal' : 'max'}" title="${ovSize === 'max' ? 'Normal size' : 'Maximise'}">${ovSize === 'max' ? '❐' : '□'}</button></span>`;
    const timerTag = S.capture.timer != null ? ` · <span class="${S.capture.timer <= 5 ? 'down' : 'up'}">⏳ ${S.capture.timer}s</span>` : '';
    if (ovSize === 'min') {
      ov.className = 'ov min';
      const ac = V32.autoChoose(values), ap = V32.SYSTEMS[ac.method](values);
      ov.innerHTML = `<div class="ov-mini"><span class="flat">auto</span> <span class="dot" style="background:${PLAYER_COLOR[ap]}"></span><b>P${ap}</b> <span class="flat">${esc(ac.method.replace('Always ', ''))}</span>`
        + `${last != null ? ` · last P${last}` : ''}`
        + `${S.capture.timer != null ? ` · ⏳ ${S.capture.timer}s` : ''}`
        + ` · best odds P${likely}${S.capture.balance != null ? ` · ${money(S.capture.balance)}` : ''}`
        + `<span class="ov-btns"><button data-ov="normal" title="Restore">▢</button></span></div>`;
      return;
    }
    ov.className = 'ov' + (ovSize === 'max' ? ' max' : '');
    ov.innerHTML = `<h4>WIN % · LAST ${n} ROUNDS${timerTag}${S.capture.balance != null ? ` · BAL ${money(S.capture.balance)}` : ''}${btns}</h4><table><thead><tr><th>Player</th><th>True</th><th>Last ${n}</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table>`
      + pickStrip(likely, last, win)
      + `<div class="foot">Change = last ${n} − true, in points. Swings don't predict the next round.</div>`;
  }

  // ---------------------------------------------------------------- live game balance (header)
  let lastBal = null, balFlash = null;
  function renderBalance(c) {
    const chip = $('hdrBal');
    chip.hidden = c.balance == null;
    if (c.balance == null) return;
    $('hdrBalV').textContent = money(c.balance);
    const d = c.firstBalance != null ? c.balance - c.firstBalance : 0;
    const dEl = $('hdrBalD');
    dEl.textContent = Math.abs(d) < 0.005 ? '' : `${d > 0 ? '+' : '−'}${money(Math.abs(d))} since capture started`;
    dEl.className = d > 0 ? 'pos' : d < 0 ? 'neg' : '';
    if (lastBal != null && c.balance !== lastBal) {
      chip.classList.remove('flash-up', 'flash-down'); void chip.offsetWidth;
      chip.classList.add(c.balance > lastBal ? 'flash-up' : 'flash-down');
      clearTimeout(balFlash); balFlash = setTimeout(() => chip.classList.remove('flash-up', 'flash-down'), 1500);
    }
    lastBal = c.balance;
  }

  // ---------------------------------------------------------------- model lab (trained models)
  // Trained only on rounds captured from your game; retrains on every new round.
  let labKey = null;
  let labTrainedAt = 0, labBtnTimer;
  $('labTrain').onclick = () => {
    const btn = $('labTrain');
    btn.disabled = true; btn.textContent = 'Retraining…';
    // Let the button repaint before the (synchronous) training runs.
    setTimeout(() => {
      runLab();
      btn.textContent = 'Retrained ✓';
      clearTimeout(labBtnTimer);
      labBtnTimer = setTimeout(() => { btn.disabled = false; btn.textContent = 'Retrain now'; }, 1500);
    }, 30);
  };
  function renderLab() {
    const values = S.values || [];
    if (values.length + ':' + values.at(-1) + ':' + (S.tableOdds && S.tableOdds.at) !== labKey) runLab();
  }
  function runLab() {
    const values = S.values || [];
    labKey = values.length + ':' + values.at(-1) + ':' + (S.tableOdds && S.tableOdds.at);
    const t0 = performance.now();
    labTrainedAt = Date.now();
    const res = V32Models.train(values, {prior: S.odds.win, odds: liveOdds()});
    drawLab(res, {real: values.length, ms: performance.now() - t0});
  }
  function drawLab(res, {real, ms}) {
    const scored = res[0].rounds;
    $('labInfo').textContent = `Trained on the ${real.toLocaleString()} rounds captured from your game · ${Math.round(ms)} ms · last trained ${new Date(labTrainedAt).toLocaleTimeString()} (it also retrains by itself on every new round, so with no new rounds the numbers stay the same).${liveOdds() ? '' : " Money columns appear once the table's odds have been read."}`;
    if (!scored) { $('labT').innerHTML = '<tr><td colspan="7" class="muted">Waiting for rounds.</td></tr>'; $('labVerdict').textContent = ''; return; }
    const learned = res.slice(1);
    const best = learned.reduce((a, b) => (b.vsExact > a.vsExact ? b : a));
    const v = $('labVerdict');
    if (best.z > 2.5 && scored >= 300) {
      v.className = 'lab-verdict edge';
      v.textContent = `${best.name} beats the 32-card math by ${(best.vsExact * 100).toFixed(1)} points (z ${best.z.toFixed(1)}) over ${scored.toLocaleString()} rounds. If this holds with more rounds and no capture gaps, the real game isn't dealing like a fair shuffle. Keep capturing before trusting it.`;
    } else {
      v.className = 'lab-verdict';
      v.textContent = `No model beats the 32-card math. Best learned model: ${best.name}, ${best.vsExact >= 0 ? '+' : '−'}${Math.abs(best.vsExact * 100).toFixed(1)} points (z ${best.z.toFixed(1)}, within normal luck). The best prediction is still Player ${res[0].nextPick} at ${pct(res[0].next[res[0].nextPick])}.`
        + (scored < 300 ? ` Only ${scored} rounds scored so far, so the numbers will keep moving.` : '');
    }
    const money100 = x => (x > 0 ? '+' : x < 0 ? '−' : '') + '₹' + Math.round(Math.abs(x * 100)).toLocaleString('en-IN');
    $('labT').innerHTML = res.map((m, k) => {
      const bar = V32.PLAYERS.map(p => `<i style="width:${(m.next[p] * 100).toFixed(1)}%;background:${PLAYER_COLOR[p]}"></i>`).join('');
      const vs = k === 0 ? '<small>baseline</small>' : `${m.vsExact >= 0 ? '+' : '−'}${Math.abs(m.vsExact * 100).toFixed(2)} pts <small>z ${m.z.toFixed(1)}</small>`;
      return `<tr title="${esc(m.about)}"><td>${esc(m.name)}</td><td>${ball(m.nextPick)} <small>${pct(m.next[m.nextPick])}</small><span class="probbar">${bar}</span></td>`
        + `<td>${pct(m.hitRate)}</td><td class="${k && m.z > 2.5 ? 'ok' : k && m.z < -2.5 ? 'no' : ''}">${vs}</td><td>${m.logScore.toFixed(3)}</td>`
        + `<td class="${m.net > 0 ? 'ok' : 'no'}">${m.net == null ? '–' : money100(m.net)}</td>`
        + `<td>${m.valueBets == null ? '–' : m.valueBets ? `${m.valueBets.toLocaleString()} <small>bets</small> <span class="${m.valueNet > 0 ? 'ok' : 'no'}">${money100(m.valueNet)}</span>` : '<small>none (never worth it)</small>'}</td></tr>`;
    }).join('');
  }

  // ---------------------------------------------------------------- practice autoplay (pretend money)
  const sgnMoney = v => (v > 0 ? '+' : v < 0 ? '−' : '') + money(Math.abs(v));
  const STOP_TEXT = {loss: 'Stopped: stop-loss reached', target: 'Stopped: profit target reached', broke: 'Stopped: pretend balance too low for the next stake', rounds: 'Stopped: round limit reached', you: 'Stopped by you', session: 'Stopped: session ended'};
  let pracMethodsFilled = false, pracKey = null, pracStopSeen = null;
  $('pracForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData($('pracForm')));
    const r = await post('/api/practice/start', body);
    $('pracErr').textContent = r.ok ? '' : r.error;
  });
  $('pracStop').onclick = () => post('/api/practice/stop');
  function renderPractice() {
    if (!pracMethodsFilled && S.practiceMethods) {
      pracMethodsFilled = true;
      $('pracMethod').innerHTML = S.practiceMethods.map(m => `<option>${esc(m)}</option>`).join('');
    }
    const P = S.practice, on = !!(P && P.active);
    // Fill empty fields from live data: the game balance and your session limits.
    if (!on) {
      const f = $('pracForm').elements;
      if (!f.startBalance.value && S.capture.balance > 0) f.startBalance.value = S.capture.balance;
      if (!f.stopLoss.value && S.settings && S.settings.lossLimit) f.stopLoss.value = S.settings.lossLimit;
      if (!f.target.value && S.settings && S.settings.profitTarget) f.target.value = S.settings.profitTarget;
    }
    $('pracStart').disabled = on; $('pracStop').disabled = !on;
    for (const el of $('pracForm').querySelectorAll('input,select')) el.disabled = on;
    $('pracState').textContent = on ? `Running · ${P.method}` : P && P.stopped ? STOP_TEXT[P.stopped] || 'Stopped' : 'Off';
    $('pracState').className = on ? 'pos' : P && P.stopped && !['you', 'session'].includes(P.stopped) ? 'neg' : 'muted';
    if (!P) {
      $('pracNext').textContent = '–'; $('pracBal').textContent = '–'; $('pracRate').textContent = '–';
      $('pracNextSub').textContent = 'Set it up and press Start autoplay.'; $('pracBalSub').textContent = ''; $('pracRateSub').textContent = '';
      Viz.line($('chPrac'), {points: [], emptyText: 'The pretend balance is charted here round by round.'});
      $('pracBets').innerHTML = '';
      return;
    }
    // A run that stops by itself gets one beep and a notification.
    if (P.stopped && !['you', 'session'].includes(P.stopped) && pracStopSeen !== P.stoppedAt) {
      if (pracStopSeen !== null && S.settings && S.settings.alarmSound !== false) { beep(); setTimeout(beep, 400); }
      if (pracStopSeen !== null) { try { if (Notification.permission === 'granted') new Notification('Practice autoplay stopped', {body: STOP_TEXT[P.stopped]}); } catch {} }
      pracStopSeen = P.stoppedAt;
    } else if (pracStopSeen === null) pracStopSeen = P.stoppedAt || 0;
    const key = [P.active, P.rounds, P.bets.length, P.balance, P.stopped].join(':');
    if (key === pracKey) return;
    pracKey = key;
    if (on) {
      $('pracNext').textContent = `Player ${P.nextPick}`;
      const st = Math.min(P.nextStake, P.balance);
      const ch = P.nextChosen;
      const why = ch ? (ch.hitRate == null ? ` · Auto: ${ch.method} (fewer than 30 rounds captured yet)` : ` · Auto chose ${ch.method}: ${pct(ch.hitRate)} over your last ${ch.rounds} rounds`) : '';
      $('pracNextSub').textContent = (P.nextOdds ? `${money(st)} at ${P.nextOdds} (read from the table) · pays ${money(st * (P.nextOdds - 1))} if it wins` : `${money(st)} · void unless the table's odds are read before the round ends`) + why;
    } else { $('pracNext').textContent = 'Off'; $('pracNextSub').textContent = STOP_TEXT[P.stopped] || ''; }
    const net = P.balance - P.startBalance;
    $('pracBal').textContent = money(P.balance);
    $('pracBalSub').innerHTML = `<span class="${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">${sgnMoney(net)}</span> · started at ${money(P.startBalance)} · low ${money(P.low)}, high ${money(P.peak)}`;
    $('pracRate').textContent = P.rounds ? pct(P.wins / P.rounds) : '–';
    const chanceOf = P.bets.filter(b => !b.void).reduce((a, b) => a + S.odds.win[b.pick], 0);
    $('pracRateSub').textContent = P.rounds ? `won ${P.wins} of ${P.rounds} · by chance ${pct(chanceOf / Math.max(1, P.bets.filter(b => !b.void).length))} · ₹${Math.round(P.staked).toLocaleString('en-IN')} staked` : 'Waiting for the first round to finish.';
    const pts = P.curve.map(c => ({x: c.i, y: c.b}));
    const refs = [{y: P.startBalance, label: 'start'}];
    if (P.stopLoss > 0) refs.push({y: P.startBalance - P.stopLoss, label: 'stop-loss', cls: 'loss'});
    if (P.target > 0) refs.push({y: P.startBalance + P.target, label: 'target', cls: 'win'});
    Viz.line($('chPrac'), {points: pts, step: true, refs, height: 160, yFmt: v => '₹' + Math.round(v).toLocaleString('en-IN'), xFmt: v => `#${v}`,
      emptyText: 'The pretend balance is charted here round by round.',
      tipFor: i => [[money(pts[i].y), 'pretend balance'], [sgnMoney(pts[i].y - P.startBalance), 'net'], [`after round ${pts[i].x}`, '']]});
    $('pracBets').innerHTML = P.bets.slice(-12).reverse().map(b => b.void
      ? `<tr><td>${clockT(b.t)}</td><td>${b.round || '–'}</td><td>${ball(b.pick)}</td><td>${ball(b.result)}</td><td colspan="3" class="muted">void – ${b.void === 'odds' ? "table odds weren't read" : 'capture gap before this round'}</td></tr>`
      : `<tr><td>${clockT(b.t)}</td><td>${b.round || '–'}</td><td>${ball(b.pick)}${b.by ? ` <small class="muted">${esc(b.by)}</small>` : ''}</td><td>${ball(b.result)}</td><td>${money(b.stake)}${b.odds ? ` <small class="muted">@ ${b.odds}</small>` : ''}</td><td class="${b.win ? 'ok' : 'no'}">${b.win ? '✓ ' : '✗ '}${sgnMoney(b.change)}</td><td>${money(b.balance)}</td></tr>`).join('')
      || '<tr><td colspan="7" class="muted">No rounds yet.</td></tr>';
  }

  // ---------------------------------------------------------------- auto-click number and amount in game
  const acShow = (text, cls) => { $('acMsg').textContent = text; $('acMsg').className = cls; };
  const acSeen = r => (r.seen ? `\nWhat the game page showed: ${r.seen}` : '');
  $('acToggle').onclick = async () => {
    const cur = S && S.autoClick && S.autoClick.enabled;
    const num = $('acNumber').value, amt = Number($('acAmount').value.trim());
    if (!cur) {
      if (!(amt > 0)) return acShow('Enter the amount to bet (₹) first.', 'err');
      if (!confirm(`Auto-click places REAL bets in the game: ${num === 'auto' ? 'the prediction pick from your captured rounds' : 'Player ' + num}, ₹${amt} every round until you disable it or a session limit is reached. Turn it on?`)) return;
    }
    const r = await post('/api/autoclick/toggle', { enabled: !cur, number: num, amount: amt || null });
    if (!r.ok) acShow(r.error, 'err');
    else if (!cur) acShow('Auto-click enabled. Placing bet when betting opens…', 'pos');
    else acShow('Auto-click disabled.', 'muted');
  };
  $('acClickNow').onclick = async () => {
    const num = $('acNumber').value, amt = Number($('acAmount').value.trim());
    if (!(amt > 0)) return acShow('Enter the amount to bet (₹) first.', 'err');
    if (!confirm(`This places a REAL bet now: ${num === 'auto' ? 'the prediction pick' : 'Player ' + num}, ₹${amt}. Continue?`)) return;
    acShow('Placing the bet in the game…', 'muted');
    const r = await post('/api/click', { number: num, amount: amt });
    acShow(r.ok ? `✓ Bet confirmed in My Bet: Player ${r.player} at ${r.detail && r.detail.odds}, ₹${r.amount}.` : `⚠ ${r.error}${acSeen(r)}`, r.ok ? 'pos' : 'err');
  };
  function renderAutoClick() {
    const ac = S && S.autoClick;
    const enabled = !!(ac && ac.enabled);
    const waiting = !!(ac && ac.waitingForPrediction && ac.pauseAfterLoss);
    $('acState').textContent = waiting ? 'Paused after loss · waiting for a prediction match' : enabled ? `Active · ${ac.number === 'auto' ? 'prediction pick' : 'P' + ac.number} @ ₹${ac.amount}` : 'Off';
    $('acState').className = waiting ? 'warn' : enabled ? 'pos' : 'muted';
    $('acToggle').textContent = enabled ? '■ Disable auto-click' : '▶ Enable auto-click';
    $('acToggle').className = enabled ? 'danger' : 'primary';
    if (ac) {
      if (document.activeElement !== $('acNumber')) $('acNumber').value = ac.number || 'auto';
      if (document.activeElement !== $('acAmount') && ac.amount > 0 && !$('acAmount').value) $('acAmount').value = ac.amount;
    }
    const act = ac && ac.lastAction;
    if (waiting && document.activeElement !== $('acClickNow')) {
      $('acMsg').textContent = 'Paused after a losing bet. Auto-click resumes when its prediction matches a captured result, then bets when the next round opens. This does not improve the game odds.';
      $('acMsg').className = 'warn';
      return;
    }
    if (act && document.activeElement !== $('acClickNow')) {
      const ago = Math.round((Date.now() - act.at) / 1000);
      const timeStr = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
      if (act.ok) {
        $('acMsg').textContent = `✓ Bet confirmed in My Bet: Player ${act.number}${act.detail && act.detail.detail ? ' at ' + act.detail.detail.odds : ''}, ₹${act.amount}. (${timeStr})`;
        $('acMsg').className = 'pos';
      } else if (act.error) {
        $('acMsg').textContent = `⚠ ${act.error} (${timeStr})${act.detail && act.detail.seen ? `\nWhat the game page showed: ${act.detail.seen}` : ''}`;
        $('acMsg').className = 'err';
      }
    }
  }

  // ---------------------------------------------------------------- predicted vs real result
  // Back odds read live from the V-32 table (null until betting has been open once).
  const liveOdds = () => (S.tableOdds && S.tableOdds.back) || null;
  const clockT = t => new Date(t).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
  let vsKey = null;
  const ball = p => `<span class="ball" style="background:${PLAYER_COLOR[p]}">${p}</span>`;
  function renderVs() {
    const values = S.values || [];
    const key = values.length + ':' + values.at(-1);
    if (key === vsKey) return;
    vsKey = key;
    const names = Object.keys(V32.SYSTEMS);
    const scored = values.slice(-1000);
    const odds = liveOdds();
    const bt = V32.backtest(scored, S.odds.win, odds || undefined);
    // What each Back bet returns on average at the odds read from the table and the 32-card chances.
    $('vsOddsNote').textContent = odds
      ? `Money uses the Back odds read from your table (last read ${clockT(S.tableOdds.at)}): `
        + V32.PLAYERS.map(p => `P${p} ${odds[p]}`).join(', ')
        + '. At those odds a bet returns on average: ' + V32.PLAYERS.map(p => `P${p} ${((S.odds.win[p] * odds[p] - 1) * 100).toFixed(1)}%`).join(', ') + ' of the stake.'
      : "Money figures appear once the table's odds have been read (open V-32 Cards while betting is open).";
    $('vsN').textContent = scored.length > 1 ? `(${(scored.length - 1).toLocaleString()} rounds scored)` : '';
    const signed = v => (v > 0 ? '+' : v < 0 ? '−' : '') + money(Math.abs(v)).replace('−', '');
    const main = bt[0];
    if (main.picks) {
      $('vsWin').textContent = pct(main.hitRate);
      $('vsWinSub').textContent = `Same ${main.hits} · different ${main.picks - main.hits} of ${main.picks} rounds · by chance ${pct(main.chance)}`;
      if (odds) {
        $('vsMoney').textContent = signed(main.net * 100);
        $('vsMoney').className = 'big ' + (main.net > 0 ? 'pos' : main.net < 0 ? 'neg' : '');
        $('vsMoneySub').textContent = `₹${(main.picks * 100).toLocaleString('en-IN')} bet in all · on average it would be ${signed(main.fairNet * 100)}`;
      } else { $('vsMoney').textContent = '–'; $('vsMoney').className = 'big'; $('vsMoneySub').textContent = "Table odds not read yet."; }
    } else { $('vsWin').textContent = '–'; $('vsMoney').textContent = '–'; $('vsWinSub').textContent = 'Waiting for rounds.'; $('vsMoneySub').textContent = ''; }
    // Normal luck: the win rate a method with no skill lands within 95% of the time at this many rounds.
    const range = b => { const sd = Math.sqrt(b.chance * (1 - b.chance) / b.picks); return [Math.max(0, b.chance - 2 * sd), Math.min(1, b.chance + 2 * sd)]; };
    $('vsSum').innerHTML = bt.map(b => {
      if (!b.picks) return `<tr><td>${b.name}</td><td colspan="6">–</td></tr>`;
      const [lo, hi] = range(b), inside = b.hitRate >= lo && b.hitRate <= hi;
      return `<tr><td>${b.name}</td><td>${b.hits}</td><td>${b.picks - b.hits}</td><td>${pct(b.hitRate)}</td><td>${pct(b.chance)}</td>`
        + `<td class="${inside ? '' : 'no'}" title="${inside ? 'Within normal luck' : 'Outside normal luck: check for gaps, or wait for more rounds'}">${pct(lo)}–${pct(hi)}${inside ? '' : ' ⚠'}</td>`
        + `<td class="${b.net > 0 ? 'ok' : b.net < 0 ? 'no' : ''}">${b.net == null ? '–' : signed(b.net * 100)}</td></tr>`;
    }).join('') || '<tr><td colspan="7">Waiting for rounds.</td></tr>';
    // Latest rounds: S.recent is newest first and matches the end of S.values.
    const pickOf = name => V32.SYSTEMS[name];
    const rows = [];
    const recent = (S.recent || []).slice(0, 15);
    // Each prediction is made from the rounds before that row only. Auto re-chooses, before every
    // round, the method with the best record on your captured rounds so far.
    const tally = {auto: 0, hot: 0, rep: 0, pat: 0, p11: 0, n: 0};
    const cell = (g, real, key) => { if (g === real) tally[key]++; return `<td>${ball(g)}</td><td class="${g === real ? 'ok' : 'no'}">${g === real ? '✓' : '✗'}</td>`; };
    recent.forEach((r, i) => {
      const idx = values.length - 1 - i;
      if (idx < 1 || values[idx] !== r.n) return;
      const hist = values.slice(0, idx);
      const auto = V32.autoChoose(hist), aPick = V32.SYSTEMS[auto.method](hist);
      tally.n++; if (r.n === 11) tally.p11++;
      rows.push(`<tr><td>${clockT(r.t)}</td><td>${r.round || '–'}${r.gap ? ' <span class="muted" title="Rounds may be missing before this one">(after gap)</span>' : ''}</td><td>${ball(r.n)}</td>`
        + `<td>${ball(aPick)} <small class="muted">${esc(auto.method.replace('Always ', ''))}</small></td><td class="${aPick === r.n ? 'ok' : 'no'}">${aPick === r.n ? '✓' : '✗'}</td>`
        + cell(V32.SYSTEMS['Hottest in last 20'](hist), r.n, 'hot') + cell(V32.SYSTEMS['Repeat last winner'](hist), r.n, 'rep')
        + cell(V32.SYSTEMS['Pattern: after the last 2 results'](hist), r.n, 'pat')
        + `<td class="${r.n === 11 ? 'ok' : 'no'}" style="opacity:.7">${r.n === 11 ? '✓' : '✗'}</td></tr>`);
      if (aPick === r.n) tally.auto++;
    });
    $('latestSum').textContent = tally.n ? `Right in these ${tally.n} rounds: Auto ${tally.auto}, Hottest ${tally.hot}, Repeat ${tally.rep}, Pattern ${tally.pat}, Always 11 ${tally.p11}. Over all your rounds see "Predicted vs real result" below.` : '';
    $('vsRows').innerHTML = rows.join('') || '<tr><td colspan="12">Waiting for rounds.</td></tr>';
  }

  // ---------------------------------------------------------------- drawing
  function render() {
    const c = S.capture;
    const pill = $('statusPill');
    pill.textContent = {stopped: 'Stopped', starting: 'Opening…', waiting: 'Waiting for the game', live: 'Live', stale: 'No new rounds – check the game', error: 'Error'}[c.status] || c.status;
    pill.className = 'pill ' + (c.status === 'live' ? 'live' : c.status === 'error' ? 'error' : c.status === 'stale' ? 'stale' : '');
    staleWarning(c);
    $('note').textContent = c.note || '';
    if ((firstState || c.gameUrl) && S.url && document.activeElement !== $('url')) $('url').value = S.url;
    firstState = false;
    $('roundId').textContent = c.round || '–';
    $('gameBal').textContent = c.balance != null ? money(c.balance) : '–';
    $('side').textContent = S.settings && S.settings.newestSide !== 'auto' ? S.settings.newestSide + ' (set)' : c.side ? c.side + ' (found)' : 'not known yet';
    $('start').disabled = ['starting', 'waiting', 'live', 'stale'].includes(c.status);
    $('stop').disabled = c.status === 'stopped';
    preview(['waiting', 'live', 'stale'].includes(c.status));
    renderTimer(c);
    renderOverlay();
    renderBalance(c);
    renderVs();
    renderPractice();
    renderLab();
    renderAutoClick();

    if (!S.configured && !settingsOpenedOnce) { settingsOpenedOnce = true; openSettings(); }
    const st = S.settings;
    $('limits').innerHTML = st ? [
      ['Budget', money(st.budget)], ['Stop-loss', money(st.lossLimit)],
      ['Profit target', st.profitTarget ? money(st.profitTarget) : 'none'],
      ['Time limit', st.timeLimitMin ? st.timeLimitMin + ' min' : 'none'],
      ['Alarm sound', st.alarmSound ? 'on' : 'off'],
      ['Auto-reconnect', st.autoReconnect !== false ? `on${S.capture.reconnects ? ` · ${S.capture.reconnects} since capture started` : ''}` : 'off'],
      ['Auto-click in game', st.autoClick ? `on (${st.autoClickNumber === 'auto' ? 'Auto' : 'P' + st.autoClickNumber} @ ₹${st.autoClickAmount})` : 'off'],
    ].map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('') : '<span>Not set yet</span><span><button onclick="document.getElementById(\'openSettings\').click()">Set limits</button></span>';

    // Session
    const ses = S.session && S.session.active ? S.session : null;
    $('noSession').classList.toggle('hidden', !!ses);
    $('inSession').classList.toggle('hidden', !ses);
    // The balance comes from the game. Typing it in is only offered when it can't be read.
    const liveBal = c.balance != null && c.balance > 0 && ['live', 'stale'].includes(c.status);
    $('liveStart').classList.toggle('hidden', !liveBal);
    $('liveStartV').textContent = liveBal ? money(c.balance) : '–';
    $('startBalWrap').classList.toggle('hidden', liveBal);
    $('manualBalRow').classList.toggle('hidden', liveBal);
    if (ses) {
      const s2 = ses.status || {};
      const net = s2.net;
      $('net').textContent = net == null ? '–' : (net > 0 ? '+' : '') + money(net);
      $('net').className = 'big ' + (net > 0 ? 'pos' : net < 0 ? 'neg' : '');
      $('lossBar').style.width = Math.min(100, (s2.lossUsed || 0) * 100) + '%';
      $('lossLbl').textContent = `${money(Math.max(0, -(net || 0)))} of ${money(st.lossLimit)}`;
      $('targetBar').style.width = Math.min(100, (s2.targetDone || 0) * 100) + '%';
      $('targetLbl').textContent = st.profitTarget ? `${money(Math.max(0, net || 0))} of ${money(st.profitTarget)}` : 'none';
      const mins = s2.minutes || 0;
      $('timeBar').style.width = st.timeLimitMin ? Math.min(100, mins / st.timeLimitMin * 100) + '%' : '0%';
      $('timeLbl').textContent = `${Math.floor(mins)} min${st.timeLimitMin ? ' of ' + st.timeLimitMin : ''}`;
      $('sStart').textContent = money(ses.startBalance);
      $('sBal').textContent = money(ses.balance) + (ses.balanceFrom === 'typed' ? ' (typed)' : '');
      $('sRounds').textContent = S.sessionRounds;
    }
    alarm(S.session);

    // Results
    const values = S.values, gapSet = new Set(S.gaps);
    $('total').textContent = `(${S.total.toLocaleString()} total)`;
    const shown = [];
    for (let i = values.length - 1; i >= 0 && shown.length < 60; i--) shown.push(`<span class="ball${gapSet.has(i) ? ' gap' : ''}" data-n="${values[i]}">${values[i]}</span>`);
    $('strip').innerHTML = shown.join('') || '<span class="muted">No results captured yet.</span>';

    // Live pick check: the highest-chance player, scored against each round since capture started.
    const win = S.odds.win, odd = S.odds.odd;
    const best = V32.PLAYERS.reduce((a, b) => win[b] > win[a] ? b : a);
    $('lcNext').textContent = `Player ${best}`;
    $('lcNextP').textContent = `${pct(win[best])} true chance · fair odds ${(1 / win[best]).toFixed(2)}`;
        const lastN = values.at(-1);
    if (lastN != null) {
      $('lcLast').textContent = `Player ${lastN} won`;
      $('lcLastRes').innerHTML = lastN === best ? '<span class="hit">Pick hit</span>' : `<span class="miss">Pick missed</span> (Player ${lastN} had a ${pct(win[lastN])} chance)`;
    }
    const live = S.liveValues || [];
    if (live.length) {
      const hits = live.filter(v => v === best).length;
      $('lcRate').textContent = pct(hits / live.length);
      $('lcRateSub').textContent = `${hits} of ${live.length} rounds · true chance ${pct(win[best])}`;
    } else { $('lcRate').textContent = '–'; $('lcRateSub').textContent = 'Waiting for the first finished round.'; }
    if (S.total !== lastTotal) {
      if (lastTotal != null) { const c = $('liveCheck'); c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop'); }
      lastTotal = S.total;
    }

    // Analysis
    $('sims').textContent = (S.odds.deals || S.odds.rounds).toLocaleString();
    renderWays();
    $('oddsT').innerHTML = V32.PLAYERS.map(p => `<tr><td>Player ${p}</td><td>${pct(win[p])}</td><td>${(1 / win[p]).toFixed(2)}</td><td>${pct(odd[p])}</td></tr>`).join('');
    const cnt = V32.counts(values), n = values.length, runs = V32.longestStreaks(values);
    $('obsT').innerHTML = V32.PLAYERS.map(p => `<tr><td>Player ${p}</td><td>${cnt[p]}</td><td>${n ? pct(cnt[p] / n) : '–'}</td><td>${pct(win[p])}</td><td>${runs[p]}</td></tr>`).join('');
    const f = V32.fairness(values, win);
    $('fair').textContent = f.chi == null ? `Fairness check needs at least 50 results (${n} so far).`
      : `Chi-square ${f.chi.toFixed(2)} on ${n} results. ${f.unusual ? 'Unusual at the 5% level: capture a few hundred more before reading anything into it, and check for gaps.' : 'Consistent with a fair random game: the differences are normal noise.'}`;
    renderCharts();
    $('pastT').innerHTML = S.pastSessions.length ? S.pastSessions.map(p => `<tr><td>${new Date(p.startedAt).toLocaleString()}</td><td>${p.rounds}</td><td class="${p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : ''}">${p.net == null ? '–' : money(p.net)}</td><td>${esc(String(p.reason).replace('limit: ', ''))}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">No finished sessions yet.</td></tr>';
  }

  // ---------------------------------------------------------------- charts
  const signed = v => (v > 0 ? '+' : '') + money(v);
  const shortMoney = v => (v < 0 ? '−' : '') + '₹' + Math.abs(v).toLocaleString('en-IN', {maximumFractionDigits: 0});
  const clock = t => new Date(t).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  let chartKey = '';
  function renderCharts() {
    const ses = S.session && S.session.active ? S.session : null;
    const key = [S.total, ses && ses.balances && ses.balances.length, ses && ses.startedAt, S.pastSessions.length, innerWidth, S.settings && S.settings.lossLimit, S.settings && S.settings.profitTarget].join('|');
    if (key === chartKey) return; // Only redraw when something changed.
    chartKey = key;
    const st = S.settings || {};

    // Win / loss this session: net over time (steps), with the limits as dashed lines.
    const bal = ses && ses.balances ? ses.balances : [];
    const netPts = bal.map(p => ({x: p.t, y: p.b - ses.startBalance}));
    if (netPts.length === 1) netPts.push({x: Date.now(), y: netPts[0].y});
    const refs = [];
    if (st.lossLimit) refs.push({y: -st.lossLimit, label: `Stop-loss ${shortMoney(-st.lossLimit)}`, cls: 'loss'});
    if (st.profitTarget) refs.push({y: st.profitTarget, label: `Target ${signed(st.profitTarget).replace('.00', '')}`, cls: 'win'});
    Viz.line($('chNet'), {points: ses ? netPts : [], step: true, refs, includeZero: true, yFmt: shortMoney, xFmt: clock,
      emptyText: 'Start a session to chart your wins and losses.',
      tipFor: i => [[signed(netPts[i].y), 'net'], [money(bal[Math.min(i, bal.length - 1)].b), 'balance'], [clock(netPts[i].x), '']]});
    const steps = [];
    for (let i = 1; i < bal.length; i++) steps.push({t: bal[i].t, d: bal[i].b - bal[i - 1].b});
    const lastSteps = steps.slice(-60);
    Viz.bars($('chSteps'), {bars: lastSteps.map(s => ({value: s.d, label: clock(s.t), tip: [[signed(s.d), s.d >= 0 ? 'won' : 'lost'], [clock(s.t), '']]})),
      yFmt: shortMoney, height: 140, emptyText: ses ? 'Wins and losses appear here as your balance changes.' : 'Start a session to chart your wins and losses.'});

    // Trend: rolling win share per player, one small chart each on the same scale.
    const values = S.values.slice(-600), n = values.length;
    const w = n >= 120 ? 50 : n >= 40 ? 20 : 0;
    $('chTrendWin').textContent = w ? `(rolling, last ${w} rounds)` : '';
    const trend = $('chTrend');
    if (!w) {
      trend.replaceChildren(Object.assign(document.createElement('div'), {className: 'viz-empty', textContent: `Trends appear after 40 captured rounds (${n} so far).`}));
    } else {
      // Built once and then redrawn in place, so the page doesn't jump while you scroll.
      if (trend.querySelectorAll('.tplot').length !== 4) {
        trend.replaceChildren(...V32.PLAYERS.map(p => {
          const box = document.createElement('div');
          const h = document.createElement('h3');
          const dot = document.createElement('i'); dot.style.background = PLAYER_COLOR[p];
          h.append(dot, document.createTextNode(`Player ${p}`));
          const plot = document.createElement('div'); plot.className = 'tplot'; plot.style.minHeight = '120px';
          box.append(h, plot); return box;
        }));
      }
      const plots = trend.querySelectorAll('.tplot');
      const top = Math.max(0.7, ...V32.PLAYERS.map(p => S.odds.win[p] + 0.15));
      for (const [k, p] of V32.PLAYERS.entries()) {
        const plot = plots[k];
        const pts = [];
        let c = 0;
        for (let i = 0; i < n; i++) {
          if (values[i] === p) c++;
          if (i >= w && values[i - w] === p) c--;
          if (i >= w - 1) pts.push({x: S.total - n + i + 1, y: c / w});
        }
        Viz.line(plot, {points: pts, color: PLAYER_COLOR[p], height: 120, yMin: 0, yMax: top,
          refs: [{y: S.odds.win[p], label: `true ${pct(S.odds.win[p])}`}],
          yFmt: v => Math.round(v * 100) + '%', xFmt: v => `#${v}`,
          tipFor: i => [[pct(pts[i].y), `of the last ${w}`], [`true ${pct(S.odds.win[p])}`, ''], [`round #${pts[i].x}`, '']]});
      }
    }

    // Wins by player: captured share vs true chance.
    const cnt = V32.counts(S.values), all = S.values.length;
    Viz.bars($('chPlayers'), {bars: all ? V32.PLAYERS.map(p => ({value: cnt[p] / all, expected: S.odds.win[p], label: `P${p}`, color: PLAYER_COLOR[p],
      tip: [[pct(cnt[p] / all), `captured (${cnt[p]} wins)`], [pct(S.odds.win[p]), 'true chance'], [`Player ${p}`, '']]})) : [],
      showLabels: true, yFmt: v => Math.round(v * 100) + '%', emptyText: 'No results captured yet.'});

    // Session results: net of each finished session, oldest to newest.
    const past = S.pastSessions.filter(p => p.net != null).slice().reverse();
    Viz.bars($('chSessions'), {bars: past.map(p => ({value: p.net, label: new Date(p.startedAt).toLocaleDateString(),
      tip: [[signed(p.net), 'net'], [`${p.rounds} rounds`, ''], [new Date(p.startedAt).toLocaleString(), '']]})),
      yFmt: shortMoney, emptyText: 'Finished sessions appear here.'});
  }
  window.addEventListener('resize', () => { if (S) { chartKey = ''; renderCharts(); } });

  // ---------------------------------------------------------------- live updates
  function connect() {
    const es = new EventSource('/events');
    es.onmessage = e => { S = JSON.parse(e.data); render(); };
    es.onerror = () => { $('statusPill').textContent = 'Monitor offline'; $('statusPill').className = 'pill error'; };
  }
  connect();
  // Keeps the session clock moving between updates.
  setInterval(async () => { if (S && S.session && S.session.active) { S = await (await fetch('/api/state')).json(); render(); } }, 15000);
})();
