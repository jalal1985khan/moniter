// Runs inside every frame of the game window (the game often sits in an iframe from another
// site). Finds V-32's "Last Result" row, the Round ID and the balance, and reports them whenever
// they change, and whether the game is showing its "Disconnection due to inactivity" dialog.
// Reads the page only: it never clicks, types or changes anything itself.
(() => {
  if (window.__v32Capture) return;
  window.__v32Capture = true;

  const PLAYER = /^(8|9|10|11)$/;
  let strip = null, lastKey = '', timer = 0;

  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  // A results row: a container whose children are mostly single player numbers (8, 9, 10, 11).
  function rate(el) {
    const kids = el.children;
    if (kids.length < 5 || kids.length > 200) return 0;
    let hits = 0;
    for (const k of kids) if (PLAYER.test(k.textContent.trim())) hits++;
    return hits >= 5 && hits >= kids.length * 0.8 ? hits : 0;
  }
  // Closeness to a "Last Result" heading breaks ties with other number lists on the page.
  function nearHeading(el) {
    for (let a = el, i = 0; a && i < 4; a = a.parentElement, i++) {
      if (/last\s*results?/i.test(a.textContent.slice(0, 2000))) return true;
    }
    return false;
  }
  function findStrip() {
    let best = null, bestScore = 0;
    for (const el of document.body.querySelectorAll('body *')) {
      const r = rate(el);
      if (!r) continue;
      const score = r + (nearHeading(el) ? 1000 : 0);
      if (score > bestScore && visible(el)) { best = el; bestScore = score; }
    }
    return best;
  }
  function readStrip() {
    if (!(strip && strip.isConnected && rate(strip) && visible(strip))) strip = findStrip();
    if (!strip) return null;
    const out = [];
    for (const k of strip.children) {
      const t = k.textContent.trim();
      if (PLAYER.test(t) && visible(k)) out.push(Number(t));
    }
    return out.length >= 5 ? out : null;
  }

  // The table's odds, read from its text: "Player 8  12.2  13.7" rows. The first table on the page
  // is Back / Lay, the second Odd / Even. While betting is closed the cells show locks (no numbers),
  // and then nothing is reported, so the last odds read are kept.
  function readOdds(text) {
    const rows = [];
    const re = /Player\s*(8|9|10|11)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(text))) rows.push([Number(m[1]), Number(m[2]), Number(m[3])]);
    // Each player's first row belongs to the first table, the second row to the second table
    // (works whether the two tables are stacked or side by side).
    const nth = k => {
      const seen = {}, pick = {};
      for (const r of rows) { seen[r[0]] = (seen[r[0]] || 0) + 1; if (seen[r[0]] === k) pick[r[0]] = r; }
      const part = [8, 9, 10, 11].map(p => pick[p]);
      if (part.some(r => !r || !(r[1] > 1 && r[1] < 1000 && r[2] > 1 && r[2] < 1000))) return null;
      return {a: Object.fromEntries(part.map(r => [r[0], r[1]])), b: Object.fromEntries(part.map(r => [r[0], r[2]]))};
    };
    const first = nth(1), second = nth(2);
    if (!first) return null;
    // Odd / Even pays the same for everyone; Back / Lay never does. Tells the tables apart if only one shows.
    const flat = t => new Set(Object.values(t.a)).size === 1;
    if (flat(first)) return second ? null : {odd: first.a, even: first.b};
    const out = {back: first.a, lay: first.b};
    if (second && flat(second)) { out.odd = second.a; out.even = second.b; }
    return out;
  }

  function scan() {
    timer = 0;
    if (!document.body || typeof window.__v32Report !== 'function') return;
    const text = document.body.innerText || '';
    const round = (text.match(/(?:Round\s*(?:ID|#|No\.?)?|Event\s*ID)\s*:?\s*([A-Z0-9_-]{5,})/i) || [])[1] || null;
    const balMatch = text.match(/\bBal(?:ance)?\s*:?\s*(?:₹|Rs\.?|INR)?\s*(-?[\d,]+(?:\.\d+)?)/i);
    const balance = balMatch ? Number(balMatch[1].replace(/,/g, '')) : null;
    const results = readStrip();
    const odds = readOdds(text);
    // The game's "Disconnection due to inactivity" dialog (reported so the monitor can reconnect).
    const disconnected = /Disconnection due to inactivity|You have been disconnected/i.test(text) && /\bReconnect\b/.test(text);
    const snap = {results, round, balance: Number.isFinite(balance) ? balance : null, odds, disconnected};
    if (!snap.results && !snap.round && snap.balance == null && !odds && !disconnected) return;
    const key = JSON.stringify(snap);
    if (key === lastKey && !disconnected) return; // while disconnected, keep reporting so a retry happens
    lastKey = key;
    try { window.__v32Report(snap); } catch {}
  }
  const later = () => { if (!timer) timer = setTimeout(scan, 250); };

  const begin = () => {
    new MutationObserver(later).observe(document.documentElement, {subtree: true, childList: true, characterData: true});
    setInterval(scan, 1500);
    later();
  };
  if (document.documentElement) begin();
  else document.addEventListener('DOMContentLoaded', begin, {once: true});
})();
