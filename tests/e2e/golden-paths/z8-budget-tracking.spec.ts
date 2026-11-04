// golden:dev-only
/**
 * Golden path (z8): Budget vs Actual tracking (budgets P3 spec §5 T15, §8) at
 * /accounting/reports/budget-vs-actual, and the income statement's Budget comparator column.
 *
 * READ-ONLY. The engine's answer for one whole-month window (`/api/accounting/reports-budget-tracking`,
 * period=custom, the financial year's first month to its last complete month) names the line to check. The spec
 * skips only when the company has no budget version at all, and FAILS when a version exists but no line in it is
 * budgeted. The page must show: the title, the window and the version the API named, no error state, the band
 * table with its Actual / Budget / Δ Budget / Projected FY / FY budget headers, and a body row for the chosen line
 * whose Actual, Budget and FY budget cells (each read under its own header) carry the API's figures. The income
 * statement for the same dates, with the Budget checkbox ticked, must grow a Budget column and show that line's
 * budget (both surfaces read one engine). Nothing is written, in any company.
 *
 * Figure comparisons run in a bounded retry (RETRY: up to six attempts, fewer when page loads are slow, so a
 * persistent mismatch costs at most six reports-budget-tracking reads against the company's shared limit). Each
 * attempt re-reads the API AND reloads the page, so fresh figures are never compared with a stale page (another
 * golden spec may post into the shared company between tests).
 *
 * Dev-only (marker above): it depends on a company that has an approved/primary budget, which prod Demo may lack.
 * Screenshots attach to the report, and go to EVIDENCE_DIR as golden-budget-tracking-<step>.png when it is set.
 */
import { mkdirSync } from 'fs';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { Api } from './_api';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;

interface Line {
  accountCode: string; accountName: string; band: string;
  actual: number; budget: number | null; fyBudget: number | null;
}
interface Report {
  window: { label: string; startDate: string; endDate: string; fiscalYear: number; months: string[] };
  projection: { actualMonths: string[] };
  version: { name: string; status: string } | null;
  lines: Line[];
}

async function shoot(page: Page, name: string): Promise<void> {
  const body = await page.screenshot({ fullPage: false });
  await test.info().attach(`${name}.png`, { body, contentType: 'image/png' });
  if (EVIDENCE_DIR) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: `${EVIDENCE_DIR}/golden-budget-tracking-${name}.png` });
  }
}

/**
 * A printed figure with locale punctuation removed, but its accounting sign retained:
 * "(9 000.00)" and "-9,000.00" both give -900000, while "9 000.00" gives 900000.
 */
const figure = (s: string): string => {
  const text = s.trim();
  const negative = /^\(.*\)$/.test(text) || /^[-\u2212]/.test(text);
  const magnitude = text.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  return negative ? `-${magnitude}` : magnitude;
};
/**
 * The page's precision and locale (src/lib/format/money.ts `cents`: en-ZA, two decimals). `figure` equates Intl's
 * minus sign here with the page's accounting brackets without discarding either sign.
 */
const TWO_DP = new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const printed = (rand: number): string => figure(TWO_DP.format(rand));

/** The statement body row for an account: the first row of `table` that shows its code and name. */
const lineRow = (table: Locator, l: Line): Locator =>
  table.locator('tbody tr').filter({ hasText: l.accountName }).filter({ hasText: l.accountCode }).first();

/**
 * The digits in `row`'s cell under the column headed `header` (headers are upper-cased by CSS; innerText reads them
 * so). Waits for the cell to hold a figure first: a comparator column's cells fill in after its header appears.
 */
async function cellUnder(table: Locator, row: Locator, header: string): Promise<string> {
  const heads = (await table.locator('thead th').allInnerTexts()).map((h) => h.trim().toLowerCase());
  const col = heads.indexOf(header.toLowerCase());
  expect(col, `column "${header}" in [${heads.join(' | ')}]`).toBeGreaterThanOrEqual(0);
  const cell = row.locator('td').nth(col);
  await expect(cell).toHaveText(/\d/, { timeout: 5_000 });
  return figure(await cell.innerText());
}

/**
 * Bounded retry: attempts can start at about 0, 1, 4, 9, 14 and 19 s (the last interval repeats), and none after
 * 20 s: up to six attempts, fewer when page loads are slow.
 */
const RETRY = { timeout: 20_000, intervals: [1_000, 3_000, 5_000] };

/** A fresh read of one window, and the line `code` in it. */
async function freshLine(baseURL: string, query: string, code: string): Promise<{ report: Report; line: Line }> {
  const api = await Api.login(baseURL);
  try {
    const report = await api.get<Report>(`/api/accounting/reports-budget-tracking?${query}`);
    const line = report.lines.find((l) => l.accountCode === code);
    if (!line) throw new Error(`account ${code} is no longer in ${query}`);
    return { report, line };
  } finally {
    await api.ctx.dispose();
  }
}

