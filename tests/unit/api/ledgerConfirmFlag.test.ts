/**
 * Audit P3.2: the year-end close and the fiscal period close / lock routes refuse
 * (400) unless the body carries `confirm: true` (strict boolean), before any
 * service is called. Reopen is exempt. The year-end `?preview=` GET is a dry run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const svc = vi.hoisted(() => ({
  closeFiscalYear: vi.fn(), listFiscalYears: vi.fn(),
  closePeriod: vi.fn(), lockPeriod: vi.fn(), reopenPeriod: vi.fn(), closeYear: vi.fn(),
  meterCalls: 0,
}));
vi.mock('@/modules/accounting/services/gl/yearEndService', () => ({
  closeFiscalYear: svc.closeFiscalYear, listFiscalYears: svc.listFiscalYears,
}));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  closePeriod: svc.closePeriod, lockPeriod: svc.lockPeriod, reopenPeriod: svc.reopenPeriod, closeYear: svc.closeYear,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withRole: () => (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/billing/withFlowMeter', () => ({
  withFlowMeter: () => (h: (...a: unknown[]) => unknown) => (...a: unknown[]) => { svc.meterCalls += 1; return h(...a); },
  markFlowNoOp: vi.fn(),
}));
vi.mock('@/modules/billing/services/flowOperationCatalog', () => ({ getFlowCost: vi.fn() }));
vi.mock('@/lib/apiJournalDate', () => ({
  JOURNAL_DATE_REFUSED: Symbol('refused'),
  withJournalDateRefusal: async (_res: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@/lib/auth/impersonationGuard', () => ({
  assertNotImpersonating: vi.fn(), respondIfImpersonationForbidden: () => false,
  ImpersonationForbiddenError: class extends Error {},
}));

import yearEnd from '../../../pages/api/accounting/year-end';
import periodsAction from '../../../pages/api/accounting/fiscal-periods-action';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(h: Handler, method: string, body: unknown, query: Record<string, string> = {}) {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; return res; },
    setHeader: vi.fn(),
  } as unknown as NextApiResponse;
  await h({ method, body, query, companyId: 'c1', user: { id: 'u1' } } as unknown as NextApiRequest, res);
  return out;
}

const NOT_CONFIRMED = [undefined, false, 'true', 1, null];

beforeEach(() => { vi.clearAllMocks(); svc.meterCalls = 0; });

describe('POST /api/accounting/year-end needs confirm: true', () => {
  it.each(NOT_CONFIRMED)('confirm=%s is a 400 and never reaches the meter or the service', async (confirm) => {
    const r = await call(yearEnd as Handler, 'POST', { yearLabel: '2026', action: 'close', confirm });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/explicit confirmation/);
    expect(svc.closeFiscalYear).not.toHaveBeenCalled();
    expect(svc.meterCalls).toBe(0);
  });

  it('confirm: true reaches the close', async () => {
    svc.closeFiscalYear.mockResolvedValue({ alreadyClosed: false, netIncome: 0, message: 'ok', closingEntry: null, periodsLockedInYear: 12, unclosedNetIncome: 0 });
    const r = await call(yearEnd as Handler, 'POST', { yearLabel: '2026', action: 'close', confirm: true });
    expect(r.status).toBe(200);
    expect(svc.closeFiscalYear).toHaveBeenCalledWith('c1', '2026', 'u1');
  });
});

describe('GET /api/accounting/year-end?preview=', () => {
  it('runs the close as a dry run and names the Retained Earnings account', async () => {
    svc.closeFiscalYear.mockResolvedValue({
      dryRun: true, alreadyClosed: false, existingEntry: null, netIncome: 1300, unclosedNetIncome: 0,
      preview: {
        entryDate: '2026-02-28', entryNumber: 'YE-2026', description: 'x', totalDebit: 5000, totalCredit: 5000,
        lines: [
          { accountId: 'r', accountCode: '4000', accountName: 'Sales', debit: 5000, credit: 0 },
          { accountId: 'e', accountCode: '5000', accountName: 'Rent', debit: 0, credit: 3700 },
          { accountId: 're', accountCode: '3100', accountName: 'Retained Earnings', debit: 0, credit: 1300 },
        ],
      },
    });
    const r = await call(yearEnd as Handler, 'GET', undefined, { preview: '2026' });
    expect(r.status).toBe(200);
    expect(svc.closeFiscalYear).toHaveBeenCalledWith('c1', '2026', 'u1', { dryRun: true });
    const data = (r.body as { data: Record<string, unknown> }).data;
    expect(data.netIncome).toBe(1300);
    expect(data.retainedEarnings).toEqual({ accountCode: '3100', accountName: 'Retained Earnings' });
  });

  it('a break-even year names no transfer account', async () => {
    svc.closeFiscalYear.mockResolvedValue({
      dryRun: true, alreadyClosed: false, existingEntry: null, netIncome: 0, unclosedNetIncome: 0,
      preview: { entryDate: '2026-02-28', entryNumber: 'YE-2026', description: 'x', totalDebit: 10, totalCredit: 10,
        lines: [
          { accountId: 'r', accountCode: '4000', accountName: 'Sales', debit: 10, credit: 0 },
          { accountId: 'e', accountCode: '5000', accountName: 'Rent', debit: 0, credit: 10 },
        ] },
    });
    const data = ((await call(yearEnd as Handler, 'GET', undefined, { preview: '2026' })).body as { data: Record<string, unknown> }).data;
    expect(data.retainedEarnings).toBeNull();
  });

  it('a typed refusal comes back as a 200 with the sentence the close would give', async () => {
    svc.closeFiscalYear.mockResolvedValue({ error: 'no_retained_earnings' });
    const r = await call(yearEnd as Handler, 'GET', undefined, { preview: '2026' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toMatch(/No Retained Earnings system account is configured/);
  });
});

describe('POST /api/accounting/fiscal-periods-action needs confirm: true', () => {
  const GATED: Array<[string, Record<string, unknown>, () => ReturnType<typeof vi.fn>]> = [
    ['close', { id: 'p1' }, () => svc.closePeriod],
    ['lock', { id: 'p1' }, () => svc.lockPeriod],
    ['bulk_close', { ids: ['p1'] }, () => svc.closePeriod],
    ['bulk_lock', { ids: ['p1'] }, () => svc.lockPeriod],
    ['close_year', { fiscalYear: 2026 }, () => svc.closeYear],
  ];

  describe.each(GATED)('%s', (action, extra, fn) => {
    it.each(NOT_CONFIRMED)('confirm=%s is a 400 and the service is not called', async (confirm) => {
      const r = await call(periodsAction as Handler, 'POST', { action, ...extra, confirm });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(/explicit confirmation/);
      expect(fn()).not.toHaveBeenCalled();
    });

    it('confirm: true reaches the service', async () => {
      fn().mockResolvedValue({ id: 'p1' });
      const r = await call(periodsAction as Handler, 'POST', { action, ...extra, confirm: true });
      expect(r.status).toBe(200);
      expect(fn()).toHaveBeenCalled();
    });
  });

  it.each(['reopen', 'bulk_reopen'])('%s needs no confirmation', async (action) => {
    svc.reopenPeriod.mockResolvedValue({ id: 'p1' });
    const r = await call(periodsAction as Handler, 'POST', action === 'reopen' ? { action, id: 'p1' } : { action, ids: ['p1'] });
    expect(r.status).toBe(200);
    expect(svc.reopenPeriod).toHaveBeenCalled();
  });
});
