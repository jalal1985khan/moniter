// Prediction models for V-32 Cards, trained only on rounds captured from the game, and scored walk-forward: each model predicts every
// round using only the rounds before it, then learns from the result. Used by the dashboard
// (window.V32Models) and the tests (Node).
//
// The "32-card math" model is the exact chance from counting every deal of the 32 cards. If the
// game is a fair shuffle it is the best possible predictor, so every learned model is scored
// against it: a learned model can only beat it if the real game is not dealing fairly.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./game'));
  else root.V32Models = factory(root.V32);
})(typeof self !== 'undefined' ? self : this, function (V32) {
  'use strict';

  const P = V32.PLAYERS; // [8, 9, 10, 11]
  const idx = {8: 0, 9: 1, 10: 2, 11: 3};

  const norm = v => { const s = v[0] + v[1] + v[2] + v[3]; return v.map(x => x / s); };

  // Each model: {name, about, predict() -> [p8, p9, p10, p11], learn(result)}.
  function makeModels(prior) {
    const pri = P.map(p => prior[p]);
    const counter = () => [0, 0, 0, 0];
    const smooth = (c, k) => { const n = c[0] + c[1] + c[2] + c[3]; return c.map((x, i) => (x + k * pri[i]) / (n + k)); };

    const exact = {name: '32-card math (exact)', about: 'Chance from counting all 863,040 deals. Never changes.', predict: () => pri, learn() {}};

    const freqC = counter();
    const freq = {name: 'Learned frequency', about: 'How often each player has won in all training rounds.', predict: () => smooth(freqC, 20), learn(r) { freqC[idx[r]]++; }};

    const win = [];
    const recent = {name: 'Recent form (last 20)', about: 'Share of the last 20 rounds, lightly pulled toward the 32-card math.', predict() { const c = counter(); for (const r of win) c[idx[r]]++; return smooth(c, 5); }, learn(r) { win.push(r); if (win.length > 20) win.shift(); }};

    const hist = [];
    const markov = k => {
      const table = new Map();
      return {
        name: `Sequence model (last ${k})`, about: `Learns what tends to follow each run of ${k} result${k > 1 ? 's' : ''}.`,
        predict() { if (hist.length < k) return pri; const c = table.get(hist.slice(-k).join()); return c ? smooth(c, 10) : pri; },
        learn(r) { if (hist.length >= k) { const key = hist.slice(-k).join(); let c = table.get(key); if (!c) table.set(key, c = counter()); c[idx[r]]++; } },
      };
    };
    const m1 = markov(1), m2 = markov(2), m3 = markov(3);

    // Streak model: does the last winner win again more (or less) often after a streak of length s?
    const streakT = new Map();
    const streakLen = () => { let s = 0; for (let i = hist.length - 1; i >= 0 && hist[i] === hist[hist.length - 1]; i--) s++; return Math.min(s, 4); };
    const streak = {
      name: 'Streak model', about: 'Learns how often a winner repeats after a run of 1, 2, 3 or 4+ wins.',
      predict() {
        if (!hist.length) return pri;
        const last = hist[hist.length - 1], key = last + ':' + streakLen(), c = streakT.get(key) || [0, 0];
        const base = pri[idx[last]], pRepeat = (c[0] + 10 * base) / (c[1] + 10);
        return P.map((p, i) => (p === last ? pRepeat : (1 - pRepeat) * pri[i] / (1 - base)));
      },
      learn(r) { if (!hist.length) return; const last = hist[hist.length - 1], key = last + ':' + streakLen(); let c = streakT.get(key); if (!c) streakT.set(key, c = [0, 0]); c[1]++; if (r === last) c[0]++; },
    };

    const learned = [freq, recent, m1, m2, m3, streak];
    const ensemble = {name: 'Ensemble (all learned models)', about: 'Average of every learned model above.', predict() { const s = [0, 0, 0, 0]; for (const m of learned) m.predict().forEach((x, i) => { s[i] += x; }); return norm(s); }, learn() {}};

    // hist is shared and must be updated after every model has learned the round.
    const all = [exact, ...learned, ensemble];
    return {all, push: r => hist.push(r)};
  }

  // Walk-forward training and scoring over the captured results (oldest first).
  // odds = the Back odds read from the table (null = not read yet: no money figures). For each model: hit rate of its top pick, log score (lower is
  // better), skill versus the 32-card math (paired, with a z-score), money from ₹1 on its top pick
  // every round, and "value bets" (only when the model thinks a bet pays more than it costs).
  function train(values, {prior, odds = null, warmup = 0} = {}) {
    const {all, push} = makeModels(prior);
    const st = all.map(() => ({n: 0, hits: 0, log: 0, net: 0, vBets: 0, vNet: 0, d: 0, d2: 0}));
    for (let t = 0; t < values.length; t++) {
      const r = values[t], scoring = t >= warmup;
      if (scoring) {
        const preds = all.map(m => m.predict());
        const exactHit = argmax(preds[0]) === idx[r] ? 1 : 0;
        preds.forEach((p, k) => {
          const s = st[k], pick = argmax(p), hit = pick === idx[r] ? 1 : 0;
          s.n++; s.hits += hit; s.log -= Math.log(Math.max(1e-9, p[idx[r]]));
          if (odds) s.net += hit ? odds[P[pick]] - 1 : -1;
          const diff = hit - exactHit; s.d += diff; s.d2 += diff * diff;
          // Value bet: the player with the best expected return, only if it's above break-even.
          let best = -1, bestEv = 1.0;
          if (odds) p.forEach((x, i) => { const ev = x * odds[P[i]]; if (ev > bestEv) { bestEv = ev; best = i; } });
          if (best >= 0) { s.vBets++; s.vNet += best === idx[r] ? odds[P[best]] - 1 : -1; }
        });
      }
      for (const m of all) m.learn(r);
      push(r);
    }
    const next = all.map(m => m.predict());
    return all.map((m, k) => {
      const s = st[k], mean = s.n ? s.d / s.n : 0;
      const sd = s.n > 1 ? Math.sqrt(Math.max(0, s.d2 / s.n - mean * mean) / s.n) : 0;
      return {
        name: m.name, about: m.about, rounds: s.n,
        hitRate: s.n ? s.hits / s.n : null, logScore: s.n ? s.log / s.n : null,
        vsExact: mean, z: sd > 0 ? mean / sd : 0,
        net: odds ? s.net : null, valueBets: odds ? s.vBets : null, valueNet: odds ? s.vNet : null,
        next: Object.fromEntries(P.map((p, i) => [p, next[k][i]])), nextPick: P[argmax(next[k])],
      };
    });
  }

  function argmax(v) { let b = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[b]) b = i; return b; }

  return {train};
});
