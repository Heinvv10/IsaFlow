// RED phase — written before src/modules/accounting/services/ar/receiptApplicationService.ts exists.
/**
 * receiptApplicationService — applying cash that is ALREADY in the ledger to
 * the invoices it settles.
 *
 * This is the operation behind R2.45m of unapplied receipts. `allocateTransaction`
 * with allocType='customer' posts DR Bank / CR AR and inserts a CONFIRMED
 * `customer_payments` row, and then writes no `customer_payment_allocations` and
 * never touches `customer_invoices.amount_paid`. The cash is on the control
 * account and no document knows about it, so aged debtors lists the invoice
 * forever.
 *
 * What is pinned here, and why each one is a bug that already shipped in the
 * inline SQL at `pages/api/accounting/customer-allocations.ts`:
 *
 *  - **The counterparty check must use COALESCE(client_id, customer_id).** The
 *    route compares `invoice.client_id !== payment.client_id`. `customer_invoices`
 *    carries BOTH columns, and an invoice populated on `customer_id` alone has
 *    `client_id` NULL — so the comparison is false for every such invoice and
 *    the route refuses to allocate it AT ALL. That is not a cosmetic mismatch:
 *    it is a plausible reason the receipts never got applied in the first place.
 *  - **`amount_paid` moves by a relative UPDATE, never an absolute one.** The
 *    route reads `amount_paid`, adds in JS, and writes the result back. Two
 *    allocations landing together both read the same value and the second
 *    silently erases the first.
 *  - **Every guard runs before the first write.** The route returns
 *    `badRequest` from inside its per-invoice loop, and `withAuth` COMMITs on
 *    anything under 500 — so a three-line request that fails on line three
 *    commits lines one and two and reports failure.
 *  - **Planning and applying are separate functions over one set of guards**,
 *    so a dry run cannot pass where the live call would refuse.
 *  - The plan posts NO journal. The cash is already on the control account;
 *    posting again would double the bank.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...actual, sql: sqlMock };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/core/paymentLock', () => ({
  lockCustomerPaymentForUpdate: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { lockCustomerPaymentForUpdate } from '@/modules/accounting/services/core/paymentLock';
import {
  planReceiptApplication,
  applyReceiptPlan,
} from '@/modules/accounting/services/ar/receiptApplicationService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const OTHER_CUSTOMER = '2b222222-2222-4222-8222-222222222222';
const PAYMENT = '33333333-3333-4333-8333-333333333333';
const INV_A = '44444444-4444-4444-8444-444444444444';
const INV_B = '55555555-5555-4555-8555-555555555555';
const USER = '99999999-9999-4999-8999-999999999999';

type Row = Record<string, unknown>;
const sqlMock = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<Row[]>>;
const lockMock = lockCustomerPaymentForUpdate as unknown as MockedFunction<
  (c: string, p: string) => Promise<Row | null>
>;

/** The single query the planner runs after the lock: the candidate invoices. */
function invoiceRows(rows: Row[]): void {
  sqlMock.mockResolvedValueOnce(rows);
}

function paymentRow(over: Row = {}): Row {
  return {
    id: PAYMENT,
    payment_number: 'RCP0001',
    client_id: CUSTOMER,
    total_amount: '1000.00',
    status: 'confirmed',
    allocated_amount: '0',
    ...over,
  };
}

/**
 * Shaped as the service's own projection, not as the raw table: the query
 * resolves the counterparty with `COALESCE(ci.client_id, ci.customer_id)` and
 * hands back one `owner_id`. That the COALESCE is actually there is asserted
 * against the query TEXT below — a mocked `sql` cannot evaluate it.
 */
