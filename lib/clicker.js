// Places a bet in the live V-32 Cards game: clicks the chosen player's Back odds on the table, types the
// stake into the bet slip that opens, and presses its Place Bet button.

/** Finds the frame that shows the V-32 table across all pages and frames. */
async function findGameFrame(page, preferredFrame = null) {
  const isTable = async f => {
    try {
      const text = await f.evaluate(() => (document.body ? document.body.innerText : ''));
      return /Player\s*(8|9|10|11)\b/i.test(text);
    } catch {
      return false;
    }
  };
  if (preferredFrame && !preferredFrame.isDetached() && await isTable(preferredFrame)) return preferredFrame;
  if (!page) return null;
  const pages = page.context ? page.context().pages() : [page];
  for (const p of pages) {
    for (const f of p.frames()) {
      if (!f.isDetached() && await isTable(f)) return f;
    }
  }
  return null;
}

/** Tries to close any blocking dialog (e.g. rules or previous bet slip). */
async function closePopups(frame) {
  try {
    await frame.page().keyboard.press('Escape').catch(() => {});
    await frame.evaluate(() => {
      const closeBtn = document.querySelector('[aria-label="close" i], .close-modal, .btn-close, .modal-close');
      if (closeBtn) closeBtn.click();
    }).catch(() => {});
  } catch {}
}

