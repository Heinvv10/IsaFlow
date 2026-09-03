/**
 * POST /api/accounting/supplier-allocations must not COMMIT allocations it is
 * about to report as a failure, and must write the LIVE table.
 *
 * This route was never wired to a service. It validated each invoice INSIDE the
 * write loop and returned `badRequest` from within it — and `withAuth` decides
 * COMMIT vs ROLLBACK on `res.statusCode >= 500`, so a 4xx COMMITS. A three-line
 * request failing on line three committed lines one and two and reported
 * failure.
 *
 * It also wrote migration 201's `supplier_payment_allocations`, which holds
 * zero rows in dev and production and is read by nothing —
 * `processSupplierPayment`, `voidSupplierPayment` and `batchPaymentService` all
 * use `payment_allocations` — so every allocation it made was invisible to the
 * balances that matter.
 *
 * Same rule as the AR twin and the chart-of-accounts PUT: only PRE-WRITE
 * validation may become a 400; anything after the first write must propagate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(async () => []), { transaction: vi.fn() });
  return { ...actual, sql: sqlMock };
});
vi.mock('@/modules/accounting/services/ap/supplierPaymentApplicationService', () => ({
  planSupplierPaymentApplication: vi.fn(),
  applySupplierPaymentPlan: vi.fn(),
}));

import { sql } from '@/lib/neon';
import {
  planSupplierPaymentApplication,
  applySupplierPaymentPlan,
} from '@/modules/accounting/services/ap/supplierPaymentApplicationService';
import handler from '../../../pages/api/accounting/supplier-allocations';

const PAYMENT = '33333333-3333-4333-8333-333333333333';
const BILL = '44444444-4444-4444-8444-444444444444';

function mockReqRes(method: string, body: Record<string, unknown>, query: Record<string, string> = {}) {
  const req = {
    method, query, body,
    companyId: '11111111-1111-4111-8111-111111111111',
    user: { id: '99999999-9999-4999-8999-999999999999' },
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

const PLAN = {
  paymentId: PAYMENT,
  paymentNumber: 'PAY0001',
  supplierId: '22222222-2222-4222-8222-222222222222',
  paymentTotal: 1000,
  allocatedBefore: 0,
  allocatedAfter: 600,
  unappliedBefore: 1000,
  unappliedAfter: 400,
  paymentStatusBefore: 'processed',
  paymentStatusAfter: 'processed',
  lines: [{
    invoiceId: BILL, invoiceNumber: 'BILL0001', amount: 600,
    outstandingBefore: 600, outstandingAfter: 0,
    statusBefore: 'approved', statusAfter: 'paid', fullySettled: true,
  }],
  postsJournal: false as const,
};

const BODY = { paymentId: PAYMENT, allocations: [{ invoiceId: BILL, amount: 600 }] };

beforeEach(() => { vi.resetAllMocks(); });

describe('POST /api/accounting/supplier-allocations', () => {
  it('A PRE-WRITE REFUSAL IS A 400 and never reaches the apply', async () => {
    vi.mocked(planSupplierPaymentApplication).mockRejectedValue(
      new Error('Invoice BILL0001 belongs to a different supplier than this payment.'),
    );
    const { req, res } = mockReqRes('POST', BODY);
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toMatch(/different supplier/i);
    expect(applySupplierPaymentPlan).not.toHaveBeenCalled();
  });

  it('A POST-WRITE FAILURE PROPAGATES — it must not become a 400', async () => {
    vi.mocked(planSupplierPaymentApplication).mockResolvedValue(PLAN);
    vi.mocked(applySupplierPaymentPlan).mockRejectedValue(new Error('deadlock detected'));
    const { req, res } = mockReqRes('POST', BODY);
    await expect(handler(req, res)).rejects.toThrow(/deadlock/);
    expect(res.statusCode).not.toBe(400);
  });

  it('KEEPS A PROCESSED PAYMENT PROCESSED — it does not walk it back to approved', async () => {
    vi.mocked(planSupplierPaymentApplication).mockResolvedValue(PLAN);
    vi.mocked(applySupplierPaymentPlan).mockResolvedValue(PLAN);
    const { req, res } = mockReqRes('POST', BODY);
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect((res.sent as { data?: Record<string, unknown> }).data?.paymentStatus ?? (res.sent as Record<string, unknown>).paymentStatus)
      .not.toBe('approved');
  });

  it('goes through the service — no inline SQL writes the allocation', async () => {
    vi.mocked(planSupplierPaymentApplication).mockResolvedValue(PLAN);
    vi.mocked(applySupplierPaymentPlan).mockResolvedValue(PLAN);
    const { req, res } = mockReqRes('POST', BODY);
    await handler(req, res);
    const sqlMock = sql as unknown as { mock: { calls: unknown[][] } };
    const writes = sqlMock.mock.calls
      .map((c) => (c[0] as string[]).join('?'))
      .filter((t) => /INSERT|UPDATE/i.test(t));
    expect(writes).toEqual([]);
    expect(applySupplierPaymentPlan).toHaveBeenCalledTimes(1);
  });

  it('still refuses a malformed body before touching anything', async () => {
    for (const body of [{}, { paymentId: PAYMENT }, { paymentId: PAYMENT, allocations: [] }]) {
      const { req, res } = mockReqRes('POST', body);
      await handler(req, res);
      expect(res.statusCode).toBe(400);
    }
    expect(planSupplierPaymentApplication).not.toHaveBeenCalled();
  });
});

describe('GET /api/accounting/supplier-allocations', () => {
  it('READS payment_allocations, the live table — not the empty migration-201 one', async () => {
    const { req, res } = mockReqRes('GET', {}, { payment_id: PAYMENT });
    await handler(req, res);
    const sqlMock = sql as unknown as { mock: { calls: unknown[][] } };
    const text = (sqlMock.mock.calls[0]![0] as string[]).join('?');
    expect(text).toContain('FROM payment_allocations');
    expect(text).not.toContain('FROM supplier_payment_allocations');
  });

  it('scopes the listing to the company', async () => {
    const { req, res } = mockReqRes('GET', {}, {});
    await handler(req, res);
    const sqlMock = sql as unknown as { mock: { calls: unknown[][] } };
    expect(sqlMock.mock.calls[0]!.slice(1)).toContain('11111111-1111-4111-8111-111111111111');
  });
});
