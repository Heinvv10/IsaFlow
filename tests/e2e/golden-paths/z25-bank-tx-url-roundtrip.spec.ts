/**
 * Golden path (z25): the bank-transactions view lives in the URL (WP4a). Account, tab and search are written to the query
 * string as the user works, survive a refresh, come back with Back/Forward, and a pasted link opens the same list.
 *
 * Data-independent and read-only (it only changes the view), so it also runs in the post-deploy verify. A company with no
 * bank account, or only inactive ones, passes without checking anything: there is no view to put in a URL.
 */
import { expect, test, type Page } from '@playwright/test';

const BANK = '/accounting/bank-transactions';
const params = (page: Page) => new URL(page.url()).searchParams;
const tabSelected = async (page: Page, tab: 'new' | 'reviewed' | 'excluded') =>
  expect(page.getByTestId(`bank-tx-tab-${tab}`)).toHaveAttribute('aria-selected', 'true');

test('bank transactions: account, tab and search round-trip through the URL (refresh, Back/Forward, a pasted link)', async ({ page }) => {
  await page.goto(BANK);
  const strip = page.getByTestId('bank-tx-stats-strip');
  const empty = page.getByText('No bank accounts configured');
  const noActive = page.getByTestId('bank-summary-none-active');
  await expect(strip.or(empty).or(noActive)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('bank-summary-error')).toHaveCount(0);
  if (await empty.count() > 0 || await noActive.count() > 0) return;

  // The account the page opened on is in the URL.
  await expect.poll(() => params(page).get('account_id'), { timeout: 30_000 }).toBeTruthy();
  const account = params(page).get('account_id')!;
  await tabSelected(page, 'new');

  // A tab and a search go into the URL.
  await page.getByTestId('bank-tx-tab-reviewed').click();
  await expect.poll(() => params(page).get('tab')).toBe('reviewed');
  const search = page.getByLabel('Search transactions');
  await search.fill('zz-url-roundtrip');
  await expect.poll(() => params(page).get('q'), { timeout: 10_000 }).toBe('zz-url-roundtrip');
  expect(params(page).get('account_id')).toBe(account);

  // REFRESH: the same view comes back.
  await page.reload();
  await expect(strip).toBeVisible({ timeout: 45_000 });
  await tabSelected(page, 'reviewed');
  await expect(page.getByLabel('Search transactions')).toHaveValue('zz-url-roundtrip');
  await expect(page.getByTestId('active-filters')).toContainText('zz-url-roundtrip');
  expect(params(page).get('account_id')).toBe(account);

  // BACK goes to the New tab (the tab change was a history entry); FORWARD returns to Reviewed with its search.
  await page.goBack();
  await tabSelected(page, 'new');
  await expect(page.getByLabel('Search transactions')).toHaveValue('');
  expect(params(page).get('tab')).toBeNull();
  await page.goForward();
  await tabSelected(page, 'reviewed');
  await expect(page.getByLabel('Search transactions')).toHaveValue('zz-url-roundtrip');

  // A PASTED LINK opens that list, whatever was open before.
  await page.goto(`${BANK}?account_id=${encodeURIComponent(account)}&tab=excluded`);
  await expect(strip).toBeVisible({ timeout: 45_000 });
  await tabSelected(page, 'excluded');
  await expect(page.getByLabel('Search transactions')).toHaveValue('');
  expect(params(page).get('account_id')).toBe(account);

  // Nonsense in a link is ignored, not an error page.
  await page.goto(`${BANK}?account_id=${encodeURIComponent(account)}&tab=nonsense&page=-4&min=1e3`);
  await expect(strip).toBeVisible({ timeout: 45_000 });
  await tabSelected(page, 'new');
  await expect(page.getByTestId('bank-summary-error')).toHaveCount(0);
});
