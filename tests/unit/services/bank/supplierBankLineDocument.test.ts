/**
 * What `allocateTransaction` does with the cash on a supplier or customer bank
 * line — the routing, not the arithmetic.
 *
 * THE DEFECT. A supplier line that named no invoice used to take the supplier's
 * most recently CREATED unpaid bill and call `recordPaymentMatch` on it: a
 * `payment_matched` boolean, no `amount_paid`, no payment document, on a bill
 * the caller never chose. These tests pin the three routes that replaced it.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// The learning-loop log has its own suites (codingDecisionLog, coding-decision-paths); it is kept out of this
// file's SQL sequence.
vi.mock('@/modules/accounting/services/bank/codingDecisionLog', () => ({
  postingRefOf: () => ({}), recordAllocationDecision: vi.fn(), recordAutoPostUndone: vi.fn(),
  recordExcluded: vi.fn(), recordMatchDecision: vi.fn(),
}));
vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  // withSavepoint passes through: R-067's tenant fence runs its ownership read
  // inside one, and an undefined mock would make every customer allocation throw.
  return {
    sql: vi.fn(),
    withTransaction: vi.fn(),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => Promise.resolve().then(fn)),
    fmtDate: actual.fmtDate,
  };
});
// R-035 PR5 (D2): whether a hand-keyed line may pay a supplier is proved against
// real PostgreSQL (r035-pr5-manual); here it lets the path under test run.
vi.mock('@/modules/accounting/services/ap/bankLinePaymentGate', () => ({
  assertBankLineMayPaySupplier: vi.fn().mockResolvedValue(undefined),
  isBankEvidenced: () => true,
  manualLinePaymentRefusal: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(async () => 'ap-account-id'),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionQueryService', () => ({
  mapTxRow: vi.fn((row: unknown) => row),
}));
vi.mock('@/modules/accounting/services/capture/fourWayMatchService', () => ({
  recordPaymentMatch: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierAutoAllocate', () => ({
  recordSupplierBankPayment: vi.fn(async () => ({
    paymentId: 'payment-1', appliedLines: [], unappliedRemainder: 1150, strategy: 'off',
  })),
}));
vi.mock('@/modules/accounting/services/ar/customerAutoAllocate', () => ({
  autoApplyCustomerReceipt: vi.fn(async () => ({
    appliedLines: [], unappliedRemainder: 1150, strategy: 'off',
  })),
}));
// Mocked rather than primed into the positional `sql` queue below. Both run a
// read of their own — the on-account credit — and threading it through the
// queue would make every non-refund test's fixture carry a row for a query it
// never makes.
vi.mock('@/modules/accounting/services/ap/supplierRefundDocument', () => ({
  planSupplierRefund: vi.fn(async () => ({
    amount: 1150, onAccountCredit: 5000, supplierName: 'Acme',
  })),
  recordSupplierRefund: vi.fn(async () => ({
    paymentId: 'refund-1', amount: -1150, onAccountCredit: 5000,
  })),
}));
vi.mock('@/modules/accounting/services/ar/customerRefundDocument', () => ({
  planCustomerRefund: vi.fn(async () => ({
    amount: 1150, onAccountCredit: 5000, customerName: 'Acme',
  })),
  recordCustomerRefund: vi.fn(async () => ({
    paymentId: 'crefund-1', amount: -1150, onAccountCredit: 5000,
  })),
}));

import { sql, withTransaction } from '@/lib/neon';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { recordPaymentMatch } from '@/modules/accounting/services/capture/fourWayMatchService';
import { recordSupplierBankPayment } from '@/modules/accounting/services/ap/supplierAutoAllocate';
import { autoApplyCustomerReceipt } from '@/modules/accounting/services/ar/customerAutoAllocate';
import { planSupplierRefund, recordSupplierRefund } from '@/modules/accounting/services/ap/supplierRefundDocument';
import { planCustomerRefund, recordCustomerRefund } from '@/modules/accounting/services/ar/customerRefundDocument';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { enterFakeRequestCtx } from '../../helpers/requestCtx';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;
const mockWithTx = withTransaction as unknown as MockedFunction<
  (fn: (wTx: unknown) => Promise<void>) => Promise<void>
>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const ENTITY_ID = '22222222-2222-2222-2222-222222222222';
const BANK_TX_ID = '33333333-3333-3333-3333-333333333333';
const BANK_ACCOUNT_ID = '44444444-4444-4444-4444-444444444444';
const INVOICE_ID = '55555555-5555-5555-5555-555555555555';
const USER_ID = '77777777-7777-7777-7777-777777777777';
const JE_ID = 'je-1';
const PAYMENT_ROW_ID = 'cp-1';

/** A payment OUT of R1,150. */
const SPENT_TX = {
  id: BANK_TX_ID, bank_account_id: BANK_ACCOUNT_ID, amount: -1150,
  transaction_date: new Date('2026-09-08'), status: 'imported', feed_state: 'posted',
  description: 'EFT', reference: 'ABC123',
};
/** The same line as money IN — a receipt, or a supplier refund. */
const RECEIVED_TX = { ...SPENT_TX, amount: 1150 };

