/**
 * Read-only rubric steps (master plan wave 4, MW), in the sandbox: M7 row heights in both densities (DG), M8 computed
 * transition durations, T7 the income statement's prior-period column, and NS1's invoice-list controls.
 */
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { longestDurationMs, notBuilt, type Evidence, type StepRecord } from './_rubricEvidence';
import type { Seeded } from './_rubricSeed';

const INVOICES = '/accounting/customer-invoices';
const DENSITY_KEY = 'isaflow.tableDensity';

async function rowHeight(context: BrowserContext, path: string, rows: string, density: 'comfortable' | 'compact'): Promise<number> {
  const page = await context.newPage();
  try {
    await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [DENSITY_KEY, density] as const);
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    const row = page.locator(rows).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(500); // the provider reads the stored density after mount
    return Math.round((await row.boundingBox())!.height * 10) / 10;
  } finally {
    await page.close();
  }
}

/** M7 (and DG): the first data row's height on the invoice list and the bank list, comfortable and compact. */
export async function measureM7(context: BrowserContext, seed: Seeded): Promise<StepRecord> {
  const screens = {
    invoices: { path: INVOICES, rows: 'tbody tr' },
    bankTransactions: { path: `/accounting/bank-transactions?account_id=${seed.bankAccountId}`, rows: '[data-testid="bank-tx-table"] tbody tr' },
  };
  const out: Record<string, { comfortable: number; compact: number }> = {};
  for (const [name, s] of Object.entries(screens)) {
    out[name] = { comfortable: await rowHeight(context, s.path, s.rows, 'comfortable'), compact: await rowHeight(context, s.path, s.rows, 'compact') };
  }
  const compactChangesRows = Object.values(out).some((h) => h.compact < h.comfortable);
  return {
    status: 'measured', rowHeightsPx: out,
    dg: compactChangesRows ? { status: 'measured', compactChangesRows } : notBuilt('DG (density that changes rows) has not merged: compact rows are as tall as comfortable'),
  };
}

/** M8: computed transition-duration on the invoice list's buttons, links and rows; how many are at most 200 ms. */
export async function measureM8(page: Page, ev: Evidence): Promise<StepRecord> {
  await page.goto(INVOICES, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 60_000 });
  const raw = await page.evaluate(() => ['button', 'a', 'tbody tr'].map((sel) => ({
    sel, values: [...document.querySelectorAll(sel)].map((el) => getComputedStyle(el).transitionDuration),
  })));
  const counts = Object.fromEntries(raw.map(({ sel, values }) => {
    const ms = values.map(longestDurationMs);
    return [sel, { elements: ms.length, atMost200ms: ms.filter((v) => v <= 200).length, over200ms: ms.filter((v) => v > 200).length, maxMs: Math.max(0, ...ms) }];
  }));
  return { status: 'measured', page: INVOICES, counts, screenshot: await ev.shot(page, 'm8-invoice-list') };
}

/** T7: tick Prior period on the income statement; time until the comparative column is on screen. */
export async function measureT7(page: Page, ev: Evidence): Promise<StepRecord> {
  await page.goto('/accounting/reports/income-statement', { waitUntil: 'domcontentloaded' });
  const prior = page.getByLabel('Prior period');
  await expect(prior).toBeVisible({ timeout: 60_000 });
  const t0 = Date.now();
  await prior.check();
  const column = page.getByRole('columnheader', { name: /prior|variance/i }).first();
  const shown = await column.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
  return {
    status: 'measured', priorPeriodControl: true, comparativeColumnShown: shown, msToColumn: shown ? Date.now() - t0 : null,
    columnHeader: shown ? (await column.textContent())?.trim() : null, screenshot: await ev.shot(page, 't7-income-statement-prior'),
  };
}

/** NS1 on the invoice list: the status filter on the kit, and a search box with a label of its own (not its placeholder). */
export async function measureNs1List(page: Page): Promise<StepRecord> {
  await page.goto(INVOICES, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 60_000 });
  const nativeStatus = await page.locator('select[aria-label="Status"]').count();
  const searchLabelled = await page.locator('input[name="search"]').first().evaluate((el) =>
    Boolean(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.id && document.querySelector(`label[for="${el.id}"]`))));
  const facts = { nativeStatusSelects: nativeStatus, searchHasOwnLabel: searchLabelled };
  return nativeStatus > 0 || !searchLabelled
    ? notBuilt('NS1 (kit Select on the invoice list, labelled search) has not merged', facts)
    : { status: 'measured', ...facts };
}