/** A short description of the live page around the table, for error messages. */
async function describePage(frame, p) {
  return frame.evaluate(p => {
    const txt = el => (el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const cls = el => (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
    const label = new RegExp(`^(?:Player\\s*${p}|P\\s*${p})$`, 'i');
    const otherPlayer = new RegExp(`Player\\s*(?!${p}\\b)(8|9|10|11)\\b`, 'i');
    const rows = [...document.querySelectorAll('body *')]
      .filter(el => label.test(txt(el)) && ![...el.children].some(c => label.test(txt(c))))
      .slice(0, 2).map(el => {
        let row = el;
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          if (otherPlayer.test(txt(a))) break;
          row = a;
          if (row.tagName === 'TR' || row.getAttribute('role') === 'row') break;
        }
        return `${el.tagName.toLowerCase()}${cls(el)} in row ${row.tagName.toLowerCase()}${cls(row)}: "${txt(row).slice(0, 80)}"`;
      });
    const inputs = [...document.querySelectorAll('input:not([type="hidden"])')].map(i => `<input ${i.name ? 'name="' + i.name + '" ' : ''}${i.placeholder ? 'placeholder="' + i.placeholder + '" ' : ''}value="${i.value}">`).slice(0, 4);
    const buttons = [...document.querySelectorAll('button, [role="button"], a.btn, .btn')].map(b => txt(b)).filter(Boolean).slice(0, 8);
    return [rows.length ? rows.join(' ; ') : `no "Player ${p}" text on the page`, `inputs: [${inputs.join(', ')}]`, `buttons: [${buttons.join(' | ')}]`].join(' ; ');
  }, p).catch(e => `page could not be read: ${e.message}`);
}

class ClickError extends Error {
  constructor(message, step) { super(message); this.step = step; }
}

/** Clicks the Back odds of Player {p} on the live table. Returns the odds clicked. */
async function clickNumber(frame, playerNumber, odds = null) {
  const p = Number(playerNumber);
  if (![8, 9, 10, 11].includes(p)) throw new ClickError(`Invalid player number: ${playerNumber}`, 'player');
  const want = odds && (odds.back ? odds.back[p] : odds[p]);

  await closePopups(frame);

  const found = await frame.evaluate(({p, want}) => {
    for (const el of document.querySelectorAll('[data-v32-click]')) el.removeAttribute('data-v32-click');
    const visible = el => {
      if (el.classList.contains('MuiBackdrop-root')) return false;
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 && r.width > 0 && r.height > 0;
    };
    const txt = el => (el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const label = new RegExp(`^(?:Player\\s*${p}|P\\s*${p})$`, 'i'), num = /^\d+(?:\.\d+)?$/;
    const otherPlayer = new RegExp(`Player\\s*(?!${p}\\b)(8|9|10|11)\\b`, 'i');

    const labels = [...document.querySelectorAll('body *')]
      .filter(el => label.test(txt(el)) && ![...el.children].some(c => label.test(txt(c))) && visible(el));
    if (!labels.length) return {error: `No "Player ${p}" row is visible in the game.`};

    // The row: the table row or container for Player {p}.
    let row = labels[0];
    for (let a = row.parentElement; a && a !== document.body; a = a.parentElement) {
      if (otherPlayer.test(txt(a))) break;
      row = a;
      if (row.tagName === 'TR' || row.getAttribute('role') === 'row' || /row/i.test(row.className || '')) break;
    }

    const inLabel = el => labels.some(l => l.contains(el) || l === el);
    const cells = [...row.querySelectorAll('*')]
      .filter(el => num.test(txt(el)) && !inLabel(el) && ![...el.children].some(c => num.test(txt(c))) && visible(el));

    if (!cells.length) {
      const isSuspended = [...row.querySelectorAll('*')].some(el => {
        const text = txt(el).toUpperCase();
        return (text === 'SUSPENDED' || text === 'LOCKED') && visible(el);
      });
      return {closed: true, error: isSuspended ? `Betting is closed: Player ${p} is suspended.` : `Betting is closed: Player ${p} shows no odds.`};
    }

    // Match the captured Back odds when available. Never fall back to a different visible
    // number (for example Lay or Odd/Even) if that exact market is locked or has changed.
    const matched = want && cells.find(c => Math.abs(Number(txt(c)) - Number(want)) < 0.001);
    if (want && !matched) return {closed: true, error: `Betting is not open at the captured Back odds for Player ${p}.`};
    const pick = matched || cells[0];
    const target = pick.closest('button, [role="button"], td, a, [class*="odds" i], [class*="back" i]') || pick;

    if (target.disabled || target.getAttribute('aria-disabled') === 'true' || target.classList.contains('disabled')) {
      return {closed: true, error: `Betting is closed: Player ${p} odds are locked.`};
    }

    target.setAttribute('data-v32-click', '1');
    return {odds: Number(txt(pick))};
  }, {p, want}).catch(e => ({error: e.message}));

  if (found.error) throw new ClickError(found.error, found.closed ? 'closed' : 'player');
  const el = frame.locator('[data-v32-click="1"]').first();
  await el.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
  try {
    await el.click({ timeout: 2500 });
  } catch {
    try {
      await el.click({ timeout: 1000, force: true });
    } catch (e) {
      const clicked = await frame.evaluate(() => {
        const t = document.querySelector('[data-v32-click="1"]');
        if (t) {
          t.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, view: window}));
          t.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true, view: window}));
          t.click();
          return true;
        }
        return false;
      }).catch(() => false);
      if (!clicked) {
        throw new ClickError(`The Player ${p} odds (${found.odds}) could not be clicked: ${String(e.message).split('\n')[0]}`, 'player');
      }
    }
  }
  return { method: 'back-odds', odds: found.odds };
}

