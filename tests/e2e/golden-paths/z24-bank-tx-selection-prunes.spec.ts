/**
 * Golden path (z24): a ticked row does not outlive the list it was ticked in (WP3, UI safety).
 *
 * Data-independent, writes nothing and clicks nothing that writes, so it also runs in the post-deploy verify: it ticks a row
 * (when the account has one on the New tab), changes the list (a search that matches nothing, then cleared; a tab; a next page when there is one) and
 * asserts the always-mounted "N selected" live region reads 0 each time, and the contextual selection bar (WP4b: it shows only
 * while something is ticked) is gone (and stays 0 when the row comes back: the tick was dropped, not hidden). A company with no bank account, with only inactive
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

  // The live region is always there, and starts at 0; the selection bar shows only while something is ticked.
  const selected = page.getByTestId('bank-tx-selection-live');
  const bar = page.getByTestId('bank-tx-selection-bar');
  await expect(selected).toHaveText('0 selected');
  await expect(bar).toHaveCount(0);

  // Wait for the list to settle: rows, or the empty state.
  await expect(page.getByTestId('bank-tx-table').or(page.getByTestId('bank-tx-empty'))).toBeVisible({ timeout: 45_000 });
  const boxes = page.locator('[data-testid="bank-tx-table"] tbody input[type="checkbox"]:enabled');
  if (await boxes.count() === 0) return; // nothing to tick on this account's New tab

  await boxes.first().check();
  await expect(selected).toHaveText(/^[1-9]\d* selected$/);
  await expect(bar.getByTestId('bank-tx-selected-count')).toHaveText(/^[1-9]\d* selected$/);

  // Change the list on the SAME tab (a filter), so the tab reset cannot be what clears the tick: the search matches nothing,
  // the ticked row leaves the screen, and the bar reads 0. Then the search is cleared and the row is back on screen: the tick
  // must NOT come back with it. (A count that is merely the ticked rows still on screen would read 1 again here; only a
  // selection that was actually dropped reads 0.)
  const search = page.getByLabel('Search transactions');
  await search.fill('zz-no-such-bank-line-zz');
  await expect(page.getByTestId('bank-tx-empty')).toBeVisible({ timeout: 30_000 });
  await expect(selected).toHaveText('0 selected');
  await search.fill('');
  await expect(page.getByTestId('bank-tx-table')).toBeVisible({ timeout: 30_000 });
  await expect(selected).toHaveText('0 selected');
  await expect(bar).toHaveCount(0);

  // Another tab and back: still nothing ticked.
  await page.getByTestId('bank-tx-tab-reviewed').click();
  await expect(selected).toHaveText('0 selected');
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
      // and back to page 1: the page-1 tick is gone for good, not parked
      const first = page.getByRole('button', { name: '1', exact: true });
      if (await first.count() > 0) {
        await first.click();
        await expect(selected).toHaveText('0 selected');
      }
    }
  }
});
