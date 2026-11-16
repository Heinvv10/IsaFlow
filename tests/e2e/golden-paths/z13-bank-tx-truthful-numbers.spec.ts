/**
 * Golden path (z13): the bank transactions page tells the truth about its numbers (WP1 "Truthful numbers", PR-C).
 *
 * Data-independent and read-only, so it also runs in the post-deploy verify (no axe, no write, no fixed figure): it
 * asserts the SHAPE of what the page shows, whatever company and accounts it is run against.
 *  - the card's balance is the labelled ledger ("Ledger R…"), not an unlabelled figure, and carries no glyph-only
 *    number (no check mark or delta sign);
 *  - the page has no "GL Balance" label (the old widget's name for a figure that was not the ledger);
 *  - the statement panel's balance row is a money figure or says why there is none, never a bare "—";
 *  - Allocated + Suggested + Unallocated + Excluded equals the strip's data-posted-lines;
 *  - when an account has provisional lines, "incl. n provisional" opens the Provisional tab.
 * The figures themselves are proved by tests/integration/bank-account-summary-*.int.test.ts.
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
  await expect(strip, 'an account is selected and its strip loads').toBeVisible({ timeout: 45_000 });

  // The card: "Ledger R…", no glyph-only figure.
  const card = page.getByTestId('card-ledger').first();
  await expect(card).toHaveText(/Ledger\s+(?:−)?R\s?\d/);
  const cardText = await page.getByTestId('bank-account-card').first().textContent().catch(() => null);
  if (cardText !== null) expect(cardText).not.toMatch(/[✓Δ]/);

  // The old widget's label for a figure that was not the ledger.
  await expect(page.getByText('GL Balance')).toHaveCount(0);

  // The statement panel: a figure, or the reason there is none, or "no statement yet" — never a bare dash.
  const panel = page.getByTestId('bank-statement-panel');
  await expect(panel).toBeVisible();
  const closing = panel.getByTestId('statement-closing');
  if (await closing.count() > 0) {
    const text = ((await closing.first().textContent()) ?? '').replace(/ /g, ' ');
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
