/**
 * /api/accounting/bank-transactions-export-all — the request gate in front of
 * the all-accounts bank export: both dates required and real, an ordered range
 * of at most BANK_TX_EXPORT_MAX_DAYS (inclusive), at most
 * BANK_TX_EXPORT_MAX_ROWS rows, and the report rate limit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const getAll = vi.fn();
const rateOk = vi.fn();
vi.mock('@/modules/accounting/services/bank/bankTxExportAll', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/bank/bankTxExportAll')>()),
  getAllBankTransactionsForExport: (...a: unknown[]) => getAll(...a),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: (...a: unknown[]) => rateOk(...a) }));

import handler from '../../../pages/api/accounting/bank-transactions-export-all';
import { BANK_TX_EXPORT_MAX_ROWS } from '@/modules/accounting/services/bank/bankTxExportAll';

interface Res { code: number; body: unknown; headers: Record<string, string> }

async function call(query: Record<string, unknown>, method = 'GET'): Promise<Res> {
  const out: Res = { code: 0, body: undefined, headers: {} };
  const res = {
    status(c: number) { out.code = c; return this; },
    setHeader(k: string, v: string) { out.headers[k] = v; return this; },
    send(b: unknown) { out.body = b; return this; },
    json(b: unknown) { out.body = b; return this; },
    end() { return this; },
  };
  const req = { method, companyId: 'co-1', query };
  await (handler as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<unknown>)(
    req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return out;
}

const row = { transactionDate: '2025-04-02', amount: -5, status: 'imported', bankAccountName: 'ABSA' };

beforeEach(() => {
  getAll.mockReset().mockResolvedValue([row]);
  rateOk.mockReset().mockResolvedValue(true);
});

describe('bank-transactions-export-all request gate', () => {
  it('serves the CSV for a valid range, asking the service for one row past the cap', async () => {
    const r = await call({ from_date: '2025-04-01', to_date: '2025-04-30' });
    expect(r.code).toBe(200);
    expect(r.headers['Content-Type']).toMatch(/text\/csv/);
    expect(r.headers['Content-Disposition']).toContain('bank-transactions-all-2025-04-01-to-2025-04-30.csv');
    expect(String(r.body).split('\n')).toHaveLength(2);
    expect(getAll).toHaveBeenCalledWith('co-1', '2025-04-01', '2025-04-30', BANK_TX_EXPORT_MAX_ROWS + 1);
  });

  it.each([
    ['missing from_date', { to_date: '2025-04-30' }],
    ['missing to_date', { from_date: '2025-04-01' }],
    ['not a real date', { from_date: '2025-02-30', to_date: '2025-04-30' }],
    ['repeated parameter', { from_date: ['2025-04-01', '2025-04-02'], to_date: '2025-04-30' }],
    ['inverted range', { from_date: '2025-04-30', to_date: '2025-04-01' }],
  ])('refuses %s with a 400 and never queries', async (_l, q) => {
    const r = await call(q);
    expect(r.code).toBe(400);
    expect(getAll).not.toHaveBeenCalled();
  });

  it('allows exactly 366 days inclusive and refuses 367', async () => {
    expect((await call({ from_date: '2024-01-01', to_date: '2024-12-31' })).code).toBe(200); // 366 (leap year)
    expect((await call({ from_date: '2024-01-01', to_date: '2025-01-01' })).code).toBe(400); // 367
    expect(getAll).toHaveBeenCalledTimes(1);
  });

  it('refuses a range with more rows than the cap instead of building the file', async () => {
    getAll.mockResolvedValue(Array.from({ length: BANK_TX_EXPORT_MAX_ROWS + 1 }, () => row));
    const r = await call({ from_date: '2025-01-01', to_date: '2025-12-31' });
    expect(r.code).toBe(400);
    expect(JSON.stringify(r.body)).toContain('narrow the date range');
  });

  it('answers 429 when the report rate limit is spent', async () => {
    rateOk.mockResolvedValue(false);
    const r = await call({ from_date: '2025-04-01', to_date: '2025-04-30' });
    expect(r.code).toBe(429);
    expect(getAll).not.toHaveBeenCalled();
  });

  it('refuses a non-GET', async () => {
    expect((await call({}, 'POST')).code).toBe(405);
  });
});
