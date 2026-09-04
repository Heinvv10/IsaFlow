/**
 * The disclosure as it reaches a CSV file and an XLSX workbook.
 *
 * These are the surfaces that leave the app. 82 lines of export code shipped
 * with no test of any kind — the reason-label map, the autoFilter-avoidance
 * layout, the number formats, and `csvVal` quoting of sentences that contain
 * commas. A caveat that is malformed in the file is worse than no caveat,
 * because the file is what a client reads.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (h: unknown) => h }));
vi.mock('@/modules/billing/services/flowOperationCatalog', () => ({ getFlowCost: () => 0 }));

import csvHandler from '@/../pages/api/accounting/income-statement-export';

const glRow = (
  code: string, name: string, type: 'revenue' | 'expense',
  subtype: string | null, debit: number, credit: number,
) => ({
  account_code: code, account_name: name, account_type: type,
  account_subtype: subtype, total_debit: debit, total_credit: credit,
});

/** Brightsphere's shape: 100% margin, an unclassified CoGS, other income in turnover. */
const BRIGHTSPHERE = [
  glRow('5001', 'Cost of Goods Sold', 'expense', 'default_expense', 574253.66, 0),
  glRow('4001', 'Product Sales', 'revenue', 'default_revenue', 0, 12410997.9),
  glRow('35541892', 'Vehicle Rent Income, Ltd', 'revenue', 'other_income', 0, 23323.42),
];

function fakeRes() {
  const headers: Record<string, string> = {};
  let body = '';
  let status = 0;
  const res = {
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status: (c: number) => { status = c; return res; },
    send: (b: string) => { body = b; return res; },
    json: (b: unknown) => { body = JSON.stringify(b); return res; },
  } as unknown as NextApiResponse;
  return { res, get body() { return body; }, get status() { return status; }, headers };
}

const req = {
  method: 'GET',
  query: { period_start: '2026-01-01', period_end: '2026-12-31' },
  companyId: 'c-1',
} as unknown as NextApiRequest;

beforeEach(() => sqlMock.mockReset());

describe('CSV export — the disclosure travels with the figures', () => {
  it('emits the warning rows after the margin rows they qualify', async () => {
    sqlMock.mockResolvedValue(BRIGHTSPHERE);
    const out = fakeRes();
    await (csvHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, out.res);

    const lines = out.body.split('\n');
    const marginIdx = lines.findIndex(l => l.includes('Gross Margin %'));
    const warnIdx = lines.findIndex(l => l.includes('overstated by at least'));
    expect(marginIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(marginIdx);
  });

  it('states both ceilings, never their sum', async () => {
    sqlMock.mockResolvedValue(BRIGHTSPHERE);
    const out = fakeRes();
    await (csvHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, out.res);

    expect(out.body).toContain('Expense that could be cost of sales (at most)');
    expect(out.body).toContain('Revenue that could be other income (at most)');
    expect(out.body).toContain('574253.66');
    expect(out.body).toContain('12410997.90');
  });

  it('keeps every row at the header column count, even sentences full of commas', async () => {
    sqlMock.mockResolvedValue(BRIGHTSPHERE);
    const out = fakeRes();
    await (csvHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, out.res);

    // Count top-level commas, ignoring anything inside a quoted field.
    const topLevelCommas = (line: string): number => {
      let inQuotes = false, n = 0;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === ',' && !inQuotes) n++;
      }
      return n;
    };
    const rows = out.body.split('\n').filter(l => l.trim().length > 0);
    const header = rows.find(l => l.startsWith('Section')) ?? rows[0]!;
    const width = topLevelCommas(header);
    for (const r of rows.slice(rows.indexOf(header) + 1)) {
      expect(topLevelCommas(r), r.slice(0, 80)).toBe(width);
    }
  });

  it('renders a human reason, not the raw enum', async () => {
    sqlMock.mockResolvedValue(BRIGHTSPHERE);
    const out = fakeRes();
    await (csvHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, out.res);

    expect(out.body).toContain('nobody classified it');
    expect(out.body).not.toContain('platform_default');
    expect(out.body).not.toContain('other_income_in_turnover');
    expect(out.body).not.toContain('undefined');
  });

  it('neutralises a leading formula character in an account name', async () => {
    sqlMock.mockResolvedValue([
      glRow('X', '=cmd|calc!A1', 'expense', null, 1000, 0),
      glRow('4000', 'Sales', 'revenue', 'revenue', 0, 5000),
    ]);
    const out = fakeRes();
    await (csvHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, out.res);
    // The escaper must not emit a cell a spreadsheet will execute.
    expect(out.body).not.toMatch(/(^|,)"?=cmd/m);
  });

  it('says the amounts are repeated elsewhere, so a column sum is not doubled', async () => {
    sqlMock.mockResolvedValue(BRIGHTSPHERE);
    const out = fakeRes();
    await (csvHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, out.res);
    expect(out.body).toMatch(/repeated elsewhere in this file/);
  });

  it('writes no warning rows for a fully classified chart', async () => {
    sqlMock.mockResolvedValue([
      glRow('5000', 'Direct Material', 'expense', 'cost_of_sales', 1000, 0),
      glRow('4000', 'Sales', 'revenue', 'revenue', 0, 5000),
    ]);
    const out = fakeRes();
    await (csvHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, out.res);
    expect(out.body).not.toContain('Warning');
    expect(out.body).toContain('Gross Margin %');
  });
});
