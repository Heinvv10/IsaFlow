// golden:dev-only
/**
 * Golden path (y7): Home's money ties to the reports, and Home leads with setup (master plan wave 2, H).
 *
 *  - On Demo, the dashboard's AR "90+ Days" equals the AR Age Analysis report's "90+ Days", both read
 *    through the UI at the same as-at (today, SAST). The donut used to put 61-90 inside its "90+".
 *  - On the empty sandbox company the setup checklist is above the hero and inside the first screen,
 *    and Action Items does not say "All caught up!".
 *  - Ctrl+K "profit" + Enter lands on the Income Statement (Profit & Loss is its nav alias).
 *
 * Dev-only: it reads Demo twice (an edit between the reads must not roll back a prod deploy) and creates
 * the empty sandbox on first use. The real gate for the figure is
 * tests/integration/dashboard-aging-ties-to-report.int.test.ts. EVIDENCE=1 saves screenshots.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { Api } from './_api';
import { findOrCreateSandbox, switchBrowserCompany } from './_migrationSandbox';
import { settle } from '../helpers/themeSpec';

const SHOTS = 'docs/evidence/master-plan/wave2/H';
/** The empty sandbox v-empty-states uses: a true first run. */
const EMPTY_SANDBOX = { name: '0GP Golden Empty Sandbox', onboardingId: '7d3e9a14-2b6c-4f58-9a01-c3e5b7d9f102' };

test.use({ timezoneId: 'Africa/Johannesburg' });

test.beforeAll(({}, testInfo) => {
  const u = new URL(String(testInfo.project.use.baseURL ?? 'http://localhost'));
  expect(u.hostname, 'y7 creates a sandbox company: dev/CI localhost only').toBe('localhost');
});

async function shot(page: Page, name: string): Promise<void> {
  if (process.env.EVIDENCE !== '1') return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test('the dashboard AR 90+ equals the AR Age Analysis 90+', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/accounting');
  const card = page.locator('div').filter({ has: page.getByRole('heading', { name: 'AR Aging', exact: true }) }).last();
  const dashRow = card.locator('div.justify-between').filter({ hasText: '90+ Days' });
  await expect(dashRow).toBeVisible({ timeout: 90_000 });
  // 61–90 is its own bucket now, not folded into "90+".
  await expect(card.locator('div.justify-between').filter({ hasText: '61–90 Days' })).toBeVisible();
  const dashboard90 = (await dashRow.locator('span.tabular-nums').innerText()).trim();
  await card.scrollIntoViewIfNeeded();
  await shot(page, 'y7-dashboard-ar-aging');

  await page.goto('/accounting/reports/ar-aging');
  await settle(page);
  const reportCard = page.getByRole('button').filter({ hasText: '90+ Days' });
  const report90 = (await reportCard.locator('p.tabular-nums').innerText()).trim();
  await shot(page, 'y7-report-ar-aging');

  expect(dashboard90).toMatch(/^R\s[\d\s]+\.\d{2}$/);
  expect(dashboard90).toBe(report90);
});

test('on an empty company the setup checklist leads Home and nothing says "All caught up!"', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const api = await Api.login(baseURL!);
  let sandbox = '';
  try {
    sandbox = await findOrCreateSandbox(api, EMPTY_SANDBOX);
  } finally {
    await api.dispose();
  }
  await switchBrowserCompany(page.context(), sandbox);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/accounting');
  const checklist = page.getByRole('region', { name: 'Finish setting up' });
  await expect(checklist).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Action Items' })).toBeVisible({ timeout: 90_000 });
  const listBox = await checklist.boundingBox();
  const heroBox = await page.getByRole('banner').filter({ hasText: 'Financial Overview' }).boundingBox();
  expect(listBox && heroBox && listBox.y < heroBox.y, 'checklist above the hero').toBe(true);
  expect(listBox!.y, 'checklist starts inside the first screen').toBeLessThan(800);
  await expect(page.getByText('All caught up!')).toHaveCount(0);
  await shot(page, 'y7-empty-company-home');
});

test('Ctrl+K "profit" then Enter lands on the Income Statement', async ({ page }) => {
  await page.goto('/accounting');
  await settle(page);
  await page.keyboard.press('Control+k');
  const dialog = page.locator('[role="dialog"][aria-label="Command palette"]');
  await expect(dialog).toBeVisible();
  await page.getByRole('combobox').fill('profit');
  const first = page.getByRole('option').first();
  await expect(first).toContainText('Income Statement');
  await expect(first).toContainText('also: Profit & Loss');
  await shot(page, 'y7-palette-profit');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/accounting\/reports\/income-statement/, { timeout: 30_000 });
});
