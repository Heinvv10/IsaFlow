/**
 * `postAllocationLine` applies the invoice it was given.
 *
 * THE DEFECT. `bulk_allocate_bank_transactions` and `allocate_bank_transaction`
 * accept `invoice_id`, validate it, and echo it back from `dry_run` — and then
 * posted a journal that never touched the invoice. `allocateTransaction` reads
 * `invoiceId` in exactly one place, gated `allocType === 'supplier'`, where it
 * called `recordPaymentMatch`: a boolean flag, no `amount_paid`, no `status`,
 * no `paid_at`, and an early return that discarded any second payment. There
 * was no customer branch at all.
 *
 * In production that left 398 supplier invoices flagged-matched at
 * `amount_paid = 0` (R16,151,543.00), and every one of Velocity Fibre's 39
 * unallocated receipts (R37,719,269.77) carrying a `gl_journal_entry_id` —
 * i.e. all of them made by this path.
 *
 * THE FIX IS A ROUTE, NOT A REWRITE. `allocateTransaction` still posts exactly
 * one journal and is left alone, because `applyBankLineToSupplierInvoices`
 * already calls it with an `invoiceId`. Teaching it to apply would have made
 * that path create two payment documents and apply the money twice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted: vi.mock factories are hoisted above const declarations, so a
// plain `const fn = vi.fn()` referenced inside one is still in its temporal
// dead zone when the factory runs.
const {
  allocateTransaction, confirmReceiptMatch, applyBankLineToSupplierInvoices, fetchBankTransaction,
} = vi.hoisted(() => ({
  allocateTransaction: vi.fn(),
  confirmReceiptMatch: vi.fn(),
  applyBankLineToSupplierInvoices: vi.fn(),
  fetchBankTransaction: vi.fn(),
}));

vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({ allocateTransaction }));
vi.mock('@/modules/accounting/services/ar/receiptMatchConfirmService', () => ({
  confirmReceiptMatch,
  validateBankReceiptApplication: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierBankPaymentService', () => ({
  applyBankLineToSupplierInvoices,
  validateBankSupplierPayment: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankMatchDbQueries', () => ({ fetchBankTransaction }));

import { postAllocationLine, type AllocationLine } from '@/lib/mcp/tools/allocationLine';

const CTX = {
  companyId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  userId: 'uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu',
  tokenJti: 'jti-123',
} as never;

const TX = 'tttttttt-tttt-tttt-tttt-tttttttttttt';
const INVOICE = 'iiiiiiii-iiii-iiii-iiii-iiiiiiiiiiii';
const ENTITY = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function line(over: Partial<AllocationLine> = {}): AllocationLine {
  return {
    allocType: 'customer',
    entityId: ENTITY,
    invoiceId: INVOICE,
    contraAccountId: undefined,
    description: 'Receipt',
    vatCode: undefined,
    ...over,
  } as AllocationLine;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchBankTransaction.mockResolvedValue({ amount: 218344.80, transactionDate: '2025-12-19' });
  confirmReceiptMatch.mockResolvedValue({ journalEntryId: 'je-cust' });
  applyBankLineToSupplierInvoices.mockResolvedValue({ journalEntryId: 'je-supp' });
  allocateTransaction.mockResolvedValue({
    journalEntryId: 'je-plain', bankTransaction: { id: TX },
  });
});

describe('postAllocationLine — customer receipt naming an invoice', () => {
  it('applies through confirmReceiptMatch, not a bare journal post', async () => {
    // Mutation: delete the customer arm of the route and this goes red while
    // every "posts a journal" test stays green — which is exactly how the bug
    // survived: the journal was always correct.
    await postAllocationLine(CTX, TX, line(), 'bulk_allocate_bank_transactions');
    expect(confirmReceiptMatch).toHaveBeenCalledTimes(1);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('passes the invoice and the full bank-line amount', async () => {
    await postAllocationLine(CTX, TX, line(), 'bulk_allocate_bank_transactions');
    const [companyId, params] = confirmReceiptMatch.mock.calls[0]!;
    expect(companyId).toBe(CTX.companyId);
    expect(params.bankTxId).toBe(TX);
    expect(params.allocations).toEqual([{ invoiceId: INVOICE, amount: 218344.80 }]);
  });

  it('carries the FULL agent identity, not just the posting agent', async () => {
    // Mutation: pass `{ postingAgent }` alone and actorTokenJti is lost, which
    // drops the posting out of the token-scoped view of list_agent_postings —
    // the control surface every other agent write depends on (migration 530).
    await postAllocationLine(CTX, TX, line(), 'bulk_allocate_bank_transactions');
    const params = confirmReceiptMatch.mock.calls[0]![1];
    expect(params.postingOpts).toMatchObject({
      postingAgent: expect.stringContaining('mcp:'),
      actorTokenJti: 'jti-123',
    });
  });

  it('uses the MAGNITUDE of an outbound bank amount', async () => {
    // A supplier payment is money out and stored negative. Passing the signed
    // value would allocate -R500 and never match the bill.
    fetchBankTransaction.mockResolvedValue({ amount: -500, transactionDate: '2025-12-19' });
    await postAllocationLine(CTX, TX, line({ allocType: 'supplier' }), 'allocate_bank_transaction');
    const params = applyBankLineToSupplierInvoices.mock.calls[0]![1];
    expect(params.allocations[0].amount).toBe(500);
  });
});

describe('postAllocationLine — supplier payment naming an invoice', () => {
  // The suite default is the CUSTOMER fixture, +R218,344.80 — money in. A
  // supplier payment is money OUT and stored negative, and since 2026-09-07 a
  // money-in line naming a bill is refused rather than applied at its magnitude
  // (`signMismatchReason`), so the sign has to be the real one here.
  beforeEach(() => {
    fetchBankTransaction.mockResolvedValue({ amount: -218344.80, transactionDate: '2025-12-19' });
  });

  it('applies through applyBankLineToSupplierInvoices', async () => {
    await postAllocationLine(CTX, TX, line({ allocType: 'supplier' }), 'bulk_allocate_bank_transactions');
    expect(applyBankLineToSupplierInvoices).toHaveBeenCalledTimes(1);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('returns the journal the service posted, so the batch can reverse it', async () => {
    const r = await postAllocationLine(CTX, TX, line({ allocType: 'supplier' }), 'bulk_allocate_bank_transactions');
    expect(r.journalEntryId).toBe('je-supp');
    expect(r.transactionId).toBe(TX);
  });
});

describe('postAllocationLine — everything else is untouched', () => {
  it('posts a plain journal when no invoice is named', async () => {
    const r = await postAllocationLine(CTX, TX, line({ invoiceId: undefined }), 'allocate_bank_transaction');
    expect(allocateTransaction).toHaveBeenCalledTimes(1);
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
    expect(r.journalEntryId).toBe('je-plain');
  });

  it('posts a plain journal for a GL-account allocation even with an invoice id', async () => {
    // 'account' has no subledger document to apply to. Routing it would be a
    // category error, not a courtesy.
    await postAllocationLine(
      CTX, TX,
      line({ allocType: 'account', contraAccountId: 'acc-1' }),
      'allocate_bank_transaction',
    );
    expect(allocateTransaction).toHaveBeenCalledTimes(1);
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
    expect(applyBankLineToSupplierInvoices).not.toHaveBeenCalled();
  });

  it('posts a plain journal for a transfer', async () => {
    await postAllocationLine(CTX, TX, line({ allocType: 'transfer' }), 'allocate_bank_transaction');
    expect(allocateTransaction).toHaveBeenCalledTimes(1);
  });

  it('never calls allocateTransaction twice for one line', async () => {
    // The double-apply this design exists to avoid: the apply services call
    // allocateTransaction themselves, so the route must not also call it.
    await postAllocationLine(CTX, TX, line(), 'bulk_allocate_bank_transactions');
    expect(allocateTransaction).toHaveBeenCalledTimes(0);
    expect(confirmReceiptMatch).toHaveBeenCalledTimes(1);
  });

  it('propagates a refusal from the apply service rather than swallowing it', async () => {
    // Over-allocation refuses inside receiptAllocationLines. A caught-and-
    // logged failure here would post the journal and silently not apply — the
    // original bug wearing a different hat.
    confirmReceiptMatch.mockRejectedValue(new Error('R1000.00 exceeds the R600.00 outstanding'));
    await expect(
      postAllocationLine(CTX, TX, line(), 'bulk_allocate_bank_transactions'),
    ).rejects.toThrow(/exceeds the R600\.00 outstanding/);
  });
});
