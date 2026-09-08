/**
 * The supplier payment DOCUMENT a bank allocation creates, and whether it is
 * applied.
 *
 * The defect these cover: an outgoing supplier line used to create no document
 * at all and flag the supplier's most recently CREATED unpaid bill as
 * payment-matched at `amount_paid = 0`. So the assertions here are about which
 * writes happen, in which order, and — for the default supplier — which ones
 * deliberately do not.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), getPoolForTests: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  resolveUserUuid: vi.fn(async (id: string) => id),
}));
vi.mock('@/modules/accounting/services/ap/supplierPaymentApplicationService', () => ({
  planSupplierPaymentApplication: vi.fn(),
  applySupplierPaymentPlan: vi.fn(),
}));

import { sql } from '@/lib/neon';
import {
  planSupplierPaymentApplication,
  applySupplierPaymentPlan,
} from '@/modules/accounting/services/ap/supplierPaymentApplicationService';
import {
  recordSupplierBankPayment,
  resolveSupplierAutoAllocateStrategy,
  fetchOpenSupplierBills,
} from '@/modules/accounting/services/ap/supplierAutoAllocate';

type SqlFn = MockedFunction<(strings: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;
const mockPlan = planSupplierPaymentApplication as MockedFunction<typeof planSupplierPaymentApplication>;
const mockApply = applySupplierPaymentPlan as MockedFunction<typeof applySupplierPaymentPlan>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const SUPPLIER_ID = '22222222-2222-2222-2222-222222222222';
const BANK_TX_ID = '33333333-3333-3333-3333-333333333333';
const BANK_ACCOUNT_ID = '44444444-4444-4444-4444-444444444444';
const JE_ID = '55555555-5555-5555-5555-555555555555';
const PAYMENT_ID = '66666666-6666-6666-6666-666666666666';
const USER_ID = '77777777-7777-7777-7777-777777777777';

/** The text of every query `sql` was called with, in order. */
function queries(): string[] {
  return mockSql.mock.calls.map(([strings]) => strings.join('?').replace(/\s+/g, ' ').trim());
}

const ARGS = {
  companyId: COMPANY_ID,
  supplierId: SUPPLIER_ID,
  bankTxId: BANK_TX_ID,
  bankAccountId: BANK_ACCOUNT_ID,
  journalEntryId: JE_ID,
  amount: 1000,
  paymentDate: '2026-09-08',
  description: 'Payment to Acme',
  userId: USER_ID,
};