function primeSql(tx: typeof SPENT_TX, kind: 'supplier' | 'customer' = 'supplier') {
  mockSql.mockResolvedValueOnce([tx]);                              // lock + fetch the line
  // R-067: the customer arm fences `entityId` against `customers` immediately
  // after the lock, before anything is posted; R-068 does the same for the
  // supplier arm against `suppliers`. The queue is positional.
  mockSql.mockResolvedValueOnce([{ ok: 1 }]);
  mockSql
    .mockResolvedValueOnce([{ name: 'Acme' }])                      // entity name
    .mockResolvedValueOnce([])                                      // source_document_id carry-forward
    .mockResolvedValueOnce([{ id: 'jl-1' }])                        // bank journal line
    .mockResolvedValueOnce([tx]);                                   // final read-back
}

beforeEach(() => {
  vi.clearAllMocks();
  enterFakeRequestCtx();
  mockWithTx.mockImplementation(async (fn) => {
    await fn(vi.fn().mockResolvedValue([{ id: PAYMENT_ROW_ID }]));
  });
  vi.mocked(createJournalEntry).mockResolvedValue({
    id: JE_ID, companyId: COMPANY_ID, entryDate: '2026-09-08', status: 'draft',
  } as never);
  vi.mocked(postJournalEntry).mockResolvedValue({} as never); // the caller reads .lateClaim off it
});

describe('allocateTransaction — supplier payment with no invoice named', () => {
  it('creates the payment document, carrying the journal it just posted', async () => {
    primeSql(SPENT_TX);

    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'supplier', ENTITY_ID,
    );

    expect(recordSupplierBankPayment).toHaveBeenCalledOnce();
    expect(vi.mocked(recordSupplierBankPayment).mock.calls[0]![0]).toMatchObject({
      companyId: COMPANY_ID,
      supplierId: ENTITY_ID,
      bankTxId: BANK_TX_ID,
      bankAccountId: BANK_ACCOUNT_ID,
      journalEntryId: JE_ID,
      amount: 1150,
      paymentDate: '2026-09-08',
      userId: USER_ID,
    });
  });

  it('no longer guesses a bill to flag as payment-matched', async () => {
    primeSql(SPENT_TX);

    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'supplier', ENTITY_ID,
    );

    // The flag on a bill nobody named was the whole defect.
    expect(recordPaymentMatch).not.toHaveBeenCalled();
    const billLookups = mockSql.mock.calls
      .map(([strings]) => (strings as TemplateStringsArray).join('?').replace(/\s+/g, ' '))
      .filter((q) => q.includes('FROM supplier_invoices') && q.includes('payment_matched'));
    expect(billLookups).toEqual([]);
  });

  it('creates a REFUND document for money in, never a payment document', async () => {
    primeSql(RECEIVED_TX);

    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'supplier', ENTITY_ID,
    );

    // A positive payment document for a refund would be cash the company never
    // paid; a four-way match would settle a bill with money coming back.
    expect(recordSupplierBankPayment).not.toHaveBeenCalled();
    expect(recordPaymentMatch).not.toHaveBeenCalled();

    // Migration 681: the negative on-account entry that used to be missing.
    expect(recordSupplierRefund).toHaveBeenCalledOnce();
    expect(vi.mocked(recordSupplierRefund).mock.calls[0]![0]).toMatchObject({
      companyId: COMPANY_ID, supplierId: ENTITY_ID, bankTxId: BANK_TX_ID,
      bankAccountId: BANK_ACCOUNT_ID, journalEntryId: JE_ID,
      amount: 1150, paymentDate: '2026-09-08', userId: USER_ID,
    });
    // No `autoApply` on the call at all: a negative remainder applied to a bill
    // un-pays it, so there is no mode under which this is applied.
    expect(vi.mocked(recordSupplierRefund).mock.calls[0]![0]).not.toHaveProperty('autoApply');
  });

  it('checks the refund ceiling BEFORE it posts the journal', async () => {
    primeSql(RECEIVED_TX);

    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'supplier', ENTITY_ID,
    );

    // `withAuth` COMMITs on a 4xx, so a refusal raised after the first write
    // can only commit an orphan journal or report an internal error. The order
    // is the guarantee, and it is invoke-order on two mocks.
    expect(planSupplierRefund).toHaveBeenCalledOnce();
    const planned = vi.mocked(planSupplierRefund).mock.invocationCallOrder[0]!;
    const posted = vi.mocked(createJournalEntry).mock.invocationCallOrder[0]!;
    expect(planned).toBeLessThan(posted);
  });
});

