// Automates finding and clicking the number (Player 8, 9, 10, or 11) and amount
// (chip, stake input, and place bet button) in the V-32 Cards game window.

/**
 * Finds the game frame inside the page.
 */
async function findGameFrame(page, preferredFrame = null) {
  if (preferredFrame && !preferredFrame.isDetached()) {
    try {
      const text = await preferredFrame.evaluate(() => document.body ? document.body.innerText : '');
      if (/Player\s*(8|9|10|11)/i.test(text) || /Last\s*Result/i.test(text) || /Round\s*ID/i.test(text)) {
        return preferredFrame;
      }
    } catch {}
  }
  if (!page) return null;
  const frames = page.frames();
  for (const f of frames) {
    if (f.isDetached()) continue;
    try {
      const text = await f.evaluate(() => document.body ? document.body.innerText : '');
      if (/Player\s*(8|9|10|11)/i.test(text) || /Last\s*Result/i.test(text)) {
        return f;
      }
    } catch {}
  }
  return page.mainFrame();
}

/**
 * Clicks the number (Player 8, 9, 10, or 11).
 * Supports odds rows, Back odds buttons, seat positions on the felt, and direct player buttons.
 */
async function clickNumber(frame, playerNumber, odds = null) {
  const p = Number(playerNumber);
  if (![8, 9, 10, 11].includes(p)) throw new Error(`Invalid player number: ${playerNumber}`);

  // 0. The real table: the first "Player {p}" row is Back / Lay ("Player 11  2.08  2.2"); its first
  //    number is the Back odds cell. Marked in the page, then clicked as a real mouse click.
  const want = odds && (odds.back ? odds.back[p] : odds[p]);
  const found = await frame.evaluate(({p, want}) => {
    for (const el of document.querySelectorAll('[data-v32-click]')) el.removeAttribute('data-v32-click');
    const visible = el => {
      if (el.closest('[aria-hidden="true"]')) return false;
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 && r.width > 0 && r.height > 0;
    };
    const label = new RegExp(`^Player\\s*${p}$`, 'i'), anyPlayer = /Player\s*(8|9|10|11)\b/gi, num = /^\d+(?:\.\d+)?$/;
    const labels = [...document.querySelectorAll('body *')]
      .filter(el => label.test((el.textContent || '').trim()) && ![...el.children].some(c => label.test((c.textContent || '').trim())) && visible(el));
    if (!labels.length) return {error: `No "Player ${p}" row is visible in the game.`};
    // The row: the largest ancestor that still names only this one player.
    let row = labels[0];
    for (let a = row.parentElement; a && a !== document.body; a = a.parentElement) {
      if ((a.textContent.match(anyPlayer) || []).length > 1) break;
      row = a;
    }
    const cells = [...row.querySelectorAll('*')]
      .filter(el => num.test((el.textContent || '').trim()) && ![...el.children].some(c => num.test((c.textContent || '').trim())) && visible(el));
    if (!cells.length) return {error: `Betting looks closed: Player ${p} has no odds to click (locked).`};
    const pick = (want && cells.find(c => Number(c.textContent.trim()) === Number(want))) || cells[0];
    // Click the clickable box around the number if there is one (button / cell), else the number itself.
    const target = pick.closest('button, [role="button"], td') || pick;
    target.setAttribute('data-v32-click', '1');
    return {odds: Number(pick.textContent.trim())};
  }, {p, want}).catch(e => ({error: e.message}));
  if (found && !found.error) {
    const el = frame.locator('[data-v32-click="1"]').first();
    await el.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
    await el.click({ timeout: 3000 });
    return { method: 'back-odds-cell', odds: found.odds };
  }
  if (found && /closed/.test(found.error)) throw new Error(found.error);

  // 1. Odds row or container matching Player {p}
  const rowSelectors = [
    `.odds-row[data-player="${p}"]`,
    `tr:has-text("Player ${p}")`,
    `tr:has-text("Player${p}")`,
    `.odds-row:has-text("Player ${p}")`,
    `[data-player="${p}"]`,
    `.runner-row:has-text("Player ${p}")`,
    `.market-row:has-text("Player ${p}")`,
  ];

  for (const sel of rowSelectors) {
    const rows = frame.locator(sel);
    const count = await rows.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      // Look for a Back button or Back cell inside this row
      const backBtn = row.locator('.btn-back, .back, button[data-action="back"], .back-cell').first();
      if (await backBtn.count().catch(() => 0) && await backBtn.isVisible().catch(() => false)) {
        await backBtn.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
        await backBtn.click({ timeout: 2000 });
        return { method: 'row-back-btn', selector: sel };
      }
      // If odds value is known (e.g. 2.08 for Player 11), look for button with that odds text
      if (odds && (odds[p] || (odds.back && odds.back[p]))) {
        const val = odds[p] || odds.back[p];
        const oddsBtn = row.locator(`button:has-text("${val}"), td:has-text("${val}"), div:has-text("${val}")`).first();
        if (await oddsBtn.count().catch(() => 0)) {
          await oddsBtn.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
          await oddsBtn.click({ timeout: 2000 });
          return { method: 'row-odds-value', selector: sel, odds: val };
        }
      }
      // Any button inside the player row
      const anyBtn = row.locator('button').first();
      if (await anyBtn.count().catch(() => 0)) {
        await anyBtn.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
        await anyBtn.click({ timeout: 2000 });
        return { method: 'row-any-button', selector: sel };
      }
    }
  }

  // 2. Direct button / seat / runner element with player identifier
  const directSelectors = [
    `button.btn-back[data-player="${p}"]`,
    `button[data-player="${p}"]`,
    `[data-player="${p}"]`,
    `.seat[data-player="${p}"]`,
    `.seat:has-text("${p}+")`,
    `.seat:has-text("${p}")`,
    `button:has-text("Player ${p}")`,
    `button:has-text("Player${p}")`,
    `button:has-text("${p}+")`,
  ];
  for (const sel of directSelectors) {
    const el = frame.locator(sel).first();
    if (await el.count().catch(() => 0)) {
      await el.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      await el.click({ timeout: 2000 });
      return { method: 'direct-selector', selector: sel };
    }
  }

  // 3. Fallback text matches
  const textMatchers = [
    new RegExp(`^\\s*Player\\s*${p}\\s*$`, 'i'),
    new RegExp(`^\\s*${p}\\+\\s*$`),
    new RegExp(`\\bPlayer\\s*${p}\\b`, 'i'),
  ];
  for (const re of textMatchers) {
    const el = frame.getByText(re).first();
    if (await el.count().catch(() => 0)) {
      await el.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      await el.click({ timeout: 2000 });
      return { method: 'text-match', text: String(re) };
    }
  }

  throw new Error(`Could not find button or betting spot for Player ${p}`);
}

