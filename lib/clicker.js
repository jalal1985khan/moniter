// Places a bet in the live V-32 Cards game: clicks the chosen player's Back odds on the table, types the
// stake into the bet slip that opens, and presses its Place Bet button.
//
// Everything is found on the live page by its structure and text (the "Player N" row and its odds,
// the slip's input and button). Nothing is assumed: when a step can't find its target, it stops and
// returns `seen`, a short description of what the real page showed, so the cause can be fixed.

// MUI pop-ups (the game's bet slip, rules, ...) cover the table with a backdrop that blocks clicks.
const POPUP = '.MuiModal-root:not(.MuiModal-hidden), .MuiPopover-root';

/** Finds the frame that shows the V-32 table. */
async function findGameFrame(page, preferredFrame = null) {
  const isTable = async f => {
    try { return /Player\s*(8|9|10|11)\b/i.test(await f.evaluate(() => (document.body ? document.body.innerText : ''))); } catch { return false; }
  };
  if (preferredFrame && !preferredFrame.isDetached() && await isTable(preferredFrame)) return preferredFrame;
  if (!page) return null;
  for (const f of page.frames()) if (!f.isDetached() && await isTable(f)) return f;
  return null;
}

/** The open pop-up (the newest one), marked in the page so it can be used as a locator. */
async function openPopup(frame) {
  const found = await frame.evaluate(sel => {
    for (const el of document.querySelectorAll('[data-v32-pop]')) el.removeAttribute('data-v32-pop');
    const shown = el => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    // MUI roots can be zero-sized: a pop-up counts as open if it or anything inside it takes up space.
    const pops = [...document.querySelectorAll(sel)].filter(m => getComputedStyle(m).display !== 'none' && (shown(m) || [...m.querySelectorAll('*')].some(shown)));
    if (!pops.length) return false;
    pops.at(-1).setAttribute('data-v32-pop', '1');
    return true;
  }, POPUP).catch(() => false);
  return found ? frame.locator('[data-v32-pop="1"]').first() : null;
}

/** Closes pop-ups left open (an old bet slip, rules, ...) so the table can be clicked. */
async function closePopups(frame) {
  for (let tries = 0; tries < 3; tries++) {
    const pop = await openPopup(frame);
    if (!pop) return true;
    await frame.page().keyboard.press('Escape').catch(() => {});
    await frame.waitForTimeout(300);
    if (!(await openPopup(frame))) return true;
    // Escape didn't close it: click its backdrop (outside the box), which MUI treats as "close".
    await pop.locator('.MuiBackdrop-root').first().click({ position: { x: 3, y: 3 }, timeout: 1000, force: true }).catch(() => {});
    await frame.waitForTimeout(300);
  }
  return !(await openPopup(frame));
}