/** Types the stake into the bet slip that opened, or clicks matching chip button. */
async function setAmountOrInput(frame, amount) {
  const amt = Number(amount);
  if (!(amt > 0)) return false;
  const matchesAmount = async input => {
    const raw = await input.inputValue().catch(() => '');
    const value = Number(String(raw).replace(/[^\d.-]/g, ''));
    return Number.isFinite(value) && Math.abs(value - amt) < 0.005;
  };

  // 1. Try targeted stake input selectors anywhere in the frame
  const stakeSelectors = [
    '#stakeInput',
    'input[placeholder*="stake" i]',
    'input[placeholder*="amount" i]',
    'input.stake',
    'input.amount',
    'input[name*="stake" i]',
    'input[name*="amount" i]',
    'input[class*="stake" i]',
    'input[class*="amount" i]',
    '.betslip input',
    '.slip input',
    '[class*="betslip" i] input',
    '[class*="bet-slip" i] input',
    '[class*="place-bet" i] input',
    'input[type="number"]',
  ];

  for (const sel of stakeSelectors) {
    const input = frame.locator(sel).first();
    if (await input.count().catch(() => 0) && await input.isVisible().catch(() => false)
        && await input.isEditable().catch(() => false)) {
      try {
        await input.fill(String(amt), { timeout: 1000 });
        if (await matchesAmount(input)) return true;
      } catch {}
    }
  }

  // 2. Try chip button with matching amount (e.g. 20, +20, ₹20)
  const chipBtn = frame.locator('button, [role="button"], .chip, a').filter({
    hasText: new RegExp(`^\\s*\\+?(?:₹|rs\\.?)?\\s*${amt}\\s*$`, 'i')
  }).first();
  if (await chipBtn.count().catch(() => 0) && await chipBtn.isVisible().catch(() => false)) {
    try { await chipBtn.click({ timeout: 1000 }); return true; } catch {}
  }

  // 3. Try any visible non-search text/number input
  const inputs = frame.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="search"])');
  const n = await inputs.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false)) || !(await input.isEditable().catch(() => false))) continue;
    const ph = (await input.getAttribute('placeholder').catch(() => '')) || '';
    if (/search/i.test(ph)) continue;
    try {
      await input.fill(String(amt), { timeout: 1000 });
      if (await matchesAmount(input)) return true;
    } catch {}
  }

  return false;
}

/** Presses the slip's Place Bet / Confirm button. */
async function clickPlaceBetIfVisible(frame) {
  const btnSelectors = [
    '#placeBetBtn',
    'button:has-text("Place Bet")',
    'button:has-text("Place bet")',
    'button:has-text("Confirm")',
    'button:has-text("Submit")',
    'a:has-text("Place Bet")',
    'a:has-text("Confirm")',
    'a:has-text("Submit")',
    '.btn-place-bet',
    '.place-bet',
    '.btn-place',
    '[class*="placeBet" i]',
    '[class*="place-bet" i]',
  ];

  const isBetAction = async btn => {
    const label = (await btn.getAttribute('aria-label').catch(() => '')) || '';
    const text = ((await btn.innerText().catch(() => '')) || label).replace(/\s+/g, ' ').trim();
    return /^(?:place\s*bet|bet(?:\s*now)?|confirm(?:\s*bet)?|submit)$/i.test(text);
  };

  for (const sel of btnSelectors) {
    const btn = frame.locator(sel).first();
    if (await btn.count().catch(() => 0) && await btn.isVisible().catch(() => false)
        && !(await btn.isDisabled().catch(() => false)) && await isBetAction(btn)) {
      try {
        await btn.click({ timeout: 2000 });
        return true;
      } catch {
        // Do not force a bet through a blocking overlay or an uncertain UI state.
      }
    }
  }

  const buttons = frame.locator('button, [role="button"], a');
  const n = await buttons.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible().catch(() => false)) || await btn.isDisabled().catch(() => false)
        || !(await isBetAction(btn))) continue;
    try { await btn.click({ timeout: 2000 }); return true; } catch {}
  }
  return false;
}

