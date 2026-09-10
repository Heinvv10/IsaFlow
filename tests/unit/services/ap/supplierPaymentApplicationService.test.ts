// RED phase — written before
// src/modules/accounting/services/ap/supplierPaymentApplicationService.ts exists.
/**
 * supplierPaymentApplicationService — applying a supplier payment that is
 * ALREADY in the ledger to the bills it settles.
 *
 * The AP mirror of `receiptApplicationService`, and it exists for the same
 * reason: "all 17 supplier invoices open while Sage shows all paid, AP
 * overstated R613,642". The mechanism is `allocateTransaction` with
 * `allocType='supplier'`, which posts DR Accounts Payable / CR Bank and then
 * calls `recordPaymentMatch` — and `recordPaymentMatch` sets a
 * `payment_matched` BOOLEAN and never touches `amount_paid` or `status`. So the
 * GL is paid, the flag says matched, and the subledger still shows the bill
 * wholly outstanding.
 *
 * What is pinned here, over and above the AR twin:
 *
 *  - **`payment_allocations` is the live table, not `supplier_payment_allocations`.**
 *    Migration 201's table holds zero rows in dev and production, and every
 *    service writer and reader uses `payment_allocations` —
 *    `processSupplierPayment` reads its allocations from there. The inline SQL
 *    at `pages/api/accounting/supplier-allocations.ts` writes the OTHER one, so
 *    its allocations are invisible to every consumer that matters.
 *  - **A `processed` payment is not moved back to `approved`.** That route sets
 *    the payment's status to `'approved'` on a partial allocation, which is a
 *    processed payment — one whose journal has posted — being walked backwards
 *    through its own state machine.
 *  - `amount_paid` moves by a RELATIVE update; guards all run before the first
 *    write; plan and apply are separate over one set of guards.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// `fetchInvoiceCandidates` / `fetchBillCandidates` refuse to run outside a
// request transaction — their `FOR UPDATE` would be released at the end of its
// own statement and protect nothing. Stand in for the withAuth-bound client so
// the guards under test are exercised, and so the 5s `SET LOCAL lock_timeout`
// is observable.
const { mockTx } = vi.hoisted(() => ({
  mockTx: {
    queries: [] as string[],
    present: true,
    client: { query: (t: string) => { mockTx.queries.push(t); return Promise.resolve(undefined); } },
  },
}));
vi.mock('@/lib/als', async () => {
  const actual = await vi.importActual<typeof import('@/lib/als')>('@/lib/als');
  return {
    ...actual,
    als: {
      ...actual.als,
      getStore: () => (mockTx.present ? { client: mockTx.client } : undefined),
    },
  };
});

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...actual, sql: sqlMock };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/core/paymentLock', () => ({
  lockSupplierPaymentForUpdate: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { lockSupplierPaymentForUpdate } from '@/modules/accounting/services/core/paymentLock';
import {
  planSupplierPaymentApplication,
  applySupplierPaymentPlan,
} from '@/modules/accounting/services/ap/supplierPaymentApplicationService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const SUPPLIER = '22222222-2222-4222-8222-222222222222';
const OTHER_SUPPLIER = '2b222222-2222-4222-8222-222222222222';
const PAYMENT = '33333333-3333-4333-8333-333333333333';
const BILL_A = '44444444-4444-4444-8444-444444444444';
const BILL_B = '55555555-5555-4555-8555-555555555555';
const USER = '99999999-9999-4999-8999-999999999999';

type Row = Record<string, unknown>;
const sqlMock = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<Row[]>>;
const lockMock = lockSupplierPaymentForUpdate as unknown as MockedFunction<
  (c: string, p: string) => Promise<Row | null>
>;

function billRows(rows: Row[]): void {
  sqlMock.mockResolvedValueOnce(rows);
}

function paymentRow(over: Row = {}): Row {
  return {
    id: PAYMENT,
    payment_number: 'PAY0001',
    supplier_id: SUPPLIER,
    total_amount: '1000.00',
    status: 'processed',
    allocated_amount: '0',
    ...over,
  };
}

function billRow(id: string, over: Row = {}): Row {
  return {
    id,
    invoice_number: id === BILL_A ? 'BILL0001' : 'BILL0002',
    supplier_id: SUPPLIER,
    total_amount: '600.00',
    amount_paid: '0',
    status: 'approved',
    already_allocated: '0',
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockTx.queries.length = 0;
  mockTx.present = true;
});

/**
 * The bill read is the check-then-act's read half: `outstandingBefore` comes
 * from it, the over-payment guard is decided from that in `buildLine`, and
 * `amount_paid` is moved much later. Nothing else on the AP path locks the bill
 * — `lockSupplierPaymentForUpdate` protects a payment this request created, and
 * `bankTxLock` a bank LINE, a different row per request. Proven against the
 * real database in `tests/integration/k071-bill-lock-concurrency.int.test.ts`;
 * pinned here so the clause cannot be dropped without a red unit test.
 */