/** A short description of the live page around the table and any pop-up, for error messages. */
async function describePage(frame, p) {
  return frame.evaluate(p => {
    const txt = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const cls = el => (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
    const label = new RegExp(`^Player\\s*${p}$`, 'i');
    const rows = [...document.querySelectorAll('body *')]
      .filter(el => label.test(txt(el)) && ![...el.children].some(c => label.test(txt(c))))
      .slice(0, 2).map(el => {
        let row = el;
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          if ((txt(a).match(/Player\s*(8|9|10|11)\b/gi) || []).length > 1) break;
          row = a;
        }
        return `${el.tagName.toLowerCase()}${cls(el)} in row ${row.tagName.toLowerCase()}${cls(row)}: "${txt(row).slice(0, 80)}"`;
      });
    const pops = [...document.querySelectorAll('.MuiModal-root, .MuiPopover-root')].map(m =>
      `pop-up ${cls(m)}${m.id ? '#' + m.id : ''}: "${txt(m).slice(0, 100)}" · inputs ${m.querySelectorAll('input').length}`
      + ` · buttons [${[...m.querySelectorAll('button, [role="button"]')].map(txt).filter(Boolean).slice(0, 8).join(' | ')}]`);
    return [rows.length ? rows.join(' ; ') : `no "Player ${p}" text on the page`, ...pops].join(' ; ');
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
  if (!(await closePopups(frame))) throw new ClickError('A pop-up in the game would not close, so the table cannot be clicked.', 'player');

  // The first "Player {p}" row is the Back / Lay table ("Player 11  2.08  2.2"); its first number is
  // the Back odds. The cell is marked in the page and then clicked as a real mouse click.
  const found = await frame.evaluate(({p, want}) => {
    for (const el of document.querySelectorAll('[data-v32-click]')) el.removeAttribute('data-v32-click');
    const visible = el => {
      // MUI marks the whole app aria-hidden while a pop-up is open, so only pop-ups themselves are skipped.
      if (el.closest('.MuiBackdrop-root, .MuiModal-root, .MuiPopover-root')) return false;
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 && r.width > 0 && r.height > 0;
    };
    const txt = el => (el.textContent || '').trim();
    const label = new RegExp(`^Player\\s*${p}$`, 'i'), anyPlayer = /Player\s*(8|9|10|11)\b/gi, num = /^\d+(?:\.\d+)?$/;
    const labels = [...document.querySelectorAll('body *')]
      .filter(el => label.test(txt(el)) && ![...el.children].some(c => label.test(txt(c))) && visible(el));
    if (!labels.length) return {error: `No "Player ${p}" row is visible in the game.`};
    // The row: the largest ancestor that still names only this one player.
    let row = labels[0];
    for (let a = row.parentElement; a && a !== document.body; a = a.parentElement) {
      if ((a.textContent.match(anyPlayer) || []).length > 1) break;
      row = a;
    }
    if ([...row.querySelectorAll('[class*="suspend" i], [class*="lock" i]')].some(visible)) return {closed: true, error: `Betting is closed: Player ${p} is suspended (locked).`};
    const cells = [...row.querySelectorAll('*')]
      .filter(el => num.test(txt(el)) && ![...el.children].some(c => num.test(txt(c))) && visible(el));
    if (!cells.length) return {closed: true, error: `Betting is closed: Player ${p} shows no odds.`};
    const pick = (want && cells.find(c => Number(txt(c)) === Number(want))) || cells[0];
    // Click the clickable box around the number if there is one, else the number itself.
    const target = pick.closest('button, [role="button"], td') || pick;
    target.setAttribute('data-v32-click', '1');
    return {odds: Number(txt(pick))};
  }, {p, want}).catch(e => ({error: e.message}));

  if (found.error) throw new ClickError(found.error, found.closed ? 'closed' : 'player');
  const el = frame.locator('[data-v32-click="1"]').first();
  await el.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
  try { await el.click({ timeout: 3000 }); } catch (e) {
    throw new ClickError(`The Player ${p} odds (${found.odds}) could not be clicked: ${String(e.message).split('\n')[0]}`, 'player');
  }
  return { method: 'back-odds', odds: found.odds };
}

/** Types the stake into the bet slip that opened (or the table's own stake box if there is no pop-up). */
async function setAmountOrInput(frame, amount) {
  const amt = Number(amount);
  if (!(amt > 0)) return false;
  const scope = (await openPopup(frame)) || frame.locator('body');
  const inputs = scope.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="search"])');
  const n = await inputs.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false)) || await input.isDisabled().catch(() => false)) continue;
    await input.click({ timeout: 1000 }).catch(() => {});
    await input.fill(String(amt), { timeout: 1000 });
    if (Number(await input.inputValue().catch(() => '')) === amt) return true;
  }
  return false;
}

/** Presses the slip's Place Bet / Confirm button. */
async function clickPlaceBetIfVisible(frame) {
  const scope = (await openPopup(frame)) || frame.locator('body');
  const btn = scope.locator('button, [role="button"]').filter({ hasText: /place\s*bet|confirm|submit|^\s*bet\s*$/i }).first();
  if (await btn.count().catch(() => 0) && await btn.isVisible().catch(() => false) && !(await btn.isDisabled().catch(() => false))) {
    await btn.click({ timeout: 2000 });
    return true;
  }
  return false;
}

/** The full bet: player's Back odds → stake → Place Bet. */
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

  await frame.waitForTimeout(300); // the bet slip opens after the odds click
  let amountHandled = false;
  try { amountHandled = await setAmountOrInput(frame, amt); } catch {}
  if (!amountHandled) {
    const seen = await describePage(frame, p);
    await closePopups(frame); // don't leave a half-filled slip open
    return { ok: false, error: `Clicked Player ${p} at ${detail.odds}, but found no stake box to type ₹${amt} into.`, player: p, amount: amt, detail, seen };
  }

  let placedBetClicked = false;
  try { placedBetClicked = await clickPlaceBetIfVisible(frame); } catch {}
  if (!placedBetClicked) {
    const seen = await describePage(frame, p);
    await closePopups(frame);
    return { ok: false, error: `Typed ₹${amt} for Player ${p}, but found no Place Bet button to press, so no bet was placed.`, player: p, amount: amt, detail, seen };
  }

  return { ok: true, player: p, amount: amt, numberClicked: true, amountHandled, placedBetClicked, detail, error: null };
}

module.exports = { findGameFrame, openPopup, closePopups, describePage, clickNumber, setAmountOrInput, clickPlaceBetIfVisible, executeClick };
