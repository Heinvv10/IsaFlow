/**
 * Golden path (z): budget drivers on the workspace grid (budgets P4 spec §8 T7) at /accounting/budgets.
 *
 * In a non-primary scenario `GP-<runId>`: Sales typed for the year → set COGS = 38% of Sales in the driver editor →
 * COGS follows → edit one Sales month → COGS follows it → type over one COGS month → the override mark → a per_head
 * driver on a salaries line, then a planned hire → that row moves by R per head × FTE from the hire's month → New
 * reforecast from actuals → the closed months are marked Actual.
 *
 * It runs in prod post-deploy verify against Demo (scripts/verify-deploy.sh), so it obeys the budgets contract's
 * golden-spec write rule (docs/plans/budgets/00-shared-contract.md):
 *   - prechecks through the API BEFORE any write (owner/admin role; a year that already has a version; an active
 *     turnover, cost-of-sales and operating-expense line) and skips with a reason;
 *   - sweeps stale unlocked non-primary `GP-` versions first, then writes only its own versions: the scenario (made
 *     through the API) and its reforecast (`GP-…-RF`, never rolling). A route guard aborts any other budget write.
 *     It never sets primary, never locks, never writes settings, the GL, payroll or fiscal periods;
 *   - step 5 needs a closed period in the year; with none it is skipped (annotated), never by closing one;
 *   - deletes its versions by id in a `finally` and again in `afterAll` (re-read as non-primary, unlocked, `GP-`).
 * Screenshots attach to the report, and go to EVIDENCE_DIR as golden-budget-drivers-<step>.png when it is set.
 */
import { mkdirSync } from 'fs';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { Api, gpRef } from './_api';
import { accountRow, cellCents, openWorkspace, pasteTsv, rowCell, waitForGrid } from '../helpers/budgetWorkspace';
import { cleanUp, created, guardBudgetWrites, precheck, sweep, type Version } from '../helpers/budgetDrivers';

const SALES = 100_000;
const COGS_PCT = 38;
const PER_HEAD = 10_000;
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;

async function shoot(page: Page, name: string): Promise<void> {
  const body = await page.screenshot({ fullPage: false });
  await test.info().attach(`${name}.png`, { body, contentType: 'image/png' });
  if (EVIDENCE_DIR) { mkdirSync(EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: `${EVIDENCE_DIR}/golden-budget-drivers-${name}.png` }); }
}

const rowCents = (row: Locator, n: number) => Promise.all(Array.from({ length: n }, (_, c) => cellCents(rowCell(row, c))));