/** Reads the visible My Bet receipt area, when the game exposes it as page text. */
async function readMyBetPanel(frame) {
  return frame.evaluate(() => {
    const norm = el => (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const candidates = [...document.body.querySelectorAll('body *')].filter(el => {
      const text = norm(el).toLowerCase();
      return text.includes('my bet') && text.includes('matched bet') && text.includes('odds') && text.includes('stake');
    });
    candidates.sort((a, b) => norm(a).length - norm(b).length);
    const panel = candidates[0];
    if (!panel) return null;
    const text = norm(panel);
    const payload = text
      .replace(/my\s*bet/ig, '')
      .replace(/matched\s*bet/ig, '')
      .replace(/\bodds?\b|\bstake\b/ig, '')
      .replace(/\bBal(?:ance)?\s*:?\s*(?:₹|Rs\.?|INR)?\s*[\d,]+(?:\.\d+)?/ig, '')
      .replace(/\s+/g, ' ').trim();
    return {text, payload};
  }).catch(() => null);
}

async function waitForBetReceipt(frame, before, amount) {
  for (let i = 0; i < 8; i++) {
    await frame.waitForTimeout(250);
    const after = await readMyBetPanel(frame);
    if (!after || !after.payload || (before && after.text === before.text)) continue;
    const values = [...after.payload.matchAll(/(?:₹|Rs\.?\s*|INR\s*)?([\d,]+(?:\.\d+)?)/ig)]
      .map(m => Number(m[1].replace(/,/g, ''))).filter(Number.isFinite);
    if (values.some(n => Math.abs(n - Number(amount)) < 0.005)) return after;
  }
  return null;
}

/** The full bet: player's Back odds → stake → Place Bet (with retry for bet slip animation). */
async function executeClick(frame, playerNumber, amount, { odds = null } = {}) {
  const p = Number(playerNumber);
  const amt = Number(amount);
  if (![8, 9, 10, 11].includes(p)) return { ok: false, error: `Invalid player number: ${playerNumber}. Must be 8, 9, 10, or 11.` };
  if (!(amt > 0)) return { ok: false, error: `Invalid amount: ${amount}. Enter the amount to bet.` };

  let detail;
  try {
    detail = await clickNumber(frame, p, odds);
  } catch (e) {
    const closed = e.step === 'closed';
    return { ok: false, closed, error: `Failed to click Player ${p}: ${e.message}`, player: p, amount: amt, seen: closed ? undefined : await describePage(frame, p) };
  }

  // Allow bet slip to open / animate, with multiple attempts
  let amountHandled = false;
  for (let t = 0; t < 5; t++) {
    await frame.waitForTimeout(300);
    try { amountHandled = await setAmountOrInput(frame, amt); } catch {}
    if (amountHandled) break;
  }

  if (!amountHandled) {
    const seen = await describePage(frame, p);
    return { ok: false, error: `Clicked Player ${p} at ${detail.odds}, but found no stake box to type ₹${amt} into.`, player: p, amount: amt, detail, seen };
  }

  // Snapshot the receipt panel before submitting. A successful browser click only proves that
  // the control was pressed; it does not prove the game accepted or matched the bet.
  const myBetBefore = await readMyBetPanel(frame);

  let placedBetClicked = false;
  for (let t = 0; t < 5; t++) {
    try { placedBetClicked = await clickPlaceBetIfVisible(frame); } catch {}
    if (placedBetClicked) break;
    await frame.waitForTimeout(250);
  }

  if (!placedBetClicked) {
    const seen = await describePage(frame, p);
    return { ok: false, error: `Typed ₹${amt} for Player ${p}, but found no Place Bet button to press, so no bet was placed.`, player: p, amount: amt, detail, seen };
  }

  const receipt = await waitForBetReceipt(frame, myBetBefore, amt);
  if (!receipt) {
    return {
      ok: false, attempted: true, unconfirmed: true, player: p, amount: amt, detail,
      error: `Clicked Place Bet for Player ${p} at ${detail.odds} with ₹${amt}, but My Bet did not confirm it. Check My Bet before trying again.`,
      seen: await describePage(frame, p),
    };
  }

  return { ok: true, verified: true, player: p, amount: amt, numberClicked: true, amountHandled, placedBetClicked, detail, receipt, error: null };
}

module.exports = { findGameFrame, closePopups, describePage, clickNumber, setAmountOrInput, clickPlaceBetIfVisible, readMyBetPanel, waitForBetReceipt, executeClick };