describe('allocateTransaction — a caller that named a non-bill target', () => {
  it('creates the document but does NOT run the supplier strategy', async () => {
    primeSql(SPENT_TX);

    // `bank-match-confirm`'s purchase-order branch: the user confirmed this
    // line against a PO. A PO is not a bill, so there is a document to create
    // but nothing the strategy should be allowed to settle — applying the cash
    // to some unrelated open bill would contradict the match just confirmed.
    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'supplier', ENTITY_ID,
      undefined, undefined, undefined, undefined, undefined, { autoApply: 'none' },
    );

    expect(recordSupplierBankPayment).toHaveBeenCalledOnce();
    expect(vi.mocked(recordSupplierBankPayment).mock.calls[0]![0]).toMatchObject({
      autoApply: 'none',
    });
  });

  it('applies FIFO by default, when no caller named anything', async () => {
    primeSql(SPENT_TX);

    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'supplier', ENTITY_ID,
    );

    expect(vi.mocked(recordSupplierBankPayment).mock.calls[0]![0]).toMatchObject({
      autoApply: 'fifo',
    });
  });
});

describe('allocateTransaction — supplier payment that NAMES a bill', () => {
  it('records the four-way match against that bill and creates no second document', async () => {
    primeSql(SPENT_TX);

    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'supplier', ENTITY_ID,
      undefined, undefined, undefined, undefined, INVOICE_ID,
    );

    // `applyBankLineToSupplierInvoices` is the caller that names a bill, and it
    // owns the document. A second one here would apply the money twice.
    expect(recordSupplierBankPayment).not.toHaveBeenCalled();
    expect(recordPaymentMatch).toHaveBeenCalledWith(COMPANY_ID, INVOICE_ID, 1150);
  });
});

describe('allocateTransaction — customer receipt', () => {
  it('applies the receipt it just inserted, by id', async () => {
    primeSql(RECEIVED_TX, 'customer');

    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'customer', ENTITY_ID,
    );

    // The insert used to throw its id away, which is why every receipt it made
    // landed in list_unapplied_receipts.
    expect(autoApplyCustomerReceipt).toHaveBeenCalledOnce();
    expect(vi.mocked(autoApplyCustomerReceipt).mock.calls[0]![0]).toMatchObject({
      companyId: COMPANY_ID,
      customerId: ENTITY_ID,
      paymentId: PAYMENT_ROW_ID,
      amount: 1150,
      autoApply: 'fifo',
    });
  });

  it('mints a REFUND for cash going out, never a receipt', async () => {
    primeSql(SPENT_TX, 'customer');

    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'customer', ENTITY_ID,
    );

    // A positive receipt row for a refund is cash the company never received —
    // the shape that once put R1.84m of phantom receipts on one statement.
    expect(autoApplyCustomerReceipt).not.toHaveBeenCalled();
    expect(recordCustomerRefund).toHaveBeenCalledOnce();
    expect(vi.mocked(recordCustomerRefund).mock.calls[0]![0]).toMatchObject({
      companyId: COMPANY_ID, customerId: ENTITY_ID, journalEntryId: JE_ID, amount: 1150,
    });
    // Same ordering guarantee as the supplier arm.
    expect(vi.mocked(planCustomerRefund).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(createJournalEntry).mock.invocationCallOrder[0]!);
  });
});
