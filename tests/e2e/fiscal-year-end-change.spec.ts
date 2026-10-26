/**
 * Change of financial year end, Dec -> Feb, through the browser (dev only).
 * Runs serially in ONE fresh company (state: FY_E2E_STATE). Order matters:
 * B (change) -> H (settings) -> E (budget) -> D (AFS) -> C (year-end close).
 */
import { test, expect, type Page } from '@playwright/test';

const SHOTS = process.env.FY_E2E_SHOTS
  || 'test-results/fiscal-year-end-change';
const REASON = 'FYE acceptance: align year end with the holding company';

// Not 'serial': a failed step must not skip the rest. Order still matters (file order, one worker).

let page: Page;
const consoleErrors: string[] = [];

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function go(path: string, ready: string): Promise<void> {
  // One retry: a dev-server hot reload mid-navigation aborts the first goto (net::ERR_ABORTED).
  await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => page.goto(path, { waitUntil: 'domcontentloaded', timeout: 60_000 }));
  await page.waitForSelector(ready, { timeout: 30_000 });
}

async function csrf(): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.find(c => c.name === 'isaflow_csrf')!.value;
}

async function api(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await page.request.fetch(url, {
    method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrf() },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status(), json: await res.json().catch(() => ({})) };
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: process.env.FY_E2E_STATE, viewport: { width: 1440, height: 1000 } });
  page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`${page.url()} :: ${m.text()}`); });
  page.on('pageerror', e => consoleErrors.push(`${page.url()} :: pageerror ${e.message}`));
});

test.afterAll(async () => {
  // eslint-disable-next-line no-console
  console.log(`CONSOLE ERRORS (${consoleErrors.length}):\n${consoleErrors.join('\n')}`);
  await page.context().close();
});

test('B: change the year end from December to February (14-month transition year)', async () => {
  await go('/accounting/financial-year-end-change', '[data-testid="current-year-range"]');
  await expect(page.getByTestId('current-year-range')).toContainText('1 Jan 2026 to 31 Dec 2026');
  await shot('B1-select');

  await page.getByTestId('new-year-end-month').selectOption('2');
  await page.getByTestId('step-select-next').click();
  await page.waitForSelector('[data-testid="preview-range"]');
  await expect(page.getByTestId('preview-months')).toHaveText('14');
  await expect(page.getByTestId('preview-range')).toContainText('28 Feb 2027');
  await expect(page.getByTestId('preview-effects')).toBeVisible();
  await shot('B2-preview');

  await page.getByTestId('step-preview-next').click();
  await page.waitForSelector('[data-testid="change-reason"]');
  await page.getByTestId('change-reason').fill(REASON);
  await page.getByTestId('confirm-cipc').check();
  await page.getByTestId('confirm-sars').check();
  await shot('B3-confirm');

  await page.getByTestId('apply-change').click();
  await expect(page.getByTestId('success-panel')).toBeVisible({ timeout: 30_000 });
  await shot('B4-success');

  await go('/accounting/financial-years', '[data-testid="fy-card-2026"]');
  await expect(page.getByTestId('fy-periods-2026')).toHaveText('14');
  await expect(page.getByTestId('fy-card-2026')).toContainText('Transition year');
  await expect(page.getByTestId('fy-card-2028')).toBeVisible();
  await expect(page.getByTestId('fy-start-2028')).toContainText(/1 Mar 2027|2027-03-01/);
  await shot('B5-financial-years');
});

test('H: Settings -> General shows the year end, the change history and the change link', async () => {
  await go('/accounting/company-settings?tab=general', '[data-testid="year-end-change-entry"]');
  await expect(page.getByTestId('current-year-end')).toContainText('28 Feb 2027');
  await expect(page.getByTestId('latest-year-end-change')).toBeVisible();
  await expect(page.getByTestId('change-year-end-link')).toBeVisible();
  await page.getByTestId('year-end-change-entry').scrollIntoViewIfNeeded();
  await shot('H1-settings');
});

const MONTH_KEYS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
  '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];

test('E: a budget for the 14-month year, then Budget vs Actual (full year)', async () => {
  await go('/accounting/budgets', '[data-testid="budget-year"]');
  await page.getByTestId('budget-year').selectOption('2026');
  await expect(page.getByTestId('budget-year').locator('option:checked')).toContainText('14 months');
  await page.getByRole('button', { name: /Add Budget/ }).click();
  await page.waitForSelector('[data-testid="budget-month-2026-01"]');
  await expect(page.locator('[data-testid^="budget-month-"]')).toHaveCount(14);
  await page.locator('form select').first().selectOption({ label: '4000 — ' + (await page.locator('form select option', { hasText: '4000' }).first().innerText()).split('— ')[1] });
  // MoneyFields parse on blur: the annual amount spreads when it is left, and each month resets it to the sum.
  await page.getByLabel('Annual amount').fill('14000');
  await page.getByLabel('Annual amount').blur();
  for (const k of MONTH_KEYS) {
    const month = page.getByTestId(`budget-month-${k}`).getByRole('textbox');
    await month.fill('1000');
    await month.blur();
  }
  await shot('E1-budget-form');
  await page.getByTestId('budget-save').click();
  await expect(page.getByTestId('budget-total-4000')).toContainText(/14[\s,]?000/);
  await shot('E2-budget-saved');

  await go('/accounting/reports/budget-vs-actual', 'select');
  await page.locator('select').first().selectOption('full_year');
  await expect(page.locator('tbody')).toContainText(/4000/, { timeout: 30_000 });
  await expect(page.locator('tfoot, tr').filter({ hasText: /^Total/ }).first()).toContainText(/14[\s, ]?000/);
  await shot('E3-budget-vs-actual');
});