/**
 * Clicks a chip matching the amount (e.g. 50, 100, 500, 1000).
 */
async function clickChip(frame, amount) {
  const amt = Number(amount);
  if (!(amt > 0)) return false;

  const chipSelectors = [
    `.chip[data-amount="${amt}"]`,
    `.chip[data-value="${amt}"]`,
    `button.chip:has-text("${amt}")`,
    `button:has-text("${amt}")`,
    `.chip:has-text("${amt}")`,
    `[data-amount="${amt}"]`,
    `[data-value="${amt}"]`,
  ];

  for (const sel of chipSelectors) {
    const el = frame.locator(sel).first();
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
      await el.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      await el.click({ timeout: 2000 });
      return true;
    }
  }

  // Try chip text matching regex
  const chipByText = frame.locator('.chip, .token, .coin, [class*="chip" i]')
    .filter({ hasText: new RegExp(`^\\s*(?:₹|Rs\\.?)?\\s*${amt}\\s*$`, 'i') }).first();
  if (await chipByText.count().catch(() => 0) && await chipByText.isVisible().catch(() => false)) {
    await chipByText.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
    await chipByText.click({ timeout: 2000 });
    return true;
  }

  // Check 1k, 5k shorthand
  if (amt >= 1000 && amt % 1000 === 0) {
    const kVal = `${amt / 1000}k`;
    const kEl = frame.locator('.chip, button, [data-amount]')
      .filter({ hasText: new RegExp(`^\\s*(?:₹|Rs\\.?)?\\s*${kVal}\\s*$`, 'i') }).first();
    if (await kEl.count().catch(() => 0) && await kEl.isVisible().catch(() => false)) {
      await kEl.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      await kEl.click({ timeout: 2000 });
      return true;
    }
  }

  return false;
}