function invoiceRow(id: string, over: Row = {}): Row {
  return {
    id,
    invoice_number: id === INV_A ? 'INV0001' : 'INV0002',
    owner_id: CUSTOMER,
    total_amount: '600.00',
    amount_paid: '0',
    status: 'approved',
    already_allocated: '0',
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('planReceiptApplication', () => {
  it('builds a plan with per-invoice before/after and posts no journal', async () => {
    lockMock.mockResolvedValue(paymentRow());
    invoiceRows([invoiceRow(INV_A), invoiceRow(INV_B)]);

    const plan = await planReceiptApplication(COMPANY, PAYMENT, [
      { invoiceId: INV_A, amount: 600 },
      { invoiceId: INV_B, amount: 250 },
    ]);

    expect(plan.paymentId).toBe(PAYMENT);
    expect(plan.customerId).toBe(CUSTOMER);
    expect(plan.paymentTotal).toBe(1000);
    expect(plan.unappliedBefore).toBe(1000);
    expect(plan.unappliedAfter).toBe(150);
    expect(plan.lines).toHaveLength(2);
    expect(plan.lines[0]).toMatchObject({
      invoiceId: INV_A,
      invoiceNumber: 'INV0001',
      amount: 600,
      outstandingBefore: 600,
      outstandingAfter: 0,
      statusAfter: 'paid',
    });
    expect(plan.lines[1]).toMatchObject({
      invoiceId: INV_B,
      amount: 250,
      outstandingAfter: 350,
      statusAfter: 'partially_paid',
    });
    // The cash is already on the control account.
    expect(plan.postsJournal).toBe(false);
  });

  it('RESOLVES THE COUNTERPARTY WITH COALESCE(client_id, customer_id)', async () => {
    // The route this replaces compares `invoice.client_id !== payment.client_id`.
    // `customer_invoices` carries both columns and an invoice populated on
    // `customer_id` alone has `client_id` NULL, so that comparison refuses every
    // such invoice. Asserted against the query text because a mocked `sql`
    // cannot evaluate SQL: drop the COALESCE and this goes red.
    lockMock.mockResolvedValue(paymentRow());
    invoiceRows([invoiceRow(INV_A)]);

    await planReceiptApplication(COMPANY, PAYMENT, [{ invoiceId: INV_A, amount: 600 }]);

    const text = (sqlMock.mock.calls[0]![0] as string[]).join('?');
    expect(text).toMatch(/COALESCE\(ci\.client_id,\s*ci\.customer_id\)\s+AS\s+owner_id/);
  });

  it('refuses an invoice belonging to another customer', async () => {
    lockMock.mockResolvedValue(paymentRow());
    invoiceRows([invoiceRow(INV_A, { owner_id: OTHER_CUSTOMER })]);

    await expect(
      planReceiptApplication(COMPANY, PAYMENT, [{ invoiceId: INV_A, amount: 100 }]),
    ).rejects.toThrow(/different customer/i);
  });

  it('refuses when the payment is not in this company', async () => {
    lockMock.mockResolvedValue(null);
    await expect(
      planReceiptApplication(COMPANY, PAYMENT, [{ invoiceId: INV_A, amount: 100 }]),
    ).rejects.toThrow(/not found/i);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('refuses a draft payment, naming the operation that posts it', async () => {
    lockMock.mockResolvedValue(paymentRow({ status: 'draft' }));
    await expect(
      planReceiptApplication(COMPANY, PAYMENT, [{ invoiceId: INV_A, amount: 100 }]),
    ).rejects.toThrow(/draft/i);
  });

  it('refuses a cancelled payment', async () => {
    lockMock.mockResolvedValue(paymentRow({ status: 'cancelled' }));
    await expect(
      planReceiptApplication(COMPANY, PAYMENT, [{ invoiceId: INV_A, amount: 100 }]),
    ).rejects.toThrow(/cancelled/i);
  });

  it('refuses when the allocations exceed the unapplied remainder', async () => {
    lockMock.mockResolvedValue(paymentRow({ allocated_amount: '900.00' }));
    invoiceRows([invoiceRow(INV_A)]);
    await expect(
      planReceiptApplication(COMPANY, PAYMENT, [{ invoiceId: INV_A, amount: 200 }]),
    ).rejects.toThrow(/unapplied/i);
  });

  it('refuses when one amount exceeds that invoice outstanding', async () => {
    lockMock.mockResolvedValue(paymentRow());
    invoiceRows([invoiceRow(INV_A, { amount_paid: '550.00' })]);
    await expect(
      planReceiptApplication(COMPANY, PAYMENT, [{ invoiceId: INV_A, amount: 100 }]),
    ).rejects.toThrow(/outstanding/i);
  });

  it('refuses a duplicate invoice in one request rather than hitting 23505 mid-write', async () => {
    lockMock.mockResolvedValue(paymentRow());
    await expect(
      planReceiptApplication(COMPANY, PAYMENT, [
        { invoiceId: INV_A, amount: 100 },
        { invoiceId: INV_A, amount: 100 },
      ]),
    ).rejects.toThrow(/more than once/i);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('refuses an invoice this payment has already been allocated against', async () => {
    lockMock.mockResolvedValue(paymentRow());
    invoiceRows([invoiceRow(INV_A, { already_allocated: '100.00' })]);
    await expect(
      planReceiptApplication(COMPANY, PAYMENT, [{ invoiceId: INV_A, amount: 100 }]),
    ).rejects.toThrow(/already allocated/i);
  });

  it('refuses a cancelled invoice', async () => {
    lockMock.mockResolvedValue(paymentRow());
    invoiceRows([invoiceRow(INV_A, { status: 'cancelled' })]);
    await expect(
      planReceiptApplication(COMPANY, PAYMENT, [{ invoiceId: INV_A, amount: 100 }]),
    ).rejects.toThrow(/cancelled/i);
  });

  it('refuses an invoice that is not in this company (reported as not found)', async () => {
    lockMock.mockResolvedValue(paymentRow());
    invoiceRows([]); // the company-scoped SELECT returns nothing
    await expect(
      planReceiptApplication(COMPANY, PAYMENT, [{ invoiceId: INV_A, amount: 100 }]),
    ).rejects.toThrow(/not found/i);
  });

  it('refuses a non-positive amount before any query runs', async () => {
    lockMock.mockResolvedValue(paymentRow());
    await expect(
      planReceiptApplication(COMPANY, PAYMENT, [{ invoiceId: INV_A, amount: 0 }]),
    ).rejects.toThrow(/positive/i);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('refuses an empty allocation list', async () => {
    await expect(planReceiptApplication(COMPANY, PAYMENT, [])).rejects.toThrow(/at least one/i);
  });

  it('scopes the invoice query to the company', async () => {
    lockMock.mockResolvedValue(paymentRow());
    invoiceRows([invoiceRow(INV_A)]);
    await planReceiptApplication(COMPANY, PAYMENT, [{ invoiceId: INV_A, amount: 100 }]);
    const values = sqlMock.mock.calls[0]!.slice(1);
    expect(values).toContain(COMPANY);
  });
});

describe('applyReceiptPlan', () => {
  it('moves amount_paid by a RELATIVE update, never an absolute one', async () => {
    lockMock.mockResolvedValue(paymentRow());
    invoiceRows([invoiceRow(INV_A)]);
    const plan = await planReceiptApplication(COMPANY, PAYMENT, [{ invoiceId: INV_A, amount: 600 }]);

    sqlMock.mockResolvedValue([]);
    await applyReceiptPlan(COMPANY, plan, USER);

    const updates = sqlMock.mock.calls
      .map((c) => (c[0] as string[]).join('?'))
      .filter((t) => t.includes('UPDATE customer_invoices'));
    expect(updates).toHaveLength(1);
    // The relative form is what survives a concurrent allocation.
    expect(updates[0]).toMatch(/amount_paid\s*=\s*COALESCE\(amount_paid,\s*0\)\s*\+/);
    expect(updates[0]).not.toMatch(/SET\s+amount_paid\s*=\s*\?/);
  });

  it('inserts one allocation row per line and scopes every write to the company', async () => {
    lockMock.mockResolvedValue(paymentRow());
    invoiceRows([invoiceRow(INV_A), invoiceRow(INV_B)]);
    const plan = await planReceiptApplication(COMPANY, PAYMENT, [
      { invoiceId: INV_A, amount: 300 },
      { invoiceId: INV_B, amount: 200 },
    ]);

    sqlMock.mockResolvedValue([]);
    await applyReceiptPlan(COMPANY, plan, USER);

    const texts = sqlMock.mock.calls.map((c) => (c[0] as string[]).join('?'));
    const inserts = texts.filter((t) => t.includes('INSERT INTO customer_payment_allocations'));
    expect(inserts).toHaveLength(2);
    for (const call of sqlMock.mock.calls) {
      const text = (call[0] as string[]).join('?');
      if (text.includes('UPDATE customer_invoices') || text.includes('UPDATE customer_payments')) {
        expect(call.slice(1)).toContain(COMPANY);
      }
    }
  });

  it('writes nothing when only the plan is built — a dry run cannot touch the ledger', async () => {
    lockMock.mockResolvedValue(paymentRow());
    invoiceRows([invoiceRow(INV_A)]);
    await planReceiptApplication(COMPANY, PAYMENT, [{ invoiceId: INV_A, amount: 100 }]);

    const texts = sqlMock.mock.calls.map((c) => (c[0] as string[]).join('?'));
    expect(texts.some((t) => /INSERT|UPDATE|DELETE/.test(t))).toBe(false);
  });
});
