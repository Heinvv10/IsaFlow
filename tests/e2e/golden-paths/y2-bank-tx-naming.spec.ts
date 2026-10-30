// golden:dev-only
/**
 * Golden path Y2: the bank transactions grid is named, keyboard-operable, and never shows "empty" past the end.
 *
 * 1. axe on /accounting/bank-transactions (page and grid) and /accounting/bank-reconciliation reports 0 critical
 *    and 0 serious in light and dark, against an EMPTY baseline: nothing is excused.
 * 2. Keyboard: Tab from the toolbar search reaches the grid, ArrowDown walks the rows, E opens the focused row's Selection popover with
 *    its search focused and named, Esc returns focus to that row. Enter is not pressed: on a row with a choice it
 *    accepts, which posts to the ledger.
 * 3. Past the end: on page 2, the reload that follows accepting the page's last row returns no rows and a total
 *    above zero. That response is stubbed here (no accept is posted); the page must move to page 1 and show rows,
 *    never the empty state.
 *
 * Dev-only: axe, dev data (Demo needs more than 25 new transactions on its first bank account), and a stubbed
 * response. Read-only: no write reaches the company. BANK_TX_EVIDENCE_DIR=<dir> saves a screenshot per theme.
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'path';
import { expectNoSeriousA11yViolations, openScreen } from './helpers/axe';
import { A11Y_SCREENS } from './helpers/a11yScreens';
import { THEMES, seedTheme } from '../helpers/themeSpec';

const BANK_TX = A11Y_SCREENS.find((s) => s.path === '/accounting/bank-transactions')!;
const BANK_REC = { name: 'bank reconciliation list', path: '/accounting/bank-reconciliation', heading: 'Bank Reconciliation' };
const NOTHING_EXCUSED = { pages: {} };
const evidenceDir = process.env.BANK_TX_EVIDENCE_DIR;
const ROWS = '[data-testid="bank-tx-table"] tbody tr';

test.setTimeout(240_000);

for (const theme of THEMES) {
  test(`axe: bank transactions and bank reconciliation, 0 critical / 0 serious (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1568, height: 1000 });
    await seedTheme(page, theme);
    await openScreen(page, BANK_TX);
    await expect(page.locator(ROWS).first(), 'Demo has new bank transactions to scan').toBeVisible();
    await expectNoSeriousA11yViolations(page, { baseline: NOTHING_EXCUSED });
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `bank-tx-${theme}-1568.png`) });
    await openScreen(page, BANK_REC);
    await expectNoSeriousA11yViolations(page, { baseline: NOTHING_EXCUSED });
  });
}

async function activeIs(page: Page, what: 'grid' | 'row'): Promise<boolean> {
  return page.evaluate((w) => {
    const el = document.activeElement;
    if (!el) return false;
    if (w === 'grid') return el.getAttribute('role') === 'group' && (el.getAttribute('aria-label') ?? '').startsWith('Bank transactions');
    return el.tagName === 'TR' && el.hasAttribute('data-focused');
  }, what);
}

test('keyboard: Tab into the grid, ArrowDown, E opens the popover, Esc returns focus to the row', async ({ page }) => {
  await openScreen(page, BANK_TX);
  const rows = page.locator(ROWS);
  await expect(rows.nth(1), 'two rows to walk').toBeVisible();
  await page.getByRole('textbox', { name: 'Search transactions' }).focus(); // the toolbar's last field, above the grid
  let reached = false;
  for (let i = 0; i < 60 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await activeIs(page, 'grid');
  }
  expect(reached, 'Tab reaches the grid').toBe(true);
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(0)).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toHaveAttribute('data-focused', 'true');
  await expect(rows.nth(0)).not.toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('e');
  const search = rows.nth(1).getByRole('textbox', { name: /^Search (accounts|suppliers|customers|bank accounts)$/ });
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect.poll(() => activeIs(page, 'row')).toBe(true);
  await expect(rows.nth(1)).toBeFocused();
});

test('past the end: page 2 reloading with no rows and total > 0 moves to page 1 and shows rows, not "empty"', async ({ page }) => {
  await openScreen(page, BANK_TX);
  const pager = page.getByRole('button', { name: '2', exact: true });
  await expect(pager, 'Demo needs more than one page of new transactions').toBeVisible();
  const page2 = page.waitForResponse((r) => /\/api\/accounting\/bank-transactions\?.*offset=25/.test(r.url()));
  await pager.click();
  const body = await (await page2).json() as { data?: { total?: number } };
  const total = body.data?.total ?? 0;
  expect(total).toBeGreaterThan(25);
  await expect(page.locator(ROWS).first()).toBeVisible();

  // The reload after the page's last row is accepted: that row is gone, so page 2 is past the end.
  const shrunk = Math.min(total - 1, 25);
  await page.route(/\/api\/accounting\/bank-transactions\?.*offset=25/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { transactions: [], total: shrunk } }) }));
  let emptyShown = false;
  await page.exposeFunction('__bankTxEmptySeen', () => { emptyShown = true; });
  await page.evaluate(() => {
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="bank-tx-empty"]')) (window as unknown as { __bankTxEmptySeen: () => void }).__bankTxEmptySeen();
    }).observe(document.body, { childList: true, subtree: true });
  });
  const page1 = page.waitForResponse((r) => /\/api\/accounting\/bank-transactions\?.*offset=0/.test(r.url()), { timeout: 30_000 });
  await page.getByRole('button', { name: 'Actions', exact: true }).click(); // the toolbar's refresh (title "Refresh")
  await page1;
  await expect(page.locator(ROWS).first()).toBeVisible();
  expect(emptyShown, '"No new transactions" never showed while the total was above zero').toBe(false);
});
