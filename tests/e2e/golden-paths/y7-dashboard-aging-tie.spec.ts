// golden:dev-only
/**
 * Golden path (y7): Home's money ties to the reports, and Home leads with setup (master plan wave 2, H).
 *
 *  - On Demo, the dashboard's AR buckets tie to the AR Age Analysis report's, both read through the UI at
 *    the same as-at (today, SAST): equal bucket by bucket when nothing is disputed, otherwise equal in
 *    total with the gaps summing to the Disputed row (a dispute of any age). The donut used to put 61-90
 *    inside its "90+".
 *  - On the empty sandbox company the setup checklist is above the hero and inside the first screen,
 *    and Action Items does not say "All caught up!".
 *  - The ageing donuts draw in their colours (not Pie's default grey) and fit inside 390 px.
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

/** "R 10 686 885.43" (spaces may be NBSP) as whole cents. */
const cents = (text: string): number => Math.round(Number(text.replace(/[^\d.-]/g, '')) * 100);
const BUCKETS = ['Current', '1–30 Days', '31–60 Days', '61–90 Days', '90+ Days'] as const;

test('the dashboard AR ties to the AR Age Analysis, whatever is disputed', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/accounting');
  const card = page.locator('div').filter({ has: page.getByRole('heading', { name: 'AR Aging', exact: true }) }).last();
  const row = (label: string) => card.locator('div.justify-between').filter({ hasText: label });
  const dashRow = row('90+ Days');
  await expect(dashRow).toBeVisible({ timeout: 90_000 });
  // 61–90 is its own bucket now, not folded into "90+".
  await expect(row('61–90 Days')).toBeVisible();
  const dash: Record<string, number> = {};
  for (const label of BUCKETS) dash[label] = cents(await row(label).locator('span.tabular-nums').innerText());
  // Disputed leaves its age bucket on Home and stays in it on the report; it is listed only when non-zero.
  const disputedRow = row('Disputed');
  const disputed = (await disputedRow.count()) > 0 ? cents(await disputedRow.locator('span.tabular-nums').innerText()) : 0;
  const dashboard90 = (await dashRow.locator('span.tabular-nums').innerText()).trim();
  await card.scrollIntoViewIfNeeded();
  await shot(page, 'y7-dashboard-ar-aging');

  await page.goto('/accounting/reports/ar-aging');
  await settle(page);
  const report: Record<string, number> = {};
  for (const label of BUCKETS) {
    report[label] = cents(await page.getByRole('button').filter({ has: page.getByText(label, { exact: true }) }).locator('p.tabular-nums').innerText());
  }
  await shot(page, 'y7-report-ar-aging');

  expect(dashboard90).toMatch(/^R\s[\d\s]+\.\d{2}$/);
  // Total: the six donut rows are the report's five buckets, to the cent, with or without a dispute.
  const sum = (xs: number[]): number => xs.reduce((t, x) => t + x, 0);
  expect(sum(Object.values(dash)) + disputed).toBe(sum(Object.values(report)));
  if (disputed === 0) {
    // Nothing disputed: every bucket is the report's bucket.
    for (const label of BUCKETS) expect(dash[label], label).toBe(report[label]);
  } else {
    // A disputed amount sits in some report bucket: no bucket here exceeds the report's, and the
    // gaps add up to the Disputed row (so this holds whichever age the dispute is, 91+ days or not).
    for (const label of BUCKETS) expect(dash[label]!, label).toBeLessThanOrEqual(report[label]!);
    expect(sum(BUCKETS.map((l) => report[l]! - dash[l]!))).toBe(disputed);
  }
});

test('the ageing donuts draw in colour and fit a 390 px screen', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/accounting');
  for (const key of ['arAging', 'apAging']) {
    const donut = page.getByTestId(`${key}-donut`);
    await expect(donut.locator('path.recharts-sector').first()).toBeVisible({ timeout: 90_000 });
    await donut.scrollIntoViewIfNeeded();
    // Pie's default fill is #808080; a slice in it means the colours were lost.
    const fills = await donut.locator('path.recharts-sector').evaluateAll((els) => els.map((e) => e.getAttribute('fill')));
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.filter((f) => !f || f.toLowerCase() === '#808080'), `${key} grey slices`).toEqual([]);
    const pie = await donut.locator('svg.recharts-surface').boundingBox();
    const ring = await donut.locator('g.recharts-pie').boundingBox();
    expect(pie && ring, `${key} donut drawn`).toBeTruthy();
    expect(ring!.x, `${key} ring starts on screen`).toBeGreaterThanOrEqual(0);
    expect(ring!.x + ring!.width, `${key} ring ends on screen`).toBeLessThanOrEqual(390);
    expect(ring!.x, `${key} ring inside its chart`).toBeGreaterThanOrEqual(pie!.x);
    expect(ring!.x + ring!.width).toBeLessThanOrEqual(pie!.x + pie!.width);
  }
  await shot(page, 'y7-donut-390');
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