/**
 * Enters the amount in a stake input or clicks quick stake buttons.
 */
async function setAmountOrInput(frame, amount) {
  const amt = Number(amount);
  if (!(amt > 0)) return false;

  const inputSelectors = [
    '#stakeInput',
    'input[placeholder*="stake" i]',
    'input[placeholder*="amount" i]',
    'input.stake',
    'input.amount',
    'input[name*="stake" i]',
    'input[name*="amount" i]',
    'input[type="number"]',
  ];

  for (const sel of inputSelectors) {
    const input = frame.locator(sel).first();
    if (await input.count().catch(() => 0) && await input.isVisible().catch(() => false)) {
      await input.click({ timeout: 1000 }).catch(() => {});
      await input.fill(String(amt), { timeout: 1000 });
      return true;
    }
  }

  // Quick stake buttons (+50, +100, 100, etc.)
  const quickBtn = frame.locator('button').filter({ hasText: new RegExp(`^\\s*\\+?${amt}\\s*$`) }).first();
  if (await quickBtn.count().catch(() => 0) && await quickBtn.isVisible().catch(() => false)) {
    await quickBtn.click({ timeout: 1000 });
    return true;
  }

  // If a chip became visible after player selection, click it
  return await clickChip(frame, amt);
}

/**
 * Clicks the Place Bet / Confirm button if visible.
 */
async function clickPlaceBetIfVisible(frame) {
  const placeBtnSelectors = [
    '#placeBetBtn',
    'button:has-text("Place Bet")',
    'button:has-text("Place bet")',
    'button:has-text("Confirm")',
    'button:has-text("Bet")',
    'button:has-text("Submit")',
    '.btn-place-bet',
    '.place-bet',
  ];
  for (const sel of placeBtnSelectors) {
    const btn = frame.locator(sel).first();
    if (await btn.count().catch(() => 0) && await btn.isVisible().catch(() => false)) {
      const disabled = await btn.isDisabled().catch(() => false);
      if (!disabled) {
        await btn.click({ timeout: 2000 });
        return true;
      }
    }
  }
  return false;
}

/**
 * Executes the full click sequence for the given number and amount.
 */
async function executeClick(frame, playerNumber, amount, { odds = null } = {}) {
  const p = Number(playerNumber);
  const amt = Number(amount);
  if (![8, 9, 10, 11].includes(p)) {
    return { ok: false, error: `Invalid player number: ${playerNumber}. Must be 8, 9, 10, or 11.` };
  }
  if (!(amt > 0)) {
    return { ok: false, error: `Invalid amount: ${amount}. Must be greater than 0.` };
  }

  let chipClicked = false;
  let numberClicked = false;
  let amountHandled = false;
  let placedBetClicked = false;
  let numberDetail = null;

  // Step 1: Pre-select chip if available on the table layout
  try {
    chipClicked = await clickChip(frame, amt);
  } catch {}

  // Step 2: Click the player number / betting position
  try {
    numberDetail = await clickNumber(frame, p, odds);
    numberClicked = !!numberDetail;
  } catch (e) {
    return { ok: false, error: `Failed to click Player ${p}: ${e.message}`, player: p, amount: amt };
  }

  // Step 3: Handle amount (in bet slip or chip selector opened after player click)
  if (chipClicked) {
    amountHandled = true;
  } else {
    try {
      amountHandled = await setAmountOrInput(frame, amt);
    } catch {}
  }

  // Step 4: Click Place Bet / Confirm if present
  try {
    placedBetClicked = await clickPlaceBetIfVisible(frame);
  } catch {}

  const ok = numberClicked && (amountHandled || placedBetClicked || chipClicked);
  return {
    ok,
    player: p,
    amount: amt,
    numberClicked,
    amountHandled,
    chipClicked,
    placedBetClicked,
    detail: numberDetail,
    error: ok ? null : 'Could not set or confirm the bet amount.',
  };
}

module.exports = {
  findGameFrame,
  clickNumber,
  clickChip,
  setAmountOrInput,
  clickPlaceBetIfVisible,
  executeClick,
};