/** Opens the row's ⋯ menu and picks `item`. */
async function rowAction(row: Locator, page: Page, item: string): Promise<void> {
  await row.getByRole('button', { name: /^Row actions for/ }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** Types `value` into column `col` of `row` and saves the grid (the drivers recompute; the grid re-reads in place). */
async function typeAndSave(page: Page, row: Locator, col: number, value: number, blocked: Promise<never>): Promise<void> {
  await rowCell(row, col).dblclick();
  const editor = row.locator('[data-cell-editor] input, input[aria-label$=" budget"]').first();
  await editor.fill(String(value));
  await editor.press('Enter');
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/accounting/budget-grid/save'));
  await page.getByTestId('save-bar-save').click();
  expect((await Promise.race([saved, blocked])).status(), 'save').toBe(200);
  await expect(page.locator('td[data-dirty="true"]')).toHaveCount(0);
}

/** Fills the open driver editor with `fill`, saves it, and waits for the PUT and the drawer to close. */
async function saveDriver(page: Page, fill: (ed: Locator) => Promise<void>, blocked: Promise<never>): Promise<void> {
  const ed = page.getByTestId('driver-editor');
  await expect(ed).toBeVisible();
  await fill(ed);
  const put = page.waitForResponse((r) => r.url().endsWith('/api/accounting/budget-drivers') && r.request().method() === 'PUT');
  await ed.getByTestId('driver-editor-save').click();
  const res = await Promise.race([put, blocked]);
  expect(res.status(), `driver saved: ${await res.text()}`).toBe(200);
  await expect(ed).toBeHidden({ timeout: 60_000 });
}

test.afterAll(async ({}, testInfo) => {
  if (created.size === 0) return;
  const api = await Api.login(testInfo.project.use.baseURL!);
  try {
    const errors = await cleanUp(api);
    if (errors.length > 0) throw new Error(`budget drivers cleanup: ${errors.join('; ')}`);
  } finally {
    await api.dispose();
  }
});

test('budget drivers: 38% of Sales → COGS follows → override → per-head + hire → reforecast from actuals', async ({ page, baseURL }) => {
  test.setTimeout(150_000); // ~10x a warm local run (13.5 s); a cold `next dev` compile adds ~10 s
  const api = await Api.login(baseURL!);
  let failed = true;
  try {
    const plan = await precheck(api);
    test.skip(typeof plan === 'string', `budget drivers precheck: ${String(plan)}`);
    if (typeof plan === 'string') return;
    await sweep(api);

    const runName = gpRef('DRV');
    const version = await api.post<Version>('/api/accounting/budget-versions', { fiscalYear: plan.fiscalYear, name: runName, kind: 'scenario' });
    created.add(version.id);
    expect(version, "the run's own version: a non-primary draft scenario").toMatchObject({ name: runName, kind: 'scenario', status: 'draft', isPrimary: false });
    const { blocked, violations } = await guardBudgetWrites(page, runName);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => window.localStorage.setItem('accounting-theme', 'light'));
    await openWorkspace(page, { fiscalYear: plan.fiscalYear, versionId: version.id });
    const n = plan.months.length;
    const sales = accountRow(page, plan.sales.id);
    const cogs = accountRow(page, plan.cogs.id);
    const salaries = accountRow(page, plan.salaries.id);

    // 0. Sales typed for the year: one pasted row, saved.
    await rowCell(sales, 0).click();
    expect((await pasteTsv(page, `${Array.from({ length: n }, () => SALES).join('\t')}\r\n`)).defaultPrevented).toBe(true);
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/accounting/budget-grid/save'));
    await page.getByTestId('save-bar-save').click();
    expect((await Promise.race([saved, blocked])).status(), 'save the Sales row').toBe(200);

    // 1. COGS = 38% of Sales: every month 38 000, the chip names the driver.
    await rowAction(cogs, page, 'Set driver…');
    await saveDriver(page, async (ed) => {
      await ed.getByLabel('Driver', { exact: true }).selectOption('pct_of_line');
      await ed.getByLabel('Percentage (%)', { exact: true }).fill(String(COGS_PCT));
      await ed.getByLabel('Of the line', { exact: true }).selectOption(`${plan.sales.id}|||`);
    }, blocked);
    await expect(cogs.getByTestId('driver-chip')).toContainText(`${COGS_PCT}% × ${plan.sales.name}`);
    await expect.poll(() => rowCents(cogs, n), { message: 'COGS = 38% of Sales' }).toEqual(plan.months.map(() => SALES * COGS_PCT));
    await expect(rowCell(cogs, 0)).toHaveAttribute('data-source', 'driver');
    await shoot(page, 'cogs-driver-light-1280');

    // 2. One Sales month edited → that COGS month follows (the save recomputes dependents).
    await typeAndSave(page, sales, 0, 2 * SALES, blocked);
    await expect.poll(() => cellCents(rowCell(cogs, 0)), { message: 'COGS follows the Sales edit' }).toBe(2 * SALES * COGS_PCT);

    // 3. Type over one COGS month: an override, with its mark and the driver's value.
    await typeAndSave(page, cogs, 1, 12_345, blocked);
    await expect(rowCell(cogs, 1)).toHaveAttribute('data-source', 'override', { timeout: 30_000 });
    expect(await cellCents(rowCell(cogs, 1))).toBe(1_234_500);
    const mark = rowCell(cogs, 1).getByTestId('override-mark');
    await mark.hover();
    // 38% of the untouched R 100 000 Sales month (formatCents groups with a no-break space).
    await expect(page.getByTestId('override-note')).toContainText(/Override of driver value R\s38\s000\.00/);
    await shoot(page, 'override-light-1280');
    await page.mouse.move(1, 1);

    // 4. A per_head driver on the salaries line, then a planned hire: the row moves by R per head × 1 FTE from its month.
    await rowAction(salaries, page, 'Set driver…');
    await saveDriver(page, async (ed) => {
      await ed.getByLabel('Driver', { exact: true }).selectOption('per_head');
      await ed.getByLabel('Amount per head a month (R)', { exact: true }).fill(String(PER_HEAD));
    }, blocked);
    await expect(salaries.getByTestId('driver-chip')).toContainText('× heads');
    const before = await rowCents(salaries, n);
    const hireFrom = Math.min(3, n - 1);
    await page.getByTestId('headcount-toggle').click();
    const panel = page.getByTestId('headcount-panel');
    await expect(panel.getByTestId('headcount-table')).toBeVisible({ timeout: 60_000 });
    const blank = panel.getByTestId('planned-hire').last();
    await blank.getByRole('textbox', { name: /^Role of/ }).fill('GP role');
    await blank.getByRole('combobox', { name: /^Start month of/ }).selectOption(plan.months[hireFrom]!);
    const hired = page.waitForResponse((r) => r.url().endsWith('/api/accounting/budget-drivers/planned-hires') && r.request().method() === 'POST');
    await blank.getByRole('button', { name: 'Add hire' }).click();
    expect((await Promise.race([hired, blocked])).status(), 'hire added').toBe(200);
    await expect.poll(async () => (await rowCents(salaries, n)).map((v, i) => (v ?? 0) - (before[i] ?? 0)), { message: 'the per-head row moved by one head from the hire month' })
      .toEqual(plan.months.map((_, i) => (i >= hireFrom ? PER_HEAD * 100 : 0)));
    await panel.scrollIntoViewIfNeeded();
    await shoot(page, 'hire-light-1280');
    await page.getByTestId('headcount-toggle').click();

    // 5. New reforecast from actuals (never rolling): its closed months are read-only Actual columns.
    if (plan.closedMonths.length === 0) {
      test.info().annotations.push({ type: 'skipped step', description: `step 5 (reforecast from actuals) skipped: FY${plan.fiscalYear} has no closed period, and this spec never closes one` });
    } else {
      await page.getByTestId('version-reforecast-actuals').click();
      const dialog = page.getByTestId('reforecast-dialog');
      await expect(dialog.getByRole('combobox', { name: 'Source version' })).toHaveValue(version.id);
      await dialog.getByRole('textbox', { name: 'Name' }).fill(`${runName}-RF`);
      await expect(dialog.getByRole('checkbox', { name: /Rolling/ })).not.toBeChecked();
      const made = page.waitForResponse((r) => r.url().endsWith(`/api/accounting/budget-versions/${version.id}/reforecast`) && r.request().method() === 'POST');
      await dialog.getByTestId('reforecast-create').click();
      const res = await Promise.race([made, blocked]);
      expect(res.status(), `reforecast created: ${await res.text()}`).toBe(201);
      const rf = ((await res.json()) as { data: { version: Version; closedMonths: string[]; rolling: boolean } }).data;
      created.add(rf.version.id);
      expect(rf.version, 'the reforecast is a non-primary GP draft').toMatchObject({ name: `${runName}-RF`, kind: 'reforecast', isPrimary: false });
      expect(rf.rolling).toBe(false);
      expect(rf.closedMonths).toEqual(plan.closedMonths);
      await expect(dialog.getByTestId('reforecast-result')).toBeVisible();
      await dialog.getByRole('button', { name: 'Close' }).click();
      await waitForGrid(page, rf.version.id);
      await expect(page.locator('th[data-actual="true"]')).toHaveCount(rf.closedMonths.length);
      const first = plan.months.indexOf(rf.closedMonths[0]!);
      await expect(rowCell(accountRow(page, plan.sales.id), first)).toHaveAttribute('data-actual', 'true');
      await expect(rowCell(accountRow(page, plan.sales.id), first)).toHaveAttribute('aria-readonly', 'true');
      await page.evaluate(() => window.scrollTo(0, 0));
      await shoot(page, 'reforecast-actuals-light-1280');
    }

    expect(violations, "the page attempted no budget write outside this run's own versions").toEqual([]);
    failed = false;
  } finally {
    const errors = await cleanUp(api);
    await api.dispose();
    if (errors.length > 0) {
      test.info().annotations.push({ type: 'cleanup', description: errors.join('; ') });
      if (!failed) throw new Error(`budget drivers cleanup: ${errors.join('; ')}`);
    }
  }
});
