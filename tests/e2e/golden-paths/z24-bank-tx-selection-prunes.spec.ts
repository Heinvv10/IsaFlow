/**
 * Golden path (z24): a ticked row does not outlive the list it was ticked in (WP3, UI safety).
 *
 * Data-independent, writes nothing and clicks nothing that writes, so it also runs in the post-deploy verify: it ticks a row
 * (when the account has one on the New tab), changes the list (the Reviewed tab, then a next page when there is one) and
 * asserts the always-visible "N selected" bar reads 0 each time. A company with no bank account, with only inactive
 * accounts, or with nothing to tick passes the parts it can reach and says nothing about the rest. The state it guards:
 * a bulk action (Delete, Mark as Reviewed, Batch Allocate) acting on rows no longer on screen.
 */
import { expect, test } from '@playwright/test';

const BANK = '/accounting/bank-transactions';

test('bank transactions: ticked rows are dropped when the list changes', async ({ page }) => {
  await page.goto(BANK);
  const strip = page.getByTestId('bank-tx-stats-strip');
  const empty = page.getByText('No bank accounts configured');
  const noActive = page.getByTestId('bank-summary-none-active');
  await expect(strip.or(empty).or(noActive)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('bank-summary-error')).toHaveCount(0);
  if (await empty.count() > 0 || await noActive.count() > 0) return;

  // The bar is always there, and starts at 0.
  const selected = page.getByTestId('bank-tx-selected-count');
  await expect(selected).toHaveText('0 selected');

  // Wait for the list to settle: rows, or the empty state.
  await expect(page.getByTestId('bank-tx-table').or(page.getByTestId('bank-tx-empty'))).toBeVisible({ timeout: 45_000 });
  const boxes = page.locator('[data-testid="bank-tx-table"] tbody input[type="checkbox"]:enabled');
  if (await boxes.count() === 0) return; // nothing to tick on this account's New tab

  await boxes.first().check();
  await expect(selected).toHaveText(/^[1-9]\d* selected$/);

  // Change the list: another tab. Whatever was ticked is not on screen any more.
  await page.getByTestId('bank-tx-tab-reviewed').click();
  await expect(selected).toHaveText('0 selected');

  // And back: the New tab does not bring the old tick back.
  await page.getByTestId('bank-tx-tab-new').click();
  await expect(page.getByTestId('bank-tx-table').or(page.getByTestId('bank-tx-empty'))).toBeVisible({ timeout: 45_000 });
  await expect(selected).toHaveText('0 selected');

  // A next page, when there is one: tick, turn the page, 0 again.
  const next = page.getByRole('button', { name: '2', exact: true });
  if (await next.count() > 0 && await next.isEnabled()) {
    const again = page.locator('[data-testid="bank-tx-table"] tbody input[type="checkbox"]:enabled');
    if (await again.count() > 0) {
      await again.first().check();
      await expect(selected).toHaveText(/^[1-9]\d* selected$/);
      await next.click();
      await expect(selected).toHaveText('0 selected');
    }
  }
});
