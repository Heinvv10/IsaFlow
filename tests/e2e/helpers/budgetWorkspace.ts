/**
 * Shared by the budget workspace e2e specs (golden-paths/v-budget-workspace, budget-workspace-perf): open the
 * workspace on a year + version, find an account's cells, read a figure back from a cell's aria-label (exact,
 * cents included), and paste a TSV block the way a browser does (a synthetic `paste` ClipboardEvent on the focused
 * cell: headless-safe, no clipboard permission).
 */
import { expect, type Locator, type Page } from '@playwright/test';

export const WORKSPACE = '/accounting/budgets/workspace';
export const LINES = 'table[role="grid"] tr[data-kind="line"]';

/** The legacy year route the workspace's year select is built from (`data.fiscalYear` = the year holding today). */
export interface BudgetYearsAnswer {
  fiscalYear: number;
  years: { fiscalYear: number }[];
}

/** Waits until the grid shows `versionId` (or any version when omitted) with its lines rendered and no skeleton. */
export async function waitForGrid(page: Page, versionId?: string, timeout = 120_000): Promise<void> {
  if (versionId) await expect(page.getByTestId('version-select')).toHaveValue(versionId, { timeout });
  await expect(page.getByTestId('workspace-loading')).toHaveCount(0, { timeout });
  await page.locator(LINES).first().waitFor({ state: 'visible', timeout });
}

/** On a loaded workspace: picks the year (when it is not the default) and the version, and waits for the grid. */
export async function pickYearAndVersion(page: Page, opts: { fiscalYear: number; versionId?: string; timeout?: number }): Promise<void> {
  const timeout = opts.timeout ?? 120_000;
  const year = page.getByTestId('workspace-year');
  await expect(year).toBeEnabled({ timeout });
  if ((await year.inputValue()) !== String(opts.fiscalYear)) await year.selectOption(String(opts.fiscalYear));
  await waitForGrid(page, undefined, timeout);
  if (opts.versionId && (await page.getByTestId('version-select').inputValue()) !== opts.versionId) {
    await page.getByTestId('version-select').selectOption(opts.versionId);
  }
  await waitForGrid(page, opts.versionId, timeout);
}

/** Opens the workspace, then `pickYearAndVersion`. */
export async function openWorkspace(page: Page, opts: { fiscalYear: number; versionId?: string; timeout?: number }): Promise<void> {
  await page.goto(WORKSPACE, { waitUntil: 'domcontentloaded', timeout: opts.timeout ?? 120_000 });
  await pickYearAndVersion(page, opts);
}

/** The editable line row of one account (`acct:<id>`; a header's roll-up row is `rollup:<id>`). */
export const accountRow = (page: Page, accountId: string): Locator => page.locator(`tr[data-kind="line"][data-row="acct:${accountId}"]`);

/** Column `col` of a line row: 0 = the first month; `months` = the FY total. */
export const rowCell = (row: Locator, col: number): Locator => row.locator(`td[data-pos$=":${col}"]`);

/** The FY cell of a subtotal / total / grand row by its label ("Gross profit", "Net profit", "Total Turnover"). */
export const totalFyCell = (page: Page, label: string): Locator => page.locator(`td[aria-label^="${label}, full year, "]`);

/**
 * Cents from a grid cell's aria-label ("6000 Rent, Mar 2026, R 16 000.00, unsaved"): null when not budgeted, 0 for
 * the dash. Negatives print in brackets or with a minus sign.
 */
export function centsFromLabel(label: string | null): number | null {
  const m = /, (R [^,]+|not budgeted)(?:, unsaved|, conflict)*$/.exec(label ?? '');
  if (!m) throw new Error(`not a grid cell label: ${label}`);
  const text = m[1]!;
  if (text === 'not budgeted') return null;
  const body = text.slice(2).trim();
  if (body === '–' || body === '—') return 0;
  const negative = /^\(.*\)$/.test(body) || /^[-−]/.test(body);
  const digits = body.replace(/[^0-9.]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(digits)) throw new Error(`unreadable figure in ${label}`);
  const [whole, frac = ''] = digits.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -cents : cents;
}

export async function cellCents(cell: Locator): Promise<number | null> {
  return centsFromLabel(await cell.getAttribute('aria-label'));
}

/** Dispatches a `paste` carrying `text` (text/plain) on the focused element; returns whether the grid took it. */
export async function pasteTsv(page: Page, text: string): Promise<{ defaultPrevented: boolean; target: string | null }> {
  return page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    const target = document.activeElement;
    if (!target) return { defaultPrevented: false, target: null };
    target.dispatchEvent(ev);
    return { defaultPrevented: ev.defaultPrevented, target: target.getAttribute('aria-label') };
  }, text);
}

/**
 * roundToUnit(py × (1 + pct/100)) in cents, for a whole-number pct, exactly (BigInt, half away from zero): the
 * grid's `roundToUnit` / `uplift` target, re-derived so the spec checks the server instead of reusing its code.
 */
export function upliftTarget(pyCents: number, pct: number, unit: number): number {
  // py × (100 + pct) is cents × 100; divide by (unit rand in cents) × 100 once, rounding half away from zero.
  const scaled = BigInt(pyCents) * BigInt(100 + pct);
  const step = BigInt(unit * 100 * 100);
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const q = (2n * abs + step) / (2n * step);
  return Number((neg ? -q : q) * BigInt(unit * 100));
}