describe('the bill read locks what it is about to decide from', () => {
  it('takes FOR UPDATE OF si in a fixed order, under a 5s lock_timeout', async () => {
    lockMock.mockResolvedValue(paymentRow());
    billRows([billRow(BILL_A)]);
    await planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: BILL_A, amount: 100 }]);

    const read = (sqlMock.mock.calls[0]![0] as string[]).join('?');
    expect(read).toMatch(/FOR UPDATE OF si/);
    // The lock ORDER, without which two requests naming the same pair of bills
    // can take them in opposite sequences and deadlock.
    expect(read).toMatch(/ORDER BY si\.id/);
    expect(mockTx.queries).toContain("SET LOCAL lock_timeout = '5s'");
    // Restored on the success path: SET LOCAL lasts to the end of the
    // TRANSACTION, so the 5s budget would otherwise govern every later lock.
    expect(mockTx.queries).toContain('SET LOCAL lock_timeout = DEFAULT');
  });

  it('turns a lock timeout into a refusal that names the retry', async () => {
    lockMock.mockResolvedValue(paymentRow());
    sqlMock.mockRejectedValueOnce(Object.assign(new Error('canceling statement'), { code: '55P03' }));

    await expect(
      planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: BILL_A, amount: 100 }]),
    ).rejects.toThrow(/retry in a moment/i);
    // NOT restored after a timeout: the transaction is aborted and the reset
    // would itself raise 25P02, replacing the typed refusal with an opaque one.
    expect(mockTx.queries).not.toContain('SET LOCAL lock_timeout = DEFAULT');
  });

  it('refuses to run at all outside a request transaction', async () => {
    lockMock.mockResolvedValue(paymentRow());
    billRows([billRow(BILL_A)]);
    mockTx.present = false;

    // Loud, not silent: outside a transaction the FOR UPDATE is released at the
    // end of its own statement and the SET LOCAL is discarded with it, so the
    // check-then-act would run unprotected and unbounded while looking locked.
    await expect(
      planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: BILL_A, amount: 100 }]),
    ).rejects.toThrow(/requires a request transaction/);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe('planSupplierPaymentApplication', () => {
  it('builds a plan with per-bill before/after and posts no journal', async () => {
    lockMock.mockResolvedValue(paymentRow());
    billRows([billRow(BILL_A), billRow(BILL_B)]);

    const plan = await planSupplierPaymentApplication(COMPANY, PAYMENT, [
      { invoiceId: BILL_A, amount: 600 },
      { invoiceId: BILL_B, amount: 250 },
    ]);

    expect(plan.supplierId).toBe(SUPPLIER);
    expect(plan.unappliedBefore).toBe(1000);
    expect(plan.unappliedAfter).toBe(150);
    expect(plan.lines[0]).toMatchObject({
      invoiceId: BILL_A,
      invoiceNumber: 'BILL0001',
      outstandingAfter: 0,
      statusAfter: 'paid',
    });
    expect(plan.lines[1]).toMatchObject({ outstandingAfter: 350, statusAfter: 'partially_paid' });
    expect(plan.postsJournal).toBe(false);
  });

  it('READS ITS ALLOCATIONS FROM payment_allocations, the live table', async () => {
    // supplier_payment_allocations (migration 201) has zero rows everywhere and
    // is read by nothing. Writing or reading it would make these allocations
    // invisible to processSupplierPayment and to every balance that matters.
    lockMock.mockResolvedValue(paymentRow());
    billRows([billRow(BILL_A)]);
    await planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: BILL_A, amount: 100 }]);

    const text = (sqlMock.mock.calls[0]![0] as string[]).join('?');
    expect(text).toContain('payment_allocations');
    expect(text).not.toContain('supplier_payment_allocations');
  });

  it('KEEPS A PROCESSED PAYMENT PROCESSED on a partial application', async () => {
    // The route this replaces set status to 'approved' on a partial allocation,
    // walking a payment whose journal has already posted backwards through its
    // own state machine.
    lockMock.mockResolvedValue(paymentRow());
    billRows([billRow(BILL_A)]);
    const plan = await planSupplierPaymentApplication(COMPANY, PAYMENT, [
      { invoiceId: BILL_A, amount: 100 },
    ]);
    expect(plan.paymentStatusAfter).toBe('processed');
  });

  it('marks a fully applied payment reconciled', async () => {
    lockMock.mockResolvedValue(paymentRow({ total_amount: '600.00' }));
    billRows([billRow(BILL_A)]);
    const plan = await planSupplierPaymentApplication(COMPANY, PAYMENT, [
      { invoiceId: BILL_A, amount: 600 },
    ]);
    expect(plan.paymentStatusAfter).toBe('reconciled');
  });

  it('refuses a bill belonging to another supplier', async () => {
    lockMock.mockResolvedValue(paymentRow());
    billRows([billRow(BILL_A, { supplier_id: OTHER_SUPPLIER })]);
    await expect(
      planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: BILL_A, amount: 100 }]),
    ).rejects.toThrow(/different supplier/i);
  });

  it('refuses a payment that is not in this company', async () => {
    lockMock.mockResolvedValue(null);
    await expect(
      planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: BILL_A, amount: 100 }]),
    ).rejects.toThrow(/not found/i);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('refuses a payment whose journal has not posted yet, naming the fix', async () => {
    for (const status of ['draft', 'approved']) {
      vi.resetAllMocks();
      lockMock.mockResolvedValue(paymentRow({ status }));
      await expect(
        planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: BILL_A, amount: 100 }]),
      ).rejects.toThrow(/has not been processed/i);
    }
  });

  it('refuses a cancelled payment', async () => {
    lockMock.mockResolvedValue(paymentRow({ status: 'cancelled' }));
    await expect(
      planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: BILL_A, amount: 100 }]),
    ).rejects.toThrow(/cancelled/i);
  });

  it('refuses when the allocations exceed the unapplied remainder', async () => {
    lockMock.mockResolvedValue(paymentRow({ allocated_amount: '900.00' }));
    billRows([billRow(BILL_A)]);
    await expect(
      planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: BILL_A, amount: 200 }]),
    ).rejects.toThrow(/unapplied/i);
  });

  it('refuses when one amount exceeds that bill outstanding', async () => {
    lockMock.mockResolvedValue(paymentRow());
    billRows([billRow(BILL_A, { amount_paid: '550.00' })]);
    await expect(
      planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: BILL_A, amount: 100 }]),
    ).rejects.toThrow(/outstanding/i);
  });

  it('refuses a duplicate bill before any query runs', async () => {
    lockMock.mockResolvedValue(paymentRow());
    await expect(
      planSupplierPaymentApplication(COMPANY, PAYMENT, [
        { invoiceId: BILL_A, amount: 100 },
        { invoiceId: BILL_A, amount: 100 },
      ]),
    ).rejects.toThrow(/more than once/i);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('refuses a bill this payment is already allocated against', async () => {
    lockMock.mockResolvedValue(paymentRow());
    billRows([billRow(BILL_A, { already_allocated: '50.00' })]);
    await expect(
      planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: BILL_A, amount: 100 }]),
    ).rejects.toThrow(/already allocated/i);
  });

  it('refuses a bill not in this company as not found', async () => {
    lockMock.mockResolvedValue(paymentRow());
    billRows([]);
    await expect(
      planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: BILL_A, amount: 100 }]),
    ).rejects.toThrow(/not found/i);
  });

  it('scopes the bill query to the company', async () => {
    lockMock.mockResolvedValue(paymentRow());
    billRows([billRow(BILL_A)]);
    await planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: BILL_A, amount: 100 }]);
    expect(sqlMock.mock.calls[0]!.slice(1)).toContain(COMPANY);
  });

  it('writes nothing while only planning', async () => {
    lockMock.mockResolvedValue(paymentRow());
    billRows([billRow(BILL_A)]);
    await planSupplierPaymentApplication(COMPANY, PAYMENT, [{ invoiceId: BILL_A, amount: 100 }]);
    // Anchored on the WRITE forms: the bill read now takes `FOR UPDATE OF si`,
    // which a bare /UPDATE/ matches although it writes nothing. `\s+` between
    // the table and SET because every UPDATE here breaks the line there — a
    // literal space matches none of them and the guard would pass on the
    // `amount_paid` move it exists to catch.
    const texts = sqlMock.mock.calls.map((c) => (c[0] as string[]).join('?'));
    expect(texts.some((t) => /INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/.test(t))).toBe(false);
  });
});

