// golden:dev-only
/**
 * Golden path (z8): Budget vs Actual tracking (budgets P3 spec §5 T15, §8) at /accounting/reports/budget-vs-actual,
 * and the income statement's Budget comparator column.
 *
 * READ-ONLY. The engine's answer for one fixed whole-month window (`/api/accounting/reports-budget-tracking`,
 * period=custom, the financial year's first month to its last complete month) is read first; with no budgeted line in it
 * the spec skips with the reason. The page must then show: the title, the window and the version the API named,
 * no error state, the band table with its Actual / Budget / Δ Budget / Projected FY / FY budget headers, a body row
 * for the first budgeted line whose Actual, Budget and FY budget cells carry the API's figures. The income
 * statement for the same dates, with the Budget checkbox ticked, must grow a Budget column and show that line's
 * budget (the same figure, both surfaces reading one engine). Nothing is written, in any company.
 * Dev-only (marker above): it depends on a company that has an approved/primary budget, which prod Demo may lack.
 * Screenshots attach to the report, and go to EVIDENCE_DIR as golden-budget-tracking-<step>.png when it is set.
 */
import { mkdirSync } from 'fs';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { Api } from './_api';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;

interface Line { accountCode: string; accountName: string; band: string; actual: number; budget: number | null; fyBudget: number | null }
interface Report {
  window: { label: string; startDate: string; endDate: string; fiscalYear: number; months: string[] };
  projection: { actualMonths: string[] };
  version: { name: string; status: string } | null;
  lines: Line[];
}

async function shoot(page: Page, name: string): Promise<void> {
  const body = await page.screenshot({ fullPage: false });
  await test.info().attach(`${name}.png`, { body, contentType: 'image/png' });
  if (EVIDENCE_DIR) { mkdirSync(EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: `${EVIDENCE_DIR}/golden-budget-tracking-${name}.png` }); }
}

/** The digits of a printed figure: "9 000.00" and "9,000.00" both give 900000. */
const digits = (s: string): string => s.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
/** The digits the page prints for an engine figure (rand, two decimals, no sign: a negative prints in brackets). */
const printed = (rand: number): string => digits(Math.abs(rand).toFixed(2));

/** The statement body row for an account: the first row that shows its code and name. */
const lineRow = (page: Page, l: Line): Locator => page.locator('tbody tr').filter({ hasText: l.accountName }).filter({ hasText: l.accountCode }).first();

