/**
 * Who locks the open documents, and who only looks at them.
 *
 * The live path consumes these rows, so it holds them: without `FOR UPDATE`
 * two concurrent payments to one supplier each plan their whole amount against
 * the same open bill, and the second is refused mid-allocation — which rolls
 * back its journal, not just its application.
 *
 * The bulk DRY RUN reads exactly the same rows and writes nothing. Reusing the
 * live fetch made a preview take row locks and hold them to the end of its
 * request, so an agent asking what a batch WOULD do blocked every allocation
 * against those suppliers while it thought about it. A read that cannot write
 * must not hold a write lock.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), getPoolForTests: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
// The locking read bounds its wait with SET LOCAL lock_timeout, which needs the
// request's own client — the same shape `fetchBillCandidates` uses.
const clientQuery = vi.fn(async () => undefined);
vi.mock('@/modules/accounting/services/core/requestTransaction', () => ({
  requireRequestTransaction: () => ({ query: clientQuery }),
}));

import { sql } from '@/lib/neon';
import { fetchOpenSupplierBills } from '@/modules/accounting/services/ap/openSupplierBills';
import { fetchOpenCustomerInvoices } from '@/modules/accounting/services/ar/openCustomerInvoices';
import {
  BALANCE_DERIVED, FIFO_ELIGIBLE_STATUSES,
} from '@/modules/accounting/services/ar/invoiceStatusRecompute';

type SqlFn = MockedFunction<(strings: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY = '11111111-1111-1111-1111-111111111111';
const ENTITY = '22222222-2222-2222-2222-222222222222';

/** The text of the one query the fetch just ran. */
function lastQuery(): string {
  const call = mockSql.mock.calls.at(-1)!;
  return call[0].join('?').replace(/\s+/g, ' ').trim();
}

/** The status array the fetch passed as a parameter. */
function lastStatuses(): string[] {
  return mockSql.mock.calls.at(-1)!.slice(1).find(Array.isArray) as string[];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchOpenSupplierBills — the lock is the caller’s choice', () => {
  it('locks the rows when the caller is going to consume them', async () => {
    await fetchOpenSupplierBills(COMPANY, ENTITY, true, { forUpdate: true });
    expect(lastQuery()).toContain('FOR UPDATE');
  });

  it('takes NO lock for a read-only preview, in either direction', async () => {
    await fetchOpenSupplierBills(COMPANY, ENTITY, true, { forUpdate: false });
    expect(lastQuery()).not.toContain('FOR UPDATE');
    // Still the same population — only the lock differs.
    expect(lastQuery()).toContain('ORDER BY id');

    await fetchOpenSupplierBills(COMPANY, ENTITY, false, { forUpdate: false });
    expect(lastQuery()).not.toContain('FOR UPDATE');
  });

  it('locks in the newest-first direction too', async () => {
    await fetchOpenSupplierBills(COMPANY, ENTITY, false, { forUpdate: true });
    expect(lastQuery()).toContain('FOR UPDATE');
  });
});

describe('fetchOpenCustomerInvoices — the lock is the caller’s choice', () => {
  it('locks the invoice rows when the caller is going to consume them', async () => {
    await fetchOpenCustomerInvoices(COMPANY, ENTITY, true, { forUpdate: true });
    // FOR UPDATE OF ci, never a bare FOR UPDATE: the lock belongs to the
    // invoice rows, not to whatever else the statement touches.
    expect(lastQuery()).toContain('FOR UPDATE OF ci');
  });

  it('takes NO lock for a read-only preview, in either direction', async () => {
    await fetchOpenCustomerInvoices(COMPANY, ENTITY, true, { forUpdate: false });
    expect(lastQuery()).not.toContain('FOR UPDATE');
    expect(lastQuery()).toContain('ORDER BY ci.id');

    await fetchOpenCustomerInvoices(COMPANY, ENTITY, false, { forUpdate: false });
    expect(lastQuery()).not.toContain('FOR UPDATE');
  });

  it('locks in the newest-first direction too', async () => {
    await fetchOpenCustomerInvoices(COMPANY, ENTITY, false, { forUpdate: true });
    expect(lastQuery()).toContain('FOR UPDATE OF ci');
  });
});

