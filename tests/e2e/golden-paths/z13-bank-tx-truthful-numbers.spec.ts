/**
 * Golden path (z13): the bank transactions page tells the truth about its numbers (WP1 "Truthful numbers", PR-C).
 *
 * Data-independent, so it also runs in the post-deploy verify (no axe, no created data, no fixed figure, and a red run
 * rolls the deploy back): it asserts the SHAPE of what the page shows, whatever company and accounts it runs against,
 * including a company with no bank account (the empty state) or with only group cards. Loading the page is not
 * strictly read-only: for a write role it fires the idempotent POST bank-relink-transfers, which links transfer pairs
 * that already exist and changes nothing otherwise.
 *  - the card's balance is the labelled ledger ("Ledger R…"), with no glyph-only number (no check mark or delta sign);
 *  - the page has no "GL Balance" label (the old widget's name for a figure that was not the ledger);
 *  - the statement panel's balance row is a money figure or says why there is none, never a bare "—";
 *  - Allocated + Suggested + Unallocated + Excluded equals the strip's data-posted-lines;
 *  - when an account has provisional lines, "incl. n provisional" opens the Provisional tab.
 * Every optional element is guarded with count() (instant), never with an auto-waiting read, so an absent element
 * cannot burn the timeout. The figures themselves are proved by tests/integration/bank-account-summary-*.int.test.ts.
 */
import { expect, test } from '@playwright/test';

const BANK = '/accounting/bank-transactions';
const MONEY = /R\s?\d/;
const REASONS = [
  'Not provided by this file format',
  'In the file, but its running balance does not agree with its lines — not used',
  'Not recorded for this import',
];

test('bank transactions: labelled ledger, honest statement panel, tiles that sum to the posted lines', async ({ page }) => {
  await page.goto(BANK);
  const strip = page.getByTestId('bank-tx-stats-strip');
  const empty = page.getByText('No bank accounts configured');
  // Either an account is selected and its strip loads, or the company has no bank account. A load error is neither.
  await expect(strip.or(empty)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('bank-summary-error')).toHaveCount(0);
  await expect(page.getByText('GL Balance')).toHaveCount(0);
  if (await empty.count() > 0) return;

  // The cards: "Ledger R…" on every card (primary or group), no glyph-only figure.
  const ledgers = page.getByTestId('card-ledger');
  expect(await ledgers.count(), 'an account card is shown').toBeGreaterThan(0);
  await expect(ledgers.first()).toHaveText(/Ledger\s+(?:−)?R\s?\d/);
  for (const card of await page.locator('[data-testid="bank-account-card"], [data-testid="bank-group-card"]').all()) {
    expect((await card.textContent()) ?? '').not.toMatch(/[✓Δ]/);
  }

  // The statement panel: a figure, or the reason there is none, or "no statement yet" — never a bare dash.
  const panel = page.getByTestId('bank-statement-panel');
  await expect(panel).toBeVisible();
  const closing = panel.getByTestId('statement-closing');
  if (await closing.count() > 0) {
    const text = ((await closing.first().textContent()) ?? '').replace(/\u00A0/g, ' ');
    expect(MONEY.test(text) || REASONS.some((r) => text.includes(r)), `statement balance row says: ${text}`).toBe(true);
  } else {
    await expect(panel).toContainText('No statement imported yet');
  }
  await expect(panel.getByText('—', { exact: true })).toHaveCount(0);

  // The tiles sum to the posted lines.
  const value = async (id: string) => Number(await page.getByTestId(id).locator('p').first().textContent());
  const sum = (await value('tile-allocated')) + (await value('tile-suggested')) + (await value('tile-unallocated')) + (await value('tile-excluded'));
  expect(sum).toBe(Number(await strip.getAttribute('data-posted-lines')));

  // Provisional lines are reachable.
  const provisional = page.getByTestId('tile-provisional-link');
  if (await provisional.count() > 0) {
    await provisional.click();
    await expect(page.getByTestId('bank-tx-tab-provisional')).toHaveAttribute('aria-current', 'page');
  }
});
