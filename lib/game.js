// V-32 Cards: rules, true odds, result matching and history checks.
// Used by the server (Node) and by the dashboard (browser, as window.V32).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.V32 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PLAYERS = [8, 9, 10, 11];
  // 32 cards: 6, 7, 8, 9, 10, J (11), Q (12), K (13) in four suits.
  const DECK = [];
  for (let v = 6; v <= 13; v++) for (let s = 0; s < 4; s++) DECK.push(v);

  // Plays n fair rounds. Each player adds a card to their starting number; the highest total
  // wins and tied players draw again. Returns each player's win chance and the chance that
  // their total after the first card is odd.
  function simulate(n = 400000, rand = Math.random) {
    const wins = [0, 0, 0, 0], odd = [0, 0, 0, 0];
    const d = DECK.slice();
    for (let r = 0; r < n; r++) {
      let top = d.length;
      const draw = () => { const j = Math.floor(rand() * top); top--; const t = d[j]; d[j] = d[top]; d[top] = t; return t; };
      const total = PLAYERS.slice();
      let alive = [0, 1, 2, 3], first = true;
      while (alive.length > 1 && top >= alive.length) {
        for (const i of alive) total[i] += draw();
        if (first) { for (let i = 0; i < 4; i++) if (total[i] % 2) odd[i]++; first = false; }
        let best = -1;
        for (const i of alive) if (total[i] > best) best = total[i];
        alive = alive.filter(i => total[i] === best);
      }
      wins[alive[Math.floor(rand() * alive.length)]]++;
    }
    const win = {}, oddChance = {};
    PLAYERS.forEach((p, i) => { win[p] = wins[i] / n; oddChance[p] = odd[i] / n; });
    return {win, odd: oddChance, rounds: n};
  }

  // Exact chances, counting every possible first deal of the 32 cards (32 x 31 x 30 x 29 =
  // 863,040 deals). known = {8: 13, 11: 6, ...} fixes the card some players already have.
  // Tied leaders draw again from the same deck, so each tied player wins 1 in k of those deals.
  // Returns win chances, how many deals each player wins outright, how many end in a tie
  // (by size), and each player's chance with every card they could get.
  const CARD_NAMES = {6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K'};
  function exact(known = {}) {
    const left = {};
    for (let v = 6; v <= 13; v++) left[v] = 4;
    const fixed = PLAYERS.map(p => (known[p] >= 6 && known[p] <= 13 ? Number(known[p]) : null));
    for (const v of fixed) if (v != null) { if (!left[v]) return null; left[v]--; }
    const share = [0, 0, 0, 0], outright = [0, 0, 0, 0], ties = {2: 0, 3: 0, 4: 0};
    const byCard = PLAYERS.map(() => { const o = {}; for (let v = 6; v <= 13; v++) o[v] = {deals: 0, share: 0}; return o; });
    let deals = 0;
    const cards = [0, 0, 0, 0];
    (function deal(i, weight) {
      if (i === 4) {
        let best = -1;
        for (let j = 0; j < 4; j++) best = Math.max(best, PLAYERS[j] + cards[j]);
        const lead = [0, 1, 2, 3].filter(j => PLAYERS[j] + cards[j] === best);
        deals += weight;
        if (lead.length === 1) outright[lead[0]] += weight; else ties[lead.length] += weight;
        for (const j of lead) share[j] += weight / lead.length;
        for (let j = 0; j < 4; j++) {
          const c = byCard[j][cards[j]];
          c.deals += weight;
          if (lead.includes(j)) c.share += weight / lead.length;
        }
        return;
      }
      if (fixed[i] != null) { cards[i] = fixed[i]; return deal(i + 1, weight); }
      for (let v = 6; v <= 13; v++) {
        if (!left[v]) continue;
        const n = left[v]; left[v]--; cards[i] = v;
        deal(i + 1, weight * n);
        left[v]++;
      }
    })(0, 1);
    const win = {}, wins = {}, cardChance = {};
    PLAYERS.forEach((p, j) => {
      win[p] = share[j] / deals; wins[p] = outright[j];
      cardChance[p] = {};
      for (let v = 6; v <= 13; v++) {
        const c = byCard[j][v];
        if (c.deals) cardChance[p][v] = {chance: c.share / c.deals, total: p + v, deals: c.deals};
      }
    });
    return {win, outright: wins, ties, deals, cardChance};
  }

  const isPlayer = v => PLAYERS.includes(v);

  // The site's "Last Result" row as the page shows it, turned newest-first.
  function newestFirst(strip, side) {
    return side === 'right' ? strip.slice().reverse() : strip.slice();
  }

  // How many new results moved into a newest-first row between two readings: the smallest k
  // where the old row, pushed along by k, lines up with the new one over at least minOverlap
  // results. 0 = unchanged, -1 = they don't line up (many rounds missed, or the wrong side).
  function shiftBetween(prev, next, minOverlap = 5) {
    if (!prev.length || !next.length) return -1;
    for (let k = 0; k < next.length; k++) {
      const overlap = Math.min(prev.length, next.length - k);
      if (overlap < Math.min(minOverlap, prev.length, next.length)) break;
      let same = true;
      for (let i = 0; i < overlap; i++) if (next[k + i] !== prev[i]) { same = false; break; }
      if (same) return k;
    }
    return -1;
  }

  // Compares two readings of the row (as shown on the page). side: 'left' | 'right' | 'auto'.
  // Returns the new results oldest first, whether rounds were probably missed, and which side
  // the newest result is on when that could be told.
  function newResults(prevStrip, nextStrip, side = 'auto', fallbackSide = 'right') {
    if (!prevStrip || !prevStrip.length) return {added: [], gap: false, side: null, first: true};
    const sides = side === 'auto' ? ['left', 'right'] : [side];
    const tried = sides.map(s => ({s, k: shiftBetween(newestFirst(prevStrip, s), newestFirst(nextStrip, s))}));
    const valid = tried.filter(t => t.k >= 0);
    if (valid.some(t => t.k === 0)) return {added: [], gap: false, side: null};
    let pick, decided = null;
    if (valid.length === 1) { pick = valid[0]; decided = side === 'auto' ? pick.s : null; }
    else if (valid.length === 2) {
      if (valid[0].k !== valid[1].k) { pick = valid[0].k < valid[1].k ? valid[0] : valid[1]; decided = pick.s; }
      else pick = valid.find(t => t.s === fallbackSide) || valid[0];
    }
    if (!pick) {
      // Nothing lines up: more rounds passed than the row holds. Keep the whole row, flagged.
      const s = side === 'auto' ? fallbackSide : side;
      return {added: newestFirst(nextStrip, s).reverse(), gap: true, side: null};
    }
    return {added: newestFirst(nextStrip, pick.s).slice(0, pick.k).reverse(), gap: false, side: decided};
  }

  // First reading after capture (re)starts. saved = the stored rounds, oldest first. Finds the
  // rounds that finished since the last stored one; demands a long overlap (8) because a short
  // run of four possible values lines up by chance too easily. gap = true when it can't tell.
  function resumeResults(saved, nextStrip, side = 'auto', fallbackSide = 'right') {
    if (!saved.length) return {added: [], gap: false, side: null};
    if (saved.length < 8 || nextStrip.length < 8) return {added: [], gap: true, side: null}; // Too short to line up safely.
    const prev = saved.slice().reverse();
    const sides = side === 'auto' ? ['left', 'right'] : [side];
    const tried = sides.map(s => ({s, k: shiftBetween(prev, newestFirst(nextStrip, s), 8)})).filter(t => t.k >= 0);
    if (!tried.length) return {added: [], gap: true, side: null};
    let pick = tried[0];
    if (tried.length === 2) pick = tried[0].k === tried[1].k ? tried.find(t => t.s === fallbackSide) : (tried[0].k < tried[1].k ? tried[0] : tried[1]);
    return {added: newestFirst(nextStrip, pick.s).slice(0, pick.k).reverse(), gap: false, side: null};
  }

  function counts(values) {
    const c = {8: 0, 9: 0, 10: 0, 11: 0};
    for (const v of values) if (v in c) c[v]++;
    return c;
  }

  // Chi-square of observed wins against the true chances (3 degrees of freedom; 7.81 is the
  // 5% line). Needs about 50 rounds to mean anything.
  function fairness(values, win) {
    const n = values.length, c = counts(values);
    if (n < 50) return {n, chi: null, unusual: null};
    const chi = PLAYERS.reduce((s, p) => s + (c[p] - n * win[p]) ** 2 / (n * win[p]), 0);
    return {n, chi, unusual: chi >= 7.81};
  }

  // Picks the player seen most (or least) in h; ties go to the higher true chance.
  const most = h => { const c = counts(h); return PLAYERS.reduce((a, b) => c[b] >= c[a] ? b : a); };
  const least = h => { const c = counts(h); return PLAYERS.reduce((a, b) => c[b] < c[a] ? b : a); };
  // What most often came right after the last k results, earlier in the history.
  function afterPattern(h, k) {
    const n = h.length;
    if (n <= k) return 11;
    const c = {8: 0, 9: 0, 10: 0, 11: 0};
    let found = false;
    for (let i = k; i < n; i++) {
      let same = true;
      for (let j = 1; j <= k; j++) if (h[i - j] !== h[n - j]) { same = false; break; }
      if (same) { c[h[i]]++; found = true; }
    }
    return found ? PLAYERS.reduce((a, b) => c[b] >= c[a] ? b : a) : 11;
  }
  // Every common way of "predicting" from past results. Each picks one player before a round.
  const SYSTEMS = {
    'Always Player 11': () => 11,
    'Always Player 10': () => 10,
    'Always Player 9': () => 9,
    'Always Player 8': () => 8,
    'Repeat last winner': h => h[h.length - 1],
    'Hottest in last 20': h => { const c = counts(h.slice(-20)); return PLAYERS.reduce((a, b) => c[b] >= c[a] ? b : a); },
    'Coldest in last 20 ("due")': h => { const c = counts(h.slice(-20)); return PLAYERS.reduce((a, b) => c[b] < c[a] ? b : a); },
    'Hottest in last 10': h => most(h.slice(-10)),
    'Most wins overall': h => most(h),
    'Fewest wins overall ("due")': h => least(h),
    'Same as 2 rounds ago': h => (h.length >= 2 ? h[h.length - 2] : 11),
    'Switch from last winner (best other)': h => (h[h.length - 1] === 11 ? 10 : 11),
    'Pattern: after the last result': h => afterPattern(h, 1),
    'Pattern: after the last 2 results': h => afterPattern(h, 2),
    'Pattern: after the last 3 results': h => afterPattern(h, 3),
  };

  // Replays each "system" over the history: it picks before every round using only earlier
  // rounds. chance = what its picks should hit if results are random.
  // odds (optional) = the site's Back odds per player: net is the profit from betting 1 on every
  // pick (a win pays odds - 1, a loss costs 1), and fairNet what the same bets average at true chance.
  function backtest(values, win, odds) {
    return Object.entries(SYSTEMS).map(([name, pick]) => {
      let hits = 0, picks = 0, chance = 0, net = 0, fairNet = 0;
      for (let k = 1; k < values.length; k++) {
        const g = pick(values.slice(0, k));
        picks++; chance += win[g];
        if (g === values[k]) hits++;
        if (odds) { net += g === values[k] ? odds[g] - 1 : -1; fairNet += win[g] * odds[g] - 1; }
      }
      const r = {name, picks, hits, hitRate: picks ? hits / picks : null, chance: picks ? chance / picks : null};
      if (odds) { r.net = net; r.fairNet = fairNet; }
      return r;
    });
  }

  function longestStreaks(values) {
    const best = {8: 0, 9: 0, 10: 0, 11: 0};
    let run = 0;
    for (let i = 0; i < values.length; i++) {
      run = i && values[i] === values[i - 1] ? run + 1 : 1;
      if (run > best[values[i]]) best[values[i]] = run;
    }
    return best;
  }

  // ---------------------------------------------------------------- practice autoplay
  // Pretend bets only: nothing is ever sent to the game. Each round the chosen method picks a
  // player from earlier rounds, a stake is "placed" at the Back odds read from the table at that
  // moment, and the real result settles it. No odds read = the bet is void.

  // Auto: before each round, use whichever method has the best win rate over the last 200
  // captured rounds (each scored only on rounds before it). Under 30 rounds, or on a tie, the
  // method with the highest true chance (Always Player 11) is used.
  const AUTO = 'Auto: best method on your rounds so far';
  function autoChoose(history, window = 200) {
    const h = history.slice(-(window + 1));
    if (h.length < 31) return {method: 'Always Player 11', hitRate: null, rounds: h.length - 1};
    let best = null;
    for (const [name, pick] of Object.entries(SYSTEMS)) {
      let hits = 0;
      for (let k = 1; k < h.length; k++) if (pick(history.slice(0, history.length - h.length + k)) === h[k]) hits++;
      const rate = hits / (h.length - 1);
      if (!best || rate > best.hitRate + 1e-12) best = {method: name, hitRate: rate, rounds: h.length - 1};
    }
    return best;
  }
  const pickFor = (method, history) => {
    if (method !== AUTO) return {pick: SYSTEMS[method](history), chosen: null};
    const c = autoChoose(history);
    return {pick: SYSTEMS[c.method](history), chosen: c};
  };

  function checkPractice(input) {
    const num = (v, d = 0) => (v === '' || v == null ? d : Number(v));
    const p = {
      method: String(input.method || AUTO),
      stake: num(input.stake), startBalance: num(input.startBalance),
      stopLoss: num(input.stopLoss), target: num(input.target), maxRounds: Math.floor(num(input.maxRounds)),
      progression: input.progression === 'double' ? 'double' : 'flat',
    };
    if (!SYSTEMS[p.method] && p.method !== AUTO) return {ok: false, error: 'Choose a prediction method.'};
    if (!(p.startBalance > 0)) return {ok: false, error: 'Enter a pretend starting balance above 0.'};
    if (!(p.stake > 0) || p.stake > p.startBalance) return {ok: false, error: 'The stake must be above 0 and no more than the starting balance.'};
    for (const k of ['stopLoss', 'target', 'maxRounds']) if (!(p[k] >= 0)) return {ok: false, error: 'Stop-loss, target and round limit must be 0 or more.'};
    if (p.stopLoss > p.startBalance) return {ok: false, error: 'The stop-loss can be no more than the starting balance.'};
    if (p.stopLoss > 0 && p.stake > p.stopLoss) return {ok: false, error: `The stake (₹${p.stake}) is more than the stop-loss (₹${p.stopLoss}), so one lost round would end autoplay. Lower the stake or raise the stop-loss.`};
    return {ok: true, practice: p};
  }

  function newPractice(p, history, now = Date.now(), odds = null) {
    const run = {...p, active: true, startedAt: now, balance: p.startBalance, nextStake: p.stake,
      rounds: 0, wins: 0, staked: 0, peak: p.startBalance, low: p.startBalance, bets: [], curve: [{i: 0, b: p.startBalance}], stopped: null};
    const f = pickFor(p.method, history);
    run.nextPick = f.pick; run.nextChosen = f.chosen;
    run.nextOdds = odds && odds[run.nextPick] > 1 ? odds[run.nextPick] : null;
    return run;
  }

  // Settles the pending pretend bet against the real result, then picks for the next round.
  // gap = rounds may have been missed before this result, so the bet is void (not settled).
  // odds = the table's Back odds now, used for the next pretend bet.
  function practiceStep(run, history, result, {gap = false, round = null, now = Date.now(), odds = null} = {}) {
    if (!run || !run.active) return run;
    const r = {...run, bets: run.bets.slice(-199), curve: run.curve.slice(-1999)};
    if (gap || !run.nextOdds) {
      r.bets.push({t: now, round, pick: run.nextPick, by: run.nextChosen && run.nextChosen.method, result, stake: 0, void: gap ? 'gap' : 'odds', balance: r.balance});
    } else {
      const stake = Math.min(run.nextStake, r.balance);
      const win = run.nextPick === result;
      const change = win ? stake * (run.nextOdds - 1) : -stake;
      r.balance = Math.round((r.balance + change) * 100) / 100;
      r.rounds++; r.staked += stake; if (win) r.wins++;
      r.peak = Math.max(r.peak, r.balance); r.low = Math.min(r.low, r.balance);
      r.bets.push({t: now, round, pick: run.nextPick, by: run.nextChosen && run.nextChosen.method, odds: run.nextOdds, result, stake, win, change: Math.round(change * 100) / 100, balance: r.balance});
      r.curve.push({i: r.rounds, b: r.balance});
      r.nextStake = r.progression === 'double' && !win ? stake * 2 : r.stake;
      const net = r.balance - r.startBalance;
      if (r.stopLoss > 0 && -net >= r.stopLoss) r.stopped = 'loss';
      else if (r.target > 0 && net >= r.target) r.stopped = 'target';
      else if (r.balance < Math.min(r.nextStake, r.stake) || r.balance <= 0) r.stopped = 'broke';
      else if (r.maxRounds > 0 && r.rounds >= r.maxRounds) r.stopped = 'rounds';
      if (r.stopped) { r.active = false; r.stoppedAt = now; }
    }
    const f = pickFor(r.method, history.concat(result));
    r.nextPick = f.pick; r.nextChosen = f.chosen;
    r.nextOdds = odds && odds[r.nextPick] > 1 ? odds[r.nextPick] : null;
    return r;
  }

  // Where a playing session stands against its limits. All amounts in the site's currency.
  function sessionStatus(settings, session, now = Date.now()) {
    if (!session || !session.active) return null;
    const net = session.balance != null && session.startBalance != null ? session.balance - session.startBalance : null;
    const minutes = (now - session.startedAt) / 60000;
    const lossUsed = net != null && settings.lossLimit > 0 ? Math.max(0, -net) / settings.lossLimit : 0;
    const targetDone = net != null && settings.profitTarget > 0 ? Math.max(0, net) / settings.profitTarget : 0;
    let reached = null;
    if (net != null && settings.lossLimit > 0 && -net >= settings.lossLimit) reached = 'loss';
    else if (net != null && settings.profitTarget > 0 && net >= settings.profitTarget) reached = 'target';
    else if (settings.timeLimitMin > 0 && minutes >= settings.timeLimitMin) reached = 'time';
    else if (session.balance != null && session.startBalance != null && settings.budget > 0 && session.startBalance - session.balance >= settings.budget) reached = 'loss';
    return {net, minutes, lossUsed, targetDone, reached};
  }

  // Checks the settings form. Returns {ok, settings} or {ok:false, error}.
  function checkSettings(input) {
    const num = v => (v === '' || v == null ? 0 : Number(v));
    const s = {
      budget: num(input.budget),
      lossLimit: num(input.lossLimit),
      profitTarget: num(input.profitTarget),
      timeLimitMin: num(input.timeLimitMin),
      newestSide: ['auto', 'left', 'right'].includes(input.newestSide) ? input.newestSide : 'auto',
      alarmSound: input.alarmSound !== false,
      autoReconnect: input.autoReconnect !== false,
      autoOpenGame: input.autoOpenGame !== false,
      autoClick: input.autoClick === true,
      autoClickNumber: ['auto', '8', '9', '10', '11', 8, 9, 10, 11].includes(input.autoClickNumber) ? String(input.autoClickNumber) : 'auto',
      autoClickAmount: input.autoClickAmount === 'auto' || input.autoClickAmount == null || input.autoClickAmount === '' ? 'auto' : (Number(input.autoClickAmount) > 0 ? Number(input.autoClickAmount) : 'auto'),
    };
    for (const k of ['budget', 'lossLimit', 'profitTarget', 'timeLimitMin']) {
      if (!Number.isFinite(s[k]) || s[k] < 0) return {ok: false, error: 'Amounts must be zero or more.'};
    }
    if (!(s.budget > 0)) return {ok: false, error: 'Enter your budget: the most money you are ready to spend this session.'};
    if (!(s.lossLimit > 0)) return {ok: false, error: 'Enter a stop-loss: how much you can lose before you stop.'};
    if (s.lossLimit > s.budget) return {ok: false, error: 'The stop-loss cannot be more than your budget.'};
    return {ok: true, settings: s};
  }

  return {PLAYERS, DECK, CARD_NAMES, SYSTEMS, AUTO, autoChoose, checkPractice, newPractice, practiceStep, exact, simulate, isPlayer, newestFirst, shiftBetween, newResults, resumeResults, counts, fairness, backtest, longestStreaks, sessionStatus, checkSettings};
});
