/**
 * Golden path (t): report filter dates are typed DateFields (master plan wave 1, F1).
 *
 * On the Profit & Loss: type "1 Sep 2026" into From and "eom" into To, and the header names the range;
 * refused text ("zz") leaves the report on its last good range; the filter dates carry no serious axe
 * violation; light and dark screenshots. Read-only: it only filters a report.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../helpers/navSpec';
import { mkdirSync } from 'fs';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { seedTheme, settle, SETTLE_MS, THEMES } from '../helpers/themeSpec';

const SHOTS = 'docs/evidence/master-plan/wave1/report-filter-dates';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE_INPUTS = 'input[placeholder="dd MMM yyyy"]';
const heading = (page: Page) => page.getByRole('heading', { name: /Profit & Loss —/ });

/** "eom" is the end of THIS month; the page reads the browser clock, so does the expectation. */
function endOfThisMonth(): string {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return `${String(last.getDate()).padStart(2, '0')} ${MONTHS[last.getMonth()]} ${last.getFullYear()}`;
}

async function typeInto(page: Page, label: string, text: string): Promise<void> {
  const field = page.getByLabel(label, { exact: true });
  await field.fill(text);
  await field.press('Tab');
}

test('P&L: typed From and "eom" To set the range the header names', async ({ page }) => {
  await page.goto('/accounting/reports/income-statement');
  await settle(page);
  await typeInto(page, 'From', '1 Sep 2026');
  await typeInto(page, 'To', 'eom');
  await expect(heading(page)).toContainText(`01 Sep 2026 to ${endOfThisMonth()}`, { timeout: SETTLE_MS });
  await typeInto(page, 'To', '30 Sep 2026');
  await expect(heading(page)).toContainText('01 Sep 2026 to 30 Sep 2026', { timeout: SETTLE_MS });
});

test('P&L: refused text does not change the range or fetch', async ({ page }) => {
  await page.goto('/accounting/reports/income-statement?period_start=2026-09-01&period_end=2026-09-30');
  await settle(page);
  const fetched: string[] = [];
  page.on('request', (r) => { if (r.url().includes('reports-income-statement')) fetched.push(r.url()); });
  await typeInto(page, 'To', 'zz');
  await expect(page.getByLabel('To', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.waitForTimeout(500);
  expect(fetched, 'no report request for refused text').toHaveLength(0);
  await expect(heading(page)).toContainText('01 Sep 2026 to 30 Sep 2026', { timeout: SETTLE_MS });
});

test('P&L: the filter dates are clean for axe and look right in both themes', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of THEMES) {
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/accounting/reports/income-statement?period_start=2026-09-01&period_end=2026-09-30');
    await settle(page);
    await page.waitForSelector(`html[data-theme-applied="${theme}"]`);
    // The page has other findings of its own (title, cost-centre select): this scan is the filter dates alone.
    await expectNoSeriousA11yViolations(page, { include: [DATE_INPUTS], key: 'filter-dates:income-statement' });
    await page.screenshot({ path: `${SHOTS}/income-statement-${theme}.png` });
  }
});
