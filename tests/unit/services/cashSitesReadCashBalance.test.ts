/**
 * Every cash figure beside a cash-flow statement is `cash.balance.v1`.
 *
 * Six queries summed cash themselves — the AFS KPI's opening and closing cash,
 * the cash-flow reconciliation's bank balance and indirect closing, and the
 * opening cash of the cash-flow report and its CSV export — and each signed an
 * account by its user-set `normal_balance`. A credit-normal petty cash float
 * was summed as NEGATIVE cash, short of `getCashBalance`, of
 * `cashFlowDirectService` and of the balance sheet by twice its balance.
 *
 * They now all read `getCashBalance`, so the definition and its sign live in
 * one place. These tests stand that function in with a known answer and prove
 * each site reports exactly it, on the right date bound: an opening balance is
 * the EXCLUSIVE read (5 300 here), a closing one the inclusive read (5 200).
 * The sign inside `getCashBalance` is run against a real ledger by
 * `tests/integration/k091g-credit-normal-cash-account.int.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

const OPENING = 5300;
const CLOSING = 5200;
const getCashBalanceMock = vi.fn(async (_companyId: string, asAt: string, options?: { exclusive?: boolean }) => ({
  asAt,
  total: options?.exclusive === true ? OPENING : CLOSING,
  accounts: [],
  deactivatedWithBalance: [],
  postedThrough: null,
}));
vi.mock('@/modules/accounting/services/bank/cashBalanceService', () => ({
  getCashBalance: (...a: Parameters<typeof getCashBalanceMock>) => getCashBalanceMock(...a),
}));
vi.mock('@/modules/accounting/services/afs/cashFlowDirectService', () => ({
  getCashFlowDirect: vi.fn(async () => ({ openingCash: OPENING, closingCash: CLOSING })),
}));

import { fetchOpeningCash, fetchClosingCash } from '@/modules/accounting/services/afs/afsKpiCash';
import { getCashFlowReconciliation } from '@/modules/accounting/services/afs/cashFlowReconciliationService';
import reportsCashFlow from '../../../pages/api/accounting/reports-cash-flow';
import cashFlowExport from '../../../pages/api/accounting/cash-flow-export';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const START = '2026-01-01';
const END = '2026-12-31';

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

function call(route: unknown): Promise<{ statusCode: number; body: unknown }> {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    setHeader() { return res; },
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
    send(payload: unknown) { res.body = payload; return res; },
    end() { return res; },
  };
  const req = { method: 'GET', query: { period_start: START, period_end: END }, headers: {}, companyId: COMPANY };
  return (route as Route)(req as unknown as NextApiRequest, res as unknown as NextApiResponse).then(() => res);
}

beforeEach(() => getCashBalanceMock.mockClear());

describe('afsKpiCash reads cash.balance.v1', () => {
  it('opening cash is the exclusive read before the date', async () => {
    expect(await fetchOpeningCash(COMPANY, START)).toBe(OPENING);
    expect(getCashBalanceMock).toHaveBeenCalledWith(COMPANY, START, { exclusive: true });
  });

  it('closing cash is the inclusive read at the date', async () => {
    expect(await fetchClosingCash(COMPANY, END)).toBe(CLOSING);
    expect(getCashBalanceMock).toHaveBeenCalledWith(COMPANY, END);
  });
});

describe('cashFlowReconciliationService reads cash.balance.v1', () => {
  it('states the bank balance and the indirect closing as closing cash at period end', async () => {
    const recon = await getCashFlowReconciliation(COMPANY, START, END);
    expect(recon.bankBalance).toBe(CLOSING);
    expect(recon.indirectClosing).toBe(CLOSING);
    expect(recon.isReconciled).toBe(true);
    expect(getCashBalanceMock.mock.calls.every((c) => c[0] === COMPANY && c[1] === END && c[2] === undefined)).toBe(true);
  });
});

describe('the cash-flow report and its export read cash.balance.v1', () => {
  it('reports-cash-flow states opening cash as the exclusive read at period start', async () => {
    const res = await call(reportsCashFlow);
    expect(res.statusCode).toBe(200);
    expect((res.body as { data: { report: { opening_cash: number } } }).data.report.opening_cash).toBe(OPENING);
    expect(getCashBalanceMock).toHaveBeenCalledWith(COMPANY, START, { exclusive: true });
  });

  it('cash-flow-export prints the same opening cash', async () => {
    const res = await call(cashFlowExport);
    const opening = String(res.body).split('\n').find((l) => l.includes('Opening Balance'));
    expect(opening?.endsWith(`,${OPENING.toFixed(2)}`)).toBe(true);
    expect(getCashBalanceMock).toHaveBeenCalledWith(COMPANY, START, { exclusive: true });
  });
});