describe('applySupplierPaymentPlan', () => {
  async function plannedFor(amount: number) {
    lockMock.mockResolvedValue(paymentRow());
    billRows([billRow(BILL_A)]);
    const plan = await planSupplierPaymentApplication(COMPANY, PAYMENT, [
      { invoiceId: BILL_A, amount },
    ]);
    sqlMock.mockResolvedValue([]);
    return plan;
  }

  it('moves amount_paid by a RELATIVE update, never an absolute one', async () => {
    const plan = await plannedFor(600);
    await applySupplierPaymentPlan(COMPANY, plan, USER);

    const updates = sqlMock.mock.calls
      .map((c) => (c[0] as string[]).join('?'))
      .filter((t) => t.includes('UPDATE supplier_invoices'));
    // TWO now: the money write, then recomputeInvoiceStatus deriving status,
    // paid_at and payment_matched from the balance it left. Asserted as exactly
    // two — a third would mean a writer crept back in.
    expect(updates).toHaveLength(2);

    const moneyWrites = updates.filter((t) => /amount_paid\s*=/.test(t));
    expect(moneyWrites).toHaveLength(1);
    expect(moneyWrites[0]).toMatch(/amount_paid\s*=\s*COALESCE\(amount_paid,\s*0\)\s*\+/);
    // NO statement may write it absolutely, not merely the one we picked.
    for (const t of updates) expect(t).not.toMatch(/SET\s+amount_paid\s*=\s*\?/);
    // The money write no longer carries the settlement rule with it.
    expect(moneyWrites[0]).not.toMatch(/payment_matched/);
    expect(moneyWrites[0]).not.toMatch(/status\s*=/);
  });

  it('DERIVES payment_matched from the settlement, so a wrongly-set flag is CORRECTED', async () => {
    // allocateTransaction calls recordPaymentMatch with the FULL bank-line
    // amount against the FIRST named invoice, so a R1000 line allocating R300
    // to a R600 bill flags that bill matched before this ever runs. Preserving
    // the existing flag would keep that lie; deriving it from the settlement
    // state overwrites it. The flag must be an assignment, not a CASE that only
    // ever sets TRUE.
    const plan = await plannedFor(300);
    await applySupplierPaymentPlan(COMPANY, plan, USER);
    // Now written by recomputeInvoiceStatus, so look for the statement that
    // carries the flag rather than assuming it is the first one.
    const update = sqlMock.mock.calls
      .map((c) => (c[0] as string[]).join('?'))
      .find((t) => t.includes('UPDATE supplier_invoices') && t.includes('payment_matched'))!;
    expect(update).toBeDefined();
    expect(update).toMatch(/payment_matched\s*=\s*\(/);
    expect(update).not.toMatch(/payment_matched\s*=\s*CASE[\s\S]*ELSE payment_matched/);
    // And it clears the timestamp when the flag goes false, so a stale stamp
    // cannot outlive its claim.
    expect(update).toMatch(/payment_matched_at = CASE[\s\S]*ELSE NULL/);
  });

  it('SETS payment_matched when the bill is fully settled', async () => {
    // The flag is the only thing the bank-allocation path used to set, and the
    // four-way-match screen reads it. Leaving it behind while amount_paid moves
    // reproduces the same split between GL and subledger from the other side.
    const plan = await plannedFor(600);
    await applySupplierPaymentPlan(COMPANY, plan, USER);
    const updates = sqlMock.mock.calls
      .map((c) => (c[0] as string[]).join('?'))
      .filter((t) => t.includes('UPDATE supplier_invoices'));
    // Exactly one of the two statements owns the flag — not zero (the bug this
    // guards) and not both (two writers again).
    expect(updates.filter((t) => t.includes('payment_matched'))).toHaveLength(1);
  });

  it('WRITES payment_allocations, never supplier_payment_allocations', async () => {
    const plan = await plannedFor(600);
    await applySupplierPaymentPlan(COMPANY, plan, USER);
    const inserts = sqlMock.mock.calls
      .map((c) => (c[0] as string[]).join('?'))
      .filter((t) => t.includes('INSERT INTO'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain('INSERT INTO payment_allocations');
    expect(inserts[0]).not.toContain('supplier_payment_allocations');
  });

  it('scopes every write to the company', async () => {
    const plan = await plannedFor(600);
    await applySupplierPaymentPlan(COMPANY, plan, USER);
    for (const call of sqlMock.mock.calls) {
      const text = (call[0] as string[]).join('?');
      if (text.includes('UPDATE supplier_invoices') || text.includes('UPDATE supplier_payments')) {
        expect(call.slice(1)).toContain(COMPANY);
      }
    }
  });
});