test.describe('Budget tracking: Budget vs Actual page and the income statement Budget column', () => {
  let query = '';
  let code = '';
  let hasVersion = false;

  test.beforeAll(async ({ baseURL }) => {
    const api = await Api.login(baseURL!);
    try {
      const fy = await api.get<Report>('/api/accounting/reports-budget-tracking?period=fy');
      hasVersion = fy.version !== null;
      if (!hasVersion) return;
      const months = fy.window.months;
      query = `period=custom&from=${months[0]}&to=${fy.projection.actualMonths.at(-1) ?? months[0]}`;
      const report = await api.get<Report>(`/api/accounting/reports-budget-tracking?${query}`);
      const budgeted = report.lines.filter((l) => l.budget !== null && l.budget > 0 && l.fyBudget !== null);
      const pick = budgeted.find((l) => l.actual !== 0) ?? budgeted[0];
      if (!pick) {
        throw new Error(
          `version "${fy.version!.name}" exists but no line in ${query} has a budget above zero: `
          + 'the seeded budget is missing or the window moved',
        );
      }
      code = pick.accountCode;
    } finally {
      await api.ctx.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(!hasVersion, 'the company has no budget version for the current financial year: nothing to track');
  });

  test('Budget vs Actual: window, version, band table and the API figures', async ({ page, baseURL }) => {
    const bva = `/accounting/reports/budget-vs-actual?${query}`;
    await page.goto(bva);
    await expect(page.getByRole('heading', { level: 1, name: 'Budget vs Actual' })).toBeVisible();

    // The header names the window and version the engine read.
    const { report } = await freshLine(baseURL!, query, code);
    await expect(page.getByTestId('report-period')).toContainText(report.window.label);
    expect(report.version, 'the window has a version').not.toBeNull();
    await expect(page.getByTestId('bva-version-read')).toContainText(report.version!.name);

    // The statement, not an error or empty state.
    const table = page.locator('#bva-statement table');
    await expect(table).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(page.getByText('No budget or actuals in this window')).toHaveCount(0);
    await expect(page.getByText('Correct the period above')).toHaveCount(0);

    const heads = (await table.locator('thead th').allInnerTexts()).map((h) => h.trim().toLowerCase());
    for (const h of ['Actual', 'Budget', 'Δ Budget', 'Projected FY', 'FY budget']) {
      expect(heads, `header "${h}"`).toContain(h.toLowerCase());
    }

    // Band table: each band closes with a total row, and every engine line has a row.
    await expect(table.locator('tbody tr').filter({ hasText: /^Total / }).first()).toBeVisible();
    expect(await table.locator('tbody tr').count()).toBeGreaterThanOrEqual(report.lines.length);

    // The chosen line carries the API's Actual, Budget and FY budget, each under its own header.
    await expect(async () => {
      const { line } = await freshLine(baseURL!, query, code);
      await page.reload();
      await expect(table).toBeVisible();
      const row = lineRow(table, line);
      await expect(row).toBeVisible();
      if (line.actual !== 0) {
        expect(await cellUnder(table, row, 'Actual'), `Actual ${line.actual}`).toBe(printed(line.actual));
      }
      expect(await cellUnder(table, row, 'Budget'), `Budget ${line.budget}`).toBe(printed(line.budget!));
      expect(await cellUnder(table, row, 'FY budget'), `FY budget ${line.fyBudget}`).toBe(printed(line.fyBudget!));
    }).toPass(RETRY);
    await shoot(page, 'budget-vs-actual');
  });

  test('Budget vs Actual: the Full year window prints the engine Budget and FY budget', async ({ page, baseURL }) => {
    await expect(async () => {
      const { report, line } = await freshLine(baseURL!, 'period=fy', code);
      await page.goto('/accounting/reports/budget-vs-actual?period=fy');
      const table = page.locator('#bva-statement table');
      await expect(table).toBeVisible();
      await expect(page.getByTestId('report-period')).toContainText(report.window.label);
      const row = lineRow(table, line);
      await expect(row).toBeVisible();
      expect(await cellUnder(table, row, 'Budget'), `Budget ${line.budget}`).toBe(printed(line.budget ?? 0));
      expect(await cellUnder(table, row, 'FY budget'), `FY budget ${line.fyBudget}`).toBe(printed(line.fyBudget ?? 0));
    }).toPass(RETRY);
  });

  test('Income statement: the Budget checkbox adds a Budget column showing the same figure', async ({ page, baseURL }) => {
    await expect(async () => {
      const { report, line } = await freshLine(baseURL!, query, code);
      await page.goto(
        `/accounting/reports/income-statement?period_start=${report.window.startDate}&period_end=${report.window.endDate}`,
      );
      await expect(page.getByRole('heading', { name: 'Income Statement' })).toBeVisible();
      const budgetBox = page.locator('#cmp-budget');
      await expect(budgetBox).toBeVisible();
      const table = page.locator('table').filter({ hasText: 'Total Turnover' }).first();
      const budgetHead = table.locator('thead th').filter({ hasText: /^Budget$/ });

      // Start from a known state whatever the box was left at: unticked, no Budget column; then tick it.
      await budgetBox.setChecked(false);
      await expect(budgetHead).toHaveCount(0);
      await budgetBox.setChecked(true);
      await expect(budgetHead).toBeVisible();
      // A real error carries text (Next's dev route announcer is an empty alert).
      await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);

      // The page waits BUDGET_COALESCE_MS after the box is ticked before it asks for the budget, so the column
      // header appears first and the figures arrive after it (cellUnder waits for them).
      const row = lineRow(table, line);
      await expect(row).toBeVisible();
      if (line.actual !== 0) {
        expect(await cellUnder(table, row, 'Actual'), `Actual ${line.actual}`).toBe(printed(line.actual));
      }
      expect(await cellUnder(table, row, 'Budget'), `Budget ${line.budget}`).toBe(printed(line.budget!));
    }).toPass(RETRY);
    await shoot(page, 'income-statement-budget-column');
  });
});
