/**
 * Shared by the budget-tracking-export unit suites: a tracking report built from the real pure
 * modules (lines, bands, projection), a NextApiResponse double, a handler runner, and an RFC 4180
 * CSV reader. The route mocks (auth, error handler, rate limit, engine, company name) stay in each
 * test file: vi.mock is hoisted per file.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { buildTrackingLines, type AccountMeta } from '@/modules/accounting/services/budgets/tracking/trackingLines';
import { buildBands } from '@/modules/accounting/services/budgets/tracking/trackingBands';
import { projectionPlan } from '@/modules/accounting/services/budgets/tracking/trackingProjection';
import type { BudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

export const COMPANY = '11111111-1111-4111-8111-111111111111';
const MONTHS = ['2026-06', '2026-07'];
const meta = (accountId: string, accountCode: string, accountName: string, accountType: 'revenue' | 'expense', accountSubtype: string | null = null): AccountMeta =>
  ({ accountId, accountCode, accountName, accountType, accountSubtype });

export function fixture(): BudgetTrackingReport {
  const accounts = new Map<string, AccountMeta>([
    ['s', meta('s', '4000', 'Sales', 'revenue')],
    ['i', meta('i', '4900', 'Interest', 'revenue', 'other_income')],
    ['c', meta('c', '5000', 'Cost of sales', 'expense', 'cost_of_sales')],
    ['r', meta('r', '6000', '=cmd|calc', 'expense')],
    ['w', meta('w', '6100', 'Wages, "staff"', 'expense')],
  ]);
  const plan = projectionPlan({ fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28' }, '2026-07-31', '2026-10-26');
  const a = (accountId: string, month: string, amount: number) => ({ accountId, month, amount });
  const b = (accountId: string, month: string, amount: number, cls: 'included' | 'coarser' = 'included') => ({ accountId, month, amount, cls });
  const lines = buildTrackingLines({
    accounts, windowMonths: MONTHS, plan,
    actuals: [a('s', '2026-06', 1000.1), a('s', '2026-07', 1234.56), a('i', '2026-06', 12.3), a('c', '2026-07', 400.4), a('r', '2026-06', 300), a('w', '2026-07', 80.08)],
    budgets: [b('s', '2026-06', 900), b('s', '2026-07', 1100), b('c', '2026-06', 500), b('c', '2026-07', 0), b('w', '2026-07', 0), b('r', '2026-06', 250, 'coarser')],
  });
  return {
    window: { period: 'custom', label: '2026-06 to 2026-07', startDate: '2026-06-01', endDate: '2026-07-31', months: MONTHS, fiscalYear: 2027, inProgress: null, postedThrough: '2026-07-31', notStarted: false },
    version: { id: 'v1', name: 'Reforecast 1', kind: 'reforecast', status: 'draft', isPrimary: false },
    filter: {},
    projection: { fiscalYear: 2027, cutoff: plan.cutoff, actualMonths: plan.actualMonths, budgetMonths: plan.budgetMonths },
    lines,
    bands: buildBands(lines),
    notices: { unbudgetedCount: 2, unbudgetedActual: { income: 12.3, expense: 300 }, unallocatedBudget: { income: 0, expense: 250 }, noVersion: false, noVersionYears: [] },
    years: [],
  };
}

export function mockRes() {
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; },
    send(p: unknown) { this.sent = p; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}
/** Runs a route handler (auth, error handler and rate limit mocked by the test file) with this query. */
export async function call(h: (req: NextApiRequest, res: NextApiResponse) => unknown, query: Record<string, unknown>) {
  const res = mockRes();
  await h({ method: 'GET', query, companyId: COMPANY } as unknown as NextApiRequest, res);
  return res;
}

/** RFC 4180 rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows;
}
