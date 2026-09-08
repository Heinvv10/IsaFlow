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

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  return { sql: vi.fn(), withTransaction: vi.fn(), fmtDate: actual.fmtDate };
});
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

import { sql, withTransaction } from '@/lib/neon';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { recordPaymentMatch } from '@/modules/accounting/services/capture/fourWayMatchService';
import { recordSupplierBankPayment } from '@/modules/accounting/services/ap/supplierAutoAllocate';
import { autoApplyCustomerReceipt } from '@/modules/accounting/services/ar/customerAutoAllocate';
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
  transaction_date: new Date('2026-09-08'), status: 'imported',
  description: 'EFT', reference: 'ABC123',
};
/** The same line as money IN — a receipt, or a supplier refund. */
const RECEIVED_TX = { ...SPENT_TX, amount: 1150 };

function primeSql(tx: typeof SPENT_TX) {
  mockSql
    .mockResolvedValueOnce([tx])                                    // lock + fetch the line
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
  vi.mocked(postJournalEntry).mockResolvedValue(undefined as never);
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

  it('creates nothing for a supplier REFUND — money in is not a payment', async () => {
    primeSql(RECEIVED_TX);

    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'supplier', ENTITY_ID,
    );

    expect(recordSupplierBankPayment).not.toHaveBeenCalled();
    expect(recordPaymentMatch).not.toHaveBeenCalled();
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
      undefined, undefined, undefined, undefined, undefined, { autoApply: false },
    );

    expect(recordSupplierBankPayment).toHaveBeenCalledOnce();
    expect(vi.mocked(recordSupplierBankPayment).mock.calls[0]![0]).toMatchObject({
      autoApply: false,
    });
  });

  it('runs the strategy by default, when no caller named anything', async () => {
    primeSql(SPENT_TX);

    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'supplier', ENTITY_ID,
    );

    expect(vi.mocked(recordSupplierBankPayment).mock.calls[0]![0]).toMatchObject({
      autoApply: true,
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
    primeSql(RECEIVED_TX);

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
    });
  });

  it('does nothing for a customer REFUND — cash going out is not a receipt', async () => {
    primeSql(SPENT_TX);

    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'customer', ENTITY_ID,
    );

    expect(autoApplyCustomerReceipt).not.toHaveBeenCalled();
  });
});