function planFor(lines: { invoiceId: string; amount: number }[], unappliedAfter: number) {
  return {
    paymentId: PAYMENT_ID,
    paymentNumber: 'SP-0001',
    supplierId: SUPPLIER_ID,
    paymentTotal: 1000,
    allocatedBefore: 0,
    allocatedAfter: 1000 - unappliedAfter,
    unappliedBefore: 1000,
    unappliedAfter,
    paymentStatusBefore: 'processed',
    paymentStatusAfter: unappliedAfter <= 0.01 ? 'reconciled' : 'processed',
    lines: lines.map((l) => ({
      invoiceId: l.invoiceId,
      invoiceNumber: `INV-${l.invoiceId}`,
      amount: l.amount,
      outstandingBefore: l.amount,
      outstandingAfter: 0,
      statusBefore: 'approved',
      statusAfter: 'paid',
      fullySettled: true,
    })),
    postsJournal: false as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordSupplierBankPayment', () => {
  it('creates the payment document the allocation never created, carrying its journal', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])          // INSERT ... RETURNING id
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }]) // journal is in a period
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'off' }]);

    const result = await recordSupplierBankPayment(ARGS);

    expect(result.paymentId).toBe(PAYMENT_ID);
    const [strings, ...values] = mockSql.mock.calls[0]!;
    const insert = strings.join('?');
    expect(insert).toContain('INSERT INTO supplier_payments');
    // `processed` because the journal HAS posted — anything less and
    // planSupplierPaymentApplication refuses it as having no cash behind it.
    expect(insert).toContain("'processed'");
    // The journal and the bank line are both on the row, so the pair can be
    // reversed together and the payment traced back to the statement.
    expect(values).toContain(JE_ID);
    expect(values).toContain(BANK_TX_ID);
    expect(values).toContain(COMPANY_ID);
  });

  it('leaves the payment UNAPPLIED when the supplier has no strategy', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }])
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'off' }]);

    const result = await recordSupplierBankPayment(ARGS);

    // The whole point of the default: cash nobody instructed us to apply is
    // visible and correctable, not guessed onto a bill.
    expect(mockPlan).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
    expect(result.appliedLines).toEqual([]);
    expect(result.unappliedRemainder).toBe(1000);
    expect(result.strategy).toBe('off');
    // It must NOT have gone looking for bills either — the strategy decides
    // before any bill is read.
    expect(queries().some((q) => q.includes('FROM supplier_invoices'))).toBe(false);
  });

  it('treats an unreadable or missing supplier row as "off" rather than guessing', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }])
      .mockResolvedValueOnce([]);                            // supplier row gone

    const result = await recordSupplierBankPayment(ARGS);

    expect(result.strategy).toBe('off');
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('applies oldest-first when the supplier says "oldest", partially settling the last bill', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }])
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'oldest' }])
      .mockResolvedValueOnce([
        { id: 'bill-old', outstanding: 600 },
        { id: 'bill-new', outstanding: 900 },
      ]);
    mockPlan.mockResolvedValue(
      planFor([{ invoiceId: 'bill-old', amount: 600 }, { invoiceId: 'bill-new', amount: 400 }], 0),
    );
    mockApply.mockImplementation(async (_c, plan) => plan);

    const result = await recordSupplierBankPayment(ARGS);

    // R1,000 over a R600 and a R900 bill: the old one in full, R400 against the
    // next. Refusing to part-pay would have applied nothing at all.
    expect(mockPlan).toHaveBeenCalledWith(COMPANY_ID, PAYMENT_ID, [
      { invoiceId: 'bill-old', amount: 600 },
      { invoiceId: 'bill-new', amount: 400 },
    ]);
    expect(mockApply).toHaveBeenCalledOnce();
    expect(result.appliedLines).toHaveLength(2);
    expect(result.unappliedRemainder).toBe(0);
  });

  it('reads the bills in ASCENDING invoice date for "oldest"', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }])
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'oldest' }])
      .mockResolvedValueOnce([]);

    await recordSupplierBankPayment(ARGS);

    const billQuery = queries().find((q) => q.includes('FROM supplier_invoices'))!;
    expect(billQuery).toContain('ORDER BY invoice_date ASC');
    expect(billQuery).not.toContain('created_at DESC');
  });

  it('reads the bills in DESCENDING invoice date for "newest"', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }])
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'newest' }])
      .mockResolvedValueOnce([]);

    await recordSupplierBankPayment(ARGS);

    const billQuery = queries().find((q) => q.includes('FROM supplier_invoices'))!;
    expect(billQuery).toContain('ORDER BY invoice_date DESC');
  });

  it('leaves the payment unapplied when the supplier has nothing open', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }])
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'oldest' }])
      .mockResolvedValueOnce([]);                            // no open bills

    const result = await recordSupplierBankPayment(ARGS);

    // The instruction was honoured; there was simply no bill. Nothing is
    // invented and the payment stays findable.
    expect(mockPlan).not.toHaveBeenCalled();
    expect(result.unappliedRemainder).toBe(1000);
  });

  it('does not swallow a failure from the applier', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }])
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'oldest' }])
      .mockResolvedValueOnce([{ id: 'bill-old', outstanding: 600 }]);
    mockPlan.mockRejectedValue(new Error('payment is being processed by another request'));

    // A caught error here would commit the journal and the document while
    // reporting that nothing happened.
    await expect(recordSupplierBankPayment(ARGS)).rejects.toThrow(/another request/);
  });
});

