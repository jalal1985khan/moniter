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

  function readTimer() {
    try {
      const candidates = document.querySelectorAll(
        '[class*="timer" i], [class*="clock" i], [class*="countdown" i], [class*="counter" i], [id*="timer" i], [id*="clock" i], .time, .sec'
      );
      for (const el of candidates) {
        if (!visible(el)) continue;
        if (el.children.length > 6) continue;
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const m = text.match(/^(?:0:)?([0-5]?\d)$/);
        // A lone digit whose parent holds more digits is one tile of a flip clock ("3" of "30"):
        // leave it to the tile reader below, which joins the tiles.
        if (m && text.length === 1 && el.parentElement
          && (el.parentElement.textContent || '').replace(/\D/g, '').length > 1) continue;
        if (m) {
          const val = Number(m[1]);
          if (val >= 0 && val <= 60) return val;
        }
      }

      // Some tables render the countdown as large blue number tiles without timer-related
      // names (for example, two adjacent tiles reading "2" and "7"). Use only prominent,
      // lower/right numeric displays so player labels, card totals, and odds aren't mistaken
      // for the clock.
      const rectOf = el => { try { return el.getBoundingClientRect(); } catch { return null; } };
      const blueTile = el => {
        for (let a = el, i = 0; a && i < 3; a = a.parentElement, i++) {
          const color = getComputedStyle(a).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
          if (color) {
            const [, r, g, b] = color.map(Number);
            if (b > r + 20 && b > g + 5) return true;
          }
        }
        return false;
      };
      // Flip-clock tables show one digit per tile ("3" | "0"), and a flip tile may hold the
      // digit more than once (top and bottom halves, plus the next digit while it flips).
      // Collect the digit pieces, merge the pieces of each tile, then join tiles that sit side
      // by side on one line into a single number.
      const pieces = [];
      for (const el of document.body.querySelectorAll('body *')) {
        if (el.children.length > 2) continue;
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, '').trim();
        if (!/^\d{1,2}$/.test(text)) continue;
        // Read only the innermost digit elements, not a wrapper around both halves or both tiles.
        if ([...el.children].some(c => /\d/.test(c.textContent || ''))) continue;
        const style = getComputedStyle(el), rect = rectOf(el);
        if (!rect || rect.width < 8 || rect.height < 14 || parseFloat(style.fontSize) < 20) continue;
        if (!visible(el) || Number(style.opacity) === 0) continue;
        if (el.closest('table, button, [class*="odds" i], [class*="history" i], [class*="result" i]')) continue;
        if (rect.right < innerWidth * 0.5 || rect.bottom < innerHeight * 0.2) continue;
        const blue = blueTile(el);
        if (!blue && !['absolute', 'fixed'].includes(style.position)) continue;
        pieces.push({text, rect, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, font: parseFloat(style.fontSize), blue});
      }
      // Pieces whose centres fall within one tile width of each other belong to the same tile.
      const tiles = [];
      for (const p of pieces) {
        const t = tiles.find(t => Math.abs(t.cx - p.cx) < Math.max(t.w, p.rect.width) * 0.45 && Math.abs(t.cy - p.cy) < Math.max(t.h, p.rect.height));
        if (t) { t.votes[p.text] = (t.votes[p.text] || 0) + 1; t.blue = t.blue || p.blue; }
        else tiles.push({cx: p.cx, cy: p.cy, w: p.rect.width, h: p.rect.height, font: p.font, blue: p.blue, votes: {[p.text]: 1}});
      }
      for (const t of tiles) t.text = Object.entries(t.votes).sort((a, b) => b[1] - a[1])[0][0];
      // Join neighbouring single-digit tiles on the same line, left to right.
      tiles.sort((a, b) => a.cx - b.cx);
      const groups = [];
      for (const t of tiles) {
        const g = groups.find(g => {
          const l = g.at(-1);
          return l.text.length === 1 && t.text.length === 1 && g.length < 2
            && Math.abs(l.cy - t.cy) < Math.max(l.h, t.h) * 0.5 && t.cx - l.cx < Math.max(l.w, t.w) * 2.5;
        });
        if (g) g.push(t); else groups.push([t]);
      }
      const nums = groups.map(g => ({
        value: Number(g.map(t => t.text).join('')),
        blue: g.some(t => t.blue), right: g.at(-1).cx, font: Math.max(...g.map(t => t.font)), digits: g.length,
      })).filter(n => n.value <= 60);
      if (nums.length) {
        nums.sort((a, b) => (b.blue - a.blue) || (b.digits - a.digits) || (b.font - a.font) || (b.right - a.right));
        return nums[0].value;
      }
    } catch {}
    return null;
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
    const roundTimer = readTimer();
    // The game's "Disconnection due to inactivity" dialog (reported so the monitor can reconnect).
    const disconnected = /Disconnection due to inactivity|You have been disconnected/i.test(text) && /\bReconnect\b/.test(text);
    const snap = {results, round, balance: Number.isFinite(balance) ? balance : null, odds, timer: roundTimer, disconnected};
    if (!snap.results && !snap.round && snap.balance == null && !odds && roundTimer == null && !disconnected) return;
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