async function glId(code: string): Promise<string> {
  const { json } = await api('GET', '/api/accounting/chart-of-accounts');
  const d = json.data ?? json;
  const list: Array<Record<string, unknown>> = Array.isArray(d) ? d : d.accounts ?? d.items ?? [];
  const row = list.find(a => String(a.accountCode ?? a.account_code) === code);
  if (!row) throw new Error(`account ${code} not found`);
  return String(row.id);
}

test('D: AFS for FY2026 says 14 months ended 2027-02-28 with the IAS 1.36 note', async () => {
  // One posted journal so the statements have figures: DR bank / CR revenue, in the transition year.
  const created = await api('POST', '/api/accounting/journal-entries', {
    entryDate: '2026-10-15', description: 'FYE acceptance sale', source: 'manual',
    lines: [
      { glAccountId: await glId('1110'), description: 'FYE acceptance', debit: 5000, credit: 0 },
      { glAccountId: await glId('4000'), description: 'FYE acceptance', debit: 0, credit: 5000 },
    ],
  });
  expect([200, 201]).toContain(created.status);
  const posted = await api('POST', '/api/accounting/journal-entries-action', { id: (created.json.data ?? created.json).id, action: 'post' });
  expect(posted.status).toBe(200);

  await go('/accounting/afs', 'button:has-text("New AFS")');
  await page.getByRole('button', { name: 'New AFS' }).click();
  await page.getByLabel('Fiscal year').fill('2026');
  await shot('D1-afs-create');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForSelector('a[href^="/accounting/afs/"]');
  const href = (await page.locator('a[href^="/accounting/afs/"]').first().getAttribute('href'))!;
  const docId = href.split('/').pop()!;
  await shot('D2-afs-created');

  // The period the document page is built on (its SSR calls this route). FY2026 is now 1 Jan 2026 - 28 Feb 2027.
  const period = await api('GET', `/api/accounting/afs/${docId}/period`);
  expect.soft(period.json.data, 'AFS period route for the 14-month FY2026').toEqual({ periodStart: '2026-01-01', periodEnd: '2027-02-28' });

  // Open the document the way the app does (SSR resolves the period). The dev server's NEXT_PUBLIC_APP_URL
  // (.env.local, :3200) can break that fetch; then fall back to the query override with the registry period.
  await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('text=Period:', { timeout: 30_000 }).catch(() => undefined);
  if (await page.getByText('Could not work out the reporting period').count() > 0) {
    // eslint-disable-next-line no-console
    console.log('NOTE: SSR period fetch failed (NEXT_PUBLIC_APP_URL); using ?period_start/period_end');
    await page.goto(`${href}?period_start=${period.json.data.periodStart}&period_end=${period.json.data.periodEnd}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('text=Period:', { timeout: 30_000 });
  }
  await expect(page.getByText(/Period: 2026-01-01\s*\S\s*2027-02-28/)).toBeVisible();
  await shot('D3-afs-header');

  await page.getByRole('button', { name: /^Notes$/ }).click();
  await page.getByText('Notes to the Financial Statements').waitFor({ timeout: 30_000 });
  await shot('D4-afs-notes');
  const body = await page.locator('body').innerText();
  expect(body, 'reporting period note').toContain('Reporting period');
  expect(body, 'notes cover the 14 months').toMatch(/14 months ended 2027-02-28/);
  expect(body, 'IAS 1.36 comparability note').toMatch(/IAS 1\.36/);
});

test('C: close all 14 periods of FY2026, then run the year-end close', async () => {
  await go('/accounting/financial-years', '[data-testid="fy-card-2026"]');
  await shot('C1-before-close');
  await page.getByTestId('fy-card-2026').getByRole('button', { name: 'Close Year' }).click();
  await shot('C2-close-year-modal');
  await page.getByRole('button', { name: 'Close Year' }).last().click();
  await expect(page.getByTestId('fy-card-2026').getByRole('button', { name: 'Close Year' })).toHaveCount(0, { timeout: 120_000 });
  await shot('C3-periods-closed');

  await go('/accounting/year-end', 'text=Fiscal Year 2026');
  await page.getByRole('button', { name: 'Process Year-End' }).first().click();
  // The closing journal is the outcome; poll for it (the page refresh after the click is slow under load), then reload.
  await expect.poll(async () => {
    const r = await api('GET', '/api/accounting/journal-entries?limit=100');
    return ((r.json.data?.entries ?? []) as Array<Record<string, unknown>>).filter(e => e.source === 'year_end').length;
  }, { timeout: 120_000 }).toBeGreaterThan(0);
  await go('/accounting/year-end', 'text=Fiscal Year 2026');
  await expect(page.getByText('0 periods open')).toBeVisible();
  await shot('C4-year-end-result');

  const list = await api('GET', '/api/accounting/journal-entries?limit=100');
  const rows: Array<Record<string, unknown>> = (list.json.data?.items ?? list.json.data?.entries ?? list.json.data ?? []);
  const closing = rows.filter(r => String(r.source ?? '').includes('year_end'));
  expect(closing.length, 'a year-end closing journal exists').toBeGreaterThan(0);
  expect(String(closing[0]!.entryDate ?? closing[0]!.entry_date).slice(0, 10)).toBe('2027-02-28');

  await go('/accounting/financial-years', '[data-testid="fy-card-2026"]');
  await expect(page.getByTestId('fy-card-2026')).toContainText(/locked|closed/i);
  await shot('C5-year-locked');

  await go('/accounting/financial-year-end-change', '[data-testid="change-history"]');
  await expect(page.getByTestId('undo-refusals')).toContainText('year-end closing journal');
  await shot('C6-history-after-close');
});