describe('every variant carries the same population predicates', () => {
  // Four statements per fetch — two directions by two lock states — and a
  // predicate present in three of them is a hole that only shows up on the
  // fourth. Soft-deleted documents are the one that matters most: a reversed,
  // soft-deleted invoice is out of the ledger, and FIFO settling it would put
  // cash against a document no report will show.
  const variants: [boolean, boolean][] = [[true, true], [true, false], [false, true], [false, false]];

  it('never offers a soft-deleted bill to the supplier walk', async () => {
    for (const [oldestFirst, forUpdate] of variants) {
      await fetchOpenSupplierBills(COMPANY, ENTITY, oldestFirst, { forUpdate });
      expect(lastQuery()).toContain('deleted_at IS NULL');
      expect(lastQuery()).toContain('status = ANY(?::TEXT[])');
      expect(lastStatuses()).toEqual([...FIFO_ELIGIBLE_STATUSES]);
    }
  });

  it('never offers a soft-deleted invoice to the customer walk', async () => {
    for (const [oldestFirst, forUpdate] of variants) {
      await fetchOpenCustomerInvoices(COMPANY, ENTITY, oldestFirst, { forUpdate });
      expect(lastQuery()).toContain('ci.deleted_at IS NULL');
      expect(lastQuery()).toContain('COALESCE(ci.client_id, ci.customer_id)');
      expect(lastStatuses()).toEqual([...FIFO_ELIGIBLE_STATUSES]);
    }
  });
});

describe('the eligible set is what the recompute can move', () => {
  it('is a subset of BALANCE_DERIVED', () => {
    // THE DEFECT THIS PINS: an exclusion list forgot `pending_approval`, so the
    // walk settled an unapproved bill and `recomputeInvoiceStatus` — gated on
    // BALANCE_DERIVED — then refused to touch it. The bill kept status
    // `pending_approval` with amount_paid = total_amount and payment_matched
    // false, and no writer in the codebase corrects that.
    for (const status of FIFO_ELIGIBLE_STATUSES) {
      expect(BALANCE_DERIVED).toContain(status);
    }
  });

  it('admits none of the statuses cash must never settle', () => {
    for (const forbidden of ['draft', 'pending_approval', 'cancelled', 'disputed', 'written_off']) {
      expect(FIFO_ELIGIBLE_STATUSES).not.toContain(forbidden);
    }
  });

  it('is the set both fetches actually select on', async () => {
    await fetchOpenSupplierBills(COMPANY, ENTITY, true, { forUpdate: false });
    expect(lastStatuses()).toEqual([...FIFO_ELIGIBLE_STATUSES]);
    await fetchOpenCustomerInvoices(COMPANY, ENTITY, true, { forUpdate: false });
    expect(lastStatuses()).toEqual([...FIFO_ELIGIBLE_STATUSES]);
  });
});

describe('the rows are LOCKED in id order and ORDERED in memory', () => {
  const rows = [
    { id: 'c', invoice_number: 'C', invoice_date: '2026-02-03', due_date: null, outstanding: 30 },
    { id: 'a', invoice_number: 'A', invoice_date: '2026-02-01', due_date: '2026-03-01', outstanding: 10 },
    { id: 'b', invoice_number: 'B', invoice_date: '2026-02-01', due_date: null, outstanding: 20 },
  ];

  // Every other path on this money route locks by id
  // (supplierAllocationLines#lockBillCandidates, receiptAllocationLines), so
  // the SQL must NOT order by date: two requests taking one pair of bills in
  // opposite sequences raise 40P01, which aborts the whole transaction.
  it('sorts oldest-first with a missing due date LAST, off an id-ordered read', async () => {
    mockSql.mockResolvedValueOnce(rows as never);
    const out = await fetchOpenSupplierBills(COMPANY, ENTITY, true, { forUpdate: false });
    expect(lastQuery()).toContain('ORDER BY id');
    expect(lastQuery()).not.toContain('invoice_date ASC');
    expect(out.map((d) => d.invoiceId)).toEqual(['a', 'b', 'c']);
  });

  it('sorts newest-first as the exact mirror, nulls included', async () => {
    mockSql.mockResolvedValueOnce(rows as never);
    const out = await fetchOpenSupplierBills(COMPANY, ENTITY, false, { forUpdate: false });
    expect(out.map((d) => d.invoiceId)).toEqual(['c', 'b', 'a']);
  });

  it('orders the customer side identically', async () => {
    mockSql.mockResolvedValueOnce(rows as never);
    const out = await fetchOpenCustomerInvoices(COMPANY, ENTITY, true, { forUpdate: false });
    expect(out.map((d) => d.invoiceId)).toEqual(['a', 'b', 'c']);
  });
});

