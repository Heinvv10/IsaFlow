/**
 * #1670 breaker r12: each route's own Approve gate, pinned independently of the census (whose markers used to exempt some of these
 * calls). A person without the module's Approve is refused 403 before the route reads or writes anything (`sql` never runs) and its
 * sink never runs; the gate asks the right module. With the Approve, the route goes on to the sink.
 *   finalise a return (the form's module) · reverse a payment batch (Suppliers) · book ETI (Payroll) · lock a VAT period (VAT: it
 *   records the filed return, H1) · mark a UIF declaration submitted (Payroll, M2) · send an EFT batch to Netcash (Suppliers, L2) ·
 *   amend a return (the form's module, r13 M1)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const allowed = vi.hoisted(() => new Set<string>());
const sink = vi.hoisted(() => ({
  finaliseReturn: vi.fn(async () => ({ version: { id: 'v' }, vatReturn: null })),
  reverseBatch: vi.fn(async () => ({ reversalJournalId: 'j' })),
  bookEtiForMonthLocked: vi.fn(async () => ({ booked: true })),
  lockVatPeriod: vi.fn(async () => ({ lock: { id: 'l' }, created: true })),
  markUifSubmitted: vi.fn(async () => ({ id: 'u', status: 'submitted' })),
  amendReturn: vi.fn(async () => ({ id: 'v2', figures: {} })),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/permissionService', async (orig) => ({
  ...(await orig<object>()),
  checkPermission: vi.fn(async (_c: string, _u: string, module: string, action: string) => allowed.has(`${module}:${action}`)),
}));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h, withRole: () => (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withPayrollModule', () => ({ withPayrollModule: (h: unknown) => h }));
vi.mock('@/lib/auth/withPayrollDetailAccess', () => ({ withPayrollDetailAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true), INTERACTIVE_REPORT_LIMIT: 10 }));
vi.mock('@/lib/auth/impersonationGuard', async (orig) => ({ ...(await orig<object>()), assertNotImpersonating: vi.fn(async () => undefined) }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: (_n: string, fn: () => unknown) => fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/apiJournalDate', async (orig) => ({ ...(await orig<object>()), withJournalDateRefusal: async (_r: unknown, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/returns/finaliseReturn', async (orig) => ({ ...(await orig<object>()), finaliseReturn: sink.finaliseReturn }));
vi.mock('@/modules/accounting/services/ap/batchPaymentReversal', async (orig) => ({ ...(await orig<object>()), reverseBatch: sink.reverseBatch }));
vi.mock('@/modules/accounting/services/payroll/etiRebook', () => ({ bookEtiForMonthLocked: sink.bookEtiForMonthLocked }));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockService', async (orig) => ({ ...(await orig<object>()), lockVatPeriod: sink.lockVatPeriod }));
vi.mock('@/modules/accounting/services/reports/vatGateOverrideService', async (orig) => ({ ...(await orig<object>()), assertVatGateClear: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/returns/amendReturn', () => ({ amendReturn: sink.amendReturn }));
vi.mock('@/modules/accounting/services/payroll/uifDeclarationService', async (orig) => ({ ...(await orig<object>()), markUifSubmitted: sink.markUifSubmitted }));

import { sql } from '@/lib/neon';
import { checkPermission } from '@/lib/auth/permissionService';
import finaliseRoute from '../../../pages/api/accounting/sars/returns/[form]/finalise';
import batchRoute from '../../../pages/api/accounting/batch-payments-action';
import etiRoute from '../../../pages/api/accounting/sars/emp201-book-eti';
import vatLockRoute from '../../../pages/api/accounting/vat-period-locks';
import uifRoute from '../../../pages/api/payroll/uif/[id]';
import netcashRoute from '../../../pages/api/accounting/netcash/submit';
import amendRoute from '../../../pages/api/accounting/sars/returns/[form]/amend';
import emp501Route from '../../../pages/api/payroll/emp501/returns/index';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
const ID = '66666666-6666-4666-8666-666666666666';
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(handler: unknown, method: string, body: unknown, query: Record<string, string> = {}) {
  const req = { method, query, body, headers: {}, companyId: C, companyRole: 'manager', user: { id: U, email: 'u@x' } } as unknown as NextApiRequest;
  const res = {
    statusCode: 200, sent: undefined as unknown,
    setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; }, send(p: unknown) { this.sent = p; return this; }, end() { return this; },
  };
  await (handler as Handler)(req, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => {
  allowed.clear();
  vi.clearAllMocks();
  vi.mocked(checkPermission).mockReset().mockImplementation(async (_c, _u, module, action) => allowed.has(`${module}:${action}`));
});

const ROUTES = [
  ['finalise a VAT201', finaliseRoute, 'POST', { periodStart: '2026-01-01', periodEnd: '2026-02-28' }, { form: 'vat201' }, 'vat', sink.finaliseReturn],
  ['finalise an EMP201', finaliseRoute, 'POST', { periodStart: '2026-01-01', periodEnd: '2026-01-31' }, { form: 'emp201' }, 'payroll', sink.finaliseReturn],
  ['reverse a payment batch', batchRoute, 'POST', { action: 'reverse', id: ID }, {}, 'suppliers', sink.reverseBatch],
  ['book ETI for a month', etiRoute, 'POST', { month: '2026-01' }, {}, 'payroll', sink.bookEtiForMonthLocked],
  ['lock a VAT period (H1)', vatLockRoute, 'POST', { action: 'lock', periodStart: '2026-01-01', periodEnd: '2026-02-28', force: true }, {}, 'vat', sink.lockVatPeriod],
  ['mark a UIF declaration submitted (M2)', uifRoute, 'PATCH', { markSubmitted: true }, { id: ID }, 'payroll', sink.markUifSubmitted],
  ['amend a VAT201 (r13 M1)', amendRoute, 'POST', { versionId: ID, reason: 'r' }, { form: 'vat201' }, 'vat', sink.amendReturn],
  ['amend an EMP201 (r13 M1)', amendRoute, 'POST', { versionId: ID, reason: 'r' }, { form: 'emp201' }, 'payroll', sink.amendReturn],
  ['amend an EMP501 (r13 M1)', emp501Route, 'POST', { action: 'amend', versionId: ID, reason: 'r' }, {}, 'payroll', sink.amendReturn],
] as const;

describe('#1670 r12: each route refuses a person without the module Approve, before any read or write', () => {
  it.each(ROUTES)('%s: 403, sql never runs, the sink never runs; it asks %s Approve', async (_n, route, method, body, query, module, fn) => {
    const r = await call(route, method, body, query);
    expect(r.statusCode, JSON.stringify(r.sent)).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(C, U, module, 'approve');
    expect(sql).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s: with the Approve it reaches the sink', async (_n, route, method, body, query, module, fn) => {
    allowed.add(`${module}:approve`);
    await call(route, method, body, query).catch(() => undefined); // later steps may refuse on the mocked data; the gate is passed
    expect(fn).toHaveBeenCalled();
  });

  it('send an EFT batch to Netcash (L2): 403 without Suppliers Approve, before the company or the batch is read', async () => {
    const r = await call(netcashRoute, 'POST', { batchPaymentId: ID });
    expect(r.statusCode, JSON.stringify(r.sent)).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(C, U, 'suppliers', 'approve');
    expect(sql).not.toHaveBeenCalled();
    allowed.add('suppliers:approve');
    await call(netcashRoute, 'POST', { batchPaymentId: ID }).catch(() => undefined);
    expect(sql).toHaveBeenCalled(); // past the gate: the company's Netcash settings are read
  });
});
