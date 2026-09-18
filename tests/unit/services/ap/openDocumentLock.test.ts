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

import { sql } from '@/lib/neon';
import { fetchOpenSupplierBills } from '@/modules/accounting/services/ap/openSupplierBills';
import { fetchOpenCustomerInvoices } from '@/modules/accounting/services/ar/openCustomerInvoices';

type SqlFn = MockedFunction<(strings: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY = '11111111-1111-1111-1111-111111111111';
const ENTITY = '22222222-2222-2222-2222-222222222222';

/** The text of the one query the fetch just ran. */
function lastQuery(): string {
  const call = mockSql.mock.calls.at(-1)!;
  return call[0].join('?').replace(/\s+/g, ' ').trim();
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
    // Still the same population and the same order — only the lock differs.
    expect(lastQuery()).toContain('ORDER BY invoice_date ASC, due_date ASC NULLS LAST, id ASC');

    await fetchOpenSupplierBills(COMPANY, ENTITY, false, { forUpdate: false });
    expect(lastQuery()).not.toContain('FOR UPDATE');
    expect(lastQuery()).toContain('ORDER BY invoice_date DESC, due_date DESC NULLS FIRST, id DESC');
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
    expect(lastQuery()).toContain(
      'ORDER BY ci.invoice_date ASC, ci.due_date ASC NULLS LAST, ci.id ASC',
    );

    await fetchOpenCustomerInvoices(COMPANY, ENTITY, false, { forUpdate: false });
    expect(lastQuery()).not.toContain('FOR UPDATE');
    expect(lastQuery()).toContain(
      'ORDER BY ci.invoice_date DESC, ci.due_date DESC NULLS FIRST, ci.id DESC',
    );
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
      expect(lastQuery()).toContain('status <> ALL(?::TEXT[])');
    }
  });

  it('never offers a soft-deleted invoice to the customer walk', async () => {
    for (const [oldestFirst, forUpdate] of variants) {
      await fetchOpenCustomerInvoices(COMPANY, ENTITY, oldestFirst, { forUpdate });
      expect(lastQuery()).toContain('ci.deleted_at IS NULL');
      expect(lastQuery()).toContain('COALESCE(ci.client_id, ci.customer_id)');
    }
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