describe('a held row is a retryable refusal, not a raw driver error', () => {
  it('bounds the wait and names the remedy on the supplier side', async () => {
    const contention = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    });
    mockSql.mockRejectedValueOnce(contention as never);

    await expect(fetchOpenSupplierBills(COMPANY, ENTITY, true, { forUpdate: true }))
      .rejects.toThrow(/retry in a moment/);
    expect(clientQuery).toHaveBeenCalledWith("SET LOCAL lock_timeout = '5s'");
  });

  it('answers a DEADLOCK the same way on the customer side', async () => {
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    mockSql.mockRejectedValueOnce(deadlock as never);

    await expect(fetchOpenCustomerInvoices(COMPANY, ENTITY, true, { forUpdate: true }))
      .rejects.toThrow(/retry in a moment/);
  });

  it('does not dress an unrelated failure as contention', async () => {
    mockSql.mockRejectedValueOnce(
      Object.assign(new Error('column does not exist'), { code: '42703' }) as never,
    );
    await expect(fetchOpenSupplierBills(COMPANY, ENTITY, true, { forUpdate: true }))
      .rejects.toThrow(/column does not exist/);
  });
});

describe('the live callers ask for the lock', () => {
  it('recordSupplierBankPayment reads its bills locked', async () => {
    const { recordSupplierBankPayment } = await import(
      '@/modules/accounting/services/ap/supplierAutoAllocate'
    );
    mockSql
      .mockResolvedValueOnce([{ id: 'pay-1' }])                   // INSERT payment
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'off' }]) // supplier
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }])      // journal period
      .mockResolvedValueOnce([]);                                 // open bills

    await recordSupplierBankPayment({
      companyId: COMPANY,
      supplierId: ENTITY,
      bankTxId: '33333333-3333-3333-3333-333333333333',
      bankAccountId: '44444444-4444-4444-4444-444444444444',
      journalEntryId: '55555555-5555-5555-5555-555555555555',
      amount: 100,
      paymentDate: '2026-09-18',
      description: 'EFT',
      userId: '77777777-7777-7777-7777-777777777777',
    });

    expect(lastQuery()).toContain('FROM supplier_invoices');
    expect(lastQuery()).toContain('FOR UPDATE');
  });

  it('autoApplyCustomerReceipt reads its invoices locked', async () => {
    const { autoApplyCustomerReceipt } = await import(
      '@/modules/accounting/services/ar/customerAutoAllocate'
    );
    mockSql
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'off' }]) // customer
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }])      // journal period
      .mockResolvedValueOnce([]);                                 // open invoices

    await autoApplyCustomerReceipt({
      companyId: COMPANY,
      customerId: ENTITY,
      paymentId: '66666666-6666-6666-6666-666666666666',
      journalEntryId: '55555555-5555-5555-5555-555555555555',
      amount: 100,
      userId: '77777777-7777-7777-7777-777777777777',
    });

    expect(lastQuery()).toContain('FROM customer_invoices');
    expect(lastQuery()).toContain('FOR UPDATE OF ci');
  });
});