test.describe('Budget tracking: Budget vs Actual page and the income statement Budget column', () => {
  let report: Report;
  let line: Line;
  let query: string;

  test.beforeAll(async ({ baseURL }) => {
    const api = await Api.login(baseURL!);
    try {
      const fy = await api.get<Report>('/api/accounting/reports-budget-tracking?period=fy');
      const months = fy.window.months;
      query = `period=custom&from=${months[0]}&to=${fy.projection.actualMonths.at(-1) ?? months[0]}`;
      report = await api.get<Report>(`/api/accounting/reports-budget-tracking?${query}`);
    } finally {
      await api.ctx.dispose();
    }
    line = report.lines.find((l) => l.budget !== null && l.budget > 0 && l.actual !== 0 && l.fyBudget !== null)
      ?? report.lines.find((l) => l.budget !== null && l.budget > 0 && l.fyBudget !== null)!;
  });

  test.beforeEach(() => {
    test.skip(!line, `no budgeted line in ${query}: this company has no budget to track, nothing to assert`);
  });

  test('Budget vs Actual: window, version, band table and the API figures', async ({ page }) => {
    await page.goto(`/accounting/reports/budget-vs-actual?${query}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Budget vs Actual' })).toBeVisible();

    // The header names the window and version the engine read.
    await expect(page.getByTestId('report-period')).toContainText(report.window.label);
    expect(report.version, 'the window has a version').not.toBeNull();
    await expect(page.getByTestId('bva-version-read')).toContainText(report.version!.name);

    // The statement, not an error or empty state.
    const grid = page.locator('#bva-statement');
    await expect(grid.locator('table')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(page.getByText('No budget or actuals in this window')).toHaveCount(0);
    await expect(page.getByText('Correct the period above')).toHaveCount(0);

    // Headers are upper-cased by CSS, and innerText reads them so.
    const heads = (await grid.locator('thead th').allInnerTexts()).map((h) => h.trim().toLowerCase());
    for (const h of ['Actual', 'Budget', 'Δ Budget', 'Projected FY', 'FY budget']) expect(heads, `header "${h}"`).toContain(h.toLowerCase());

    // Band table: the line sits under its band, and each band closes with a total row.
    await expect(grid.locator('tbody tr').filter({ hasText: /^Total / }).first()).toBeVisible();
    expect(await grid.locator('tbody tr').count()).toBeGreaterThanOrEqual(report.lines.length);

    // The first budgeted line carries the API's Actual, Budget and FY budget.
    const row = lineRow(page, line);
    await expect(row).toBeVisible();
    // The budget fetch trails the checkbox (debounced), so the cell fills in after the column appears.
    await expect(async () => {
      const cells = (await row.locator('td').allInnerTexts()).map(digits);
      if (line.actual !== 0) expect(cells, `Actual ${line.actual}`).toContain(printed(line.actual));
      expect(cells, `Budget ${line.budget}`).toContain(printed(line.budget!));
      expect(cells, `FY budget ${line.fyBudget}`).toContain(printed(line.fyBudget!));
    }).toPass({ timeout: 15_000 });
    await shoot(page, 'budget-vs-actual');
  });

  test('Budget vs Actual: the Full year window prints the engine Budget and FY budget', async ({ page, baseURL }) => {
    await page.goto('/accounting/reports/budget-vs-actual?period=fy');
    await expect(page.locator('#bva-statement table')).toBeVisible();
    const api = await Api.login(baseURL!);
    const fy = await api.get<Report>('/api/accounting/reports-budget-tracking?period=fy').finally(() => api.ctx.dispose());
    const l = fy.lines.find((x) => x.accountCode === line.accountCode)!;
    expect(l, `${line.accountCode} is in the FY report`).toBeTruthy();
    const cells = (await lineRow(page, l).locator('td').allInnerTexts()).map(digits);
    expect(cells).toContain(printed(l.budget ?? 0));
    expect(cells).toContain(printed(l.fyBudget ?? 0));
    await expect(page.getByTestId('report-period')).toContainText(fy.window.label);
  });

  test('Income statement: the Budget checkbox adds a Budget column showing the same figure', async ({ page }) => {
    await page.goto(`/accounting/reports/income-statement?period_start=${report.window.startDate}&period_end=${report.window.endDate}`);
    await expect(page.getByRole('heading', { name: 'Income Statement' })).toBeVisible();
    const budgetBox = page.locator('#cmp-budget');
    await expect(budgetBox).toBeVisible();
    await expect(budgetBox).not.toBeChecked();
    await expect(page.locator('thead th', { hasText: /^Budget$/ })).toHaveCount(0);

    await budgetBox.check();
    await expect(page.locator('thead th').filter({ hasText: /^Budget$/ })).toBeVisible();
    // (Next's dev route announcer is an empty alert; a real error carries text.)
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);

    const row = lineRow(page, line);
    await expect(row).toBeVisible();
    // The budget fetch trails the checkbox (debounced), so the cell fills in after the column appears.
    await expect(async () => {
      const cells = (await row.locator('td').allInnerTexts()).map(digits);
      if (line.actual !== 0) expect(cells, `Actual ${line.actual}`).toContain(printed(line.actual));
      expect(cells, `Budget ${line.budget}`).toContain(printed(line.budget!));
    }).toPass({ timeout: 15_000 });
    await shoot(page, 'income-statement-budget-column');
  });
});
