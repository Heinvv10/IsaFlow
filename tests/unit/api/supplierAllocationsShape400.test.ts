/**
 * A malformed allocation amount in POST /api/accounting/supplier-allocations is
 * the caller's mistake: a 400, never a 500.
 *
 * `planSupplierPaymentApplication` totalled the request body (`round2(reduce)`)
 * before any shape check ran, and `round2` is `toCents` - which throws on a
 * non-finite figure - so `amount: "5"` (string concatenation gives "05"), an
 * unparseable string or 1e999 (Infinity) surfaced as a RangeError and a 500.
 * The REAL service runs here (only the auth wrappers, the logger and the
 * database handle are stubbed), because the defect lived in the order of its
 * own first lines.
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

// The payment lock is the service's FIRST act, so in production it is already held when the old arithmetic ran:
// a processed payment with R10 unapplied is what the request reaches.
vi.mock('@/modules/accounting/services/core/paymentLock', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/core/paymentLock')>(
    '@/modules/accounting/services/core/paymentLock',
  );
  return {
    ...actual,
    lockSupplierPaymentForUpdate: vi.fn(async () => ({
      id: '33333333-3333-4333-8333-333333333333', supplier_id: '22222222-2222-4222-8222-222222222222',
      status: 'processed', payment_number: 'PAY0001', total_amount: '10.00', allocated_amount: '0',
    })),
  };
});

import { sql } from '@/lib/neon';
import { planSupplierPaymentApplication } from '@/modules/accounting/services/ap/supplierPaymentApplicationService';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';
import handler from '../../../pages/api/accounting/supplier-allocations';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PAYMENT = '33333333-3333-4333-8333-333333333333';
const BILL = '44444444-4444-4444-8444-444444444444';

const BAD_AMOUNTS: [string, unknown][] = [
  ['the string "5"', '5'],
  ['the string "abc"', 'abc'],
  ['Infinity (JSON 1e999)', Number.POSITIVE_INFINITY],
  ['NaN', Number.NaN],
  ['null', null],
  ['1.005 (not whole cents)', 1.005],
];

// An allocations list whose ITEMS are not objects: `null` was a TypeError at `alloc.amount` (a 500).
const BAD_ITEMS: [string, unknown][] = [
  ['[null]', null],
  ['[5]', 5],
  ['["x"]', 'x'],
  ['[[]]', []],
];

// An item whose `invoiceId` is not a UUID would reach the `::UUID[]` cast in SQL as a raw driver error.
const BAD_INVOICE_IDS: [string, Record<string, unknown>][] = [
  ['missing', { amount: 1 }],
  ['the number 5', { invoiceId: 5, amount: 1 }],
  ['the string "abc"', { invoiceId: 'abc', amount: 1 }],
  ['an array', { invoiceId: [BILL], amount: 1 }],
  ['a UUID with a stray character', { invoiceId: '4444444-4444-4444-8444-4444444444441x', amount: 1 }],
];

function mockReqRes(body: Record<string, unknown>) {
  const req = {
    method: 'POST', query: {}, body, companyId: COMPANY,
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

beforeEach(() => { vi.mocked(sql).mockClear(); });

describe('planSupplierPaymentApplication: request shape before any arithmetic', () => {
  it.each(BAD_AMOUNTS)('refuses %s as a SupplierPaymentRefusal, before touching the database', async (_label, amount) => {
    const allocations = [{ invoiceId: BILL, amount: amount as number }];
    await expect(planSupplierPaymentApplication(COMPANY, PAYMENT, allocations))
      .rejects.toBeInstanceOf(SupplierPaymentRefusal);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('POST /api/accounting/supplier-allocations: a malformed amount', () => {
  it.each(BAD_AMOUNTS)('%s answers 400, not 500, and writes nothing', async (_label, amount) => {
    const { req, res } = mockReqRes({ paymentId: PAYMENT, allocations: [{ invoiceId: BILL, amount }] });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('allocation items that are not objects', () => {
  it.each(BAD_ITEMS)('the service refuses %s as a SupplierPaymentRefusal', async (_label, item) => {
    await expect(planSupplierPaymentApplication(COMPANY, PAYMENT, [item as never]))
      .rejects.toThrow(/Each allocation must be an object/);
    await expect(planSupplierPaymentApplication(COMPANY, PAYMENT, [item as never]))
      .rejects.toBeInstanceOf(SupplierPaymentRefusal);
    expect(sql).not.toHaveBeenCalled();
  });

  it.each(BAD_ITEMS)('the route answers 400 to allocations %s', async (_label, item) => {
    const { req, res } = mockReqRes({ paymentId: PAYMENT, allocations: [item] });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toMatch(/Each allocation must be an object/);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('allocation items with a bad invoiceId', () => {
  it.each(BAD_INVOICE_IDS)('the service refuses an invoiceId that is %s', async (_label, item) => {
    await expect(planSupplierPaymentApplication(COMPANY, PAYMENT, [item as never]))
      .rejects.toBeInstanceOf(SupplierPaymentRefusal);
    await expect(planSupplierPaymentApplication(COMPANY, PAYMENT, [item as never]))
      .rejects.toThrow(/invoiceId that is a UUID/);
    expect(sql).not.toHaveBeenCalled();
  });

  it.each(BAD_INVOICE_IDS)('the route answers 400 to an invoiceId that is %s', async (_label, item) => {
    const { req, res } = mockReqRes({ paymentId: PAYMENT, allocations: [item] });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toMatch(/invoiceId that is a UUID/);
    expect(sql).not.toHaveBeenCalled();
  });

  it('accepts a seeded, non-v4 UUID (the demo ids Zod 4 rejects) as well-formed', async () => {
    const seeded = '00000000-0000-0000-0000-000000000001';
    // Past the shape check it reaches the (stubbed) lock and the bill read, which need a request transaction.
    await expect(planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: seeded, amount: 1 }]))
      .rejects.not.toThrow(/invoiceId that is a UUID/);
  });
});