describe('recordSupplierBankPayment — the journal is in no fiscal period', () => {
  it('creates the document but settles NOTHING', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      .mockResolvedValueOnce([{ fiscal_period_id: null }]);

    const result = await recordSupplierBankPayment(ARGS);

    // Marking a bill paid off a journal that is in no period-scoped report —
    // no trial balance, no VAT201, no AFS — hides the settlement behind a
    // journal nobody can find. The cash still gets its document.
    expect(result.paymentId).toBe(PAYMENT_ID);
    expect(mockPlan).not.toHaveBeenCalled();
    expect(result.unappliedRemainder).toBe(1000);
    expect(queries().some((q) => q.includes('FROM suppliers'))).toBe(false);
  });

  it('settles nothing when the journal cannot be read back at all', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      .mockResolvedValueOnce([]);

    const result = await recordSupplierBankPayment(ARGS);
    expect(mockPlan).not.toHaveBeenCalled();
    expect(result.unappliedRemainder).toBe(1000);
  });
});

describe('recordSupplierBankPayment — autoApply: false', () => {
  it('creates the document and never even reads the strategy', async () => {
    mockSql.mockResolvedValueOnce([{ id: PAYMENT_ID }]);

    const result = await recordSupplierBankPayment({ ...ARGS, autoApply: false });

    expect(result.paymentId).toBe(PAYMENT_ID);
    expect(result.strategy).toBe('off');
    expect(result.unappliedRemainder).toBe(1000);
    expect(mockPlan).not.toHaveBeenCalled();
    // Not merely "did not apply" — it must not consult the supplier at all,
    // because the caller has already said what this cash is for.
    expect(queries().some((q) => q.includes('FROM suppliers'))).toBe(false);
    expect(queries().some((q) => q.includes('FROM supplier_invoices'))).toBe(false);
  });

  it('applies as normal when autoApply is omitted', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      .mockResolvedValueOnce([{ fiscal_period_id: 'fp-1' }])
      .mockResolvedValueOnce([{ auto_allocate_strategy: 'oldest' }])
      .mockResolvedValueOnce([{ id: 'bill-old', outstanding: 1000 }]);
    mockPlan.mockResolvedValue(planFor([{ invoiceId: 'bill-old', amount: 1000 }], 0));
    mockApply.mockImplementation(async (_c, plan) => plan);

    await recordSupplierBankPayment(ARGS);
    expect(mockPlan).toHaveBeenCalledOnce();
  });
});

describe('resolveSupplierAutoAllocateStrategy', () => {
  it('scopes the lookup to the company', async () => {
    mockSql.mockResolvedValueOnce([{ auto_allocate_strategy: 'newest' }]);
    await resolveSupplierAutoAllocateStrategy(COMPANY_ID, SUPPLIER_ID);
    const [strings, ...values] = mockSql.mock.calls[0]!;
    expect(strings.join('?')).toContain('company_id');
    expect(values).toContain(COMPANY_ID);
  });

  it('refuses to honour a value that is not one of the three', async () => {
    mockSql.mockResolvedValueOnce([{ auto_allocate_strategy: 'fifo' }]);
    expect(await resolveSupplierAutoAllocateStrategy(COMPANY_ID, SUPPLIER_ID)).toBe('off');
  });
});

describe('fetchOpenSupplierBills', () => {
  it('excludes bills that cannot take a payment and those with nothing outstanding', async () => {
    mockSql.mockResolvedValueOnce([]);
    await fetchOpenSupplierBills(COMPANY_ID, SUPPLIER_ID, true);
    const q = queries()[0]!;
    expect(q).toContain('company_id');
    expect(q).toContain('deleted_at IS NULL');
    expect(q).toContain('(total_amount - COALESCE(amount_paid, 0)) > ?');
    // status is passed as an array parameter, so assert the shape of the
    // predicate and the contents of the parameter separately.
    expect(q).toContain('status <> ALL(?::TEXT[])');
    const statuses = mockSql.mock.calls[0]!.slice(1).find(Array.isArray) as string[];
    expect(statuses).toEqual(expect.arrayContaining(['draft', 'cancelled', 'paid', 'written_off']));
  });
});
