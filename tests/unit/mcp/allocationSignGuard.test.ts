/**
 * A bank line whose SIGN contradicts the invoice it names is refused, never
 * applied.
 *
 * The GL half of the sign defect is fixed in `allocateTransaction`: a supplier
 * refund now posts DR Bank / CR AP instead of the payment direction. The APPLY
 * half cannot be fixed the same way. `confirmReceiptMatch` and
 * `applyBankLineToSupplierInvoices` take the ABSOLUTE value of the line and
 * apply it as a settlement, so a refund named against a bill would settle that
 * bill by the refund's value — money flowing back IN recorded as the bill being
 * paid. There is no refund-allocation concept to route it to, and inventing one
 * silently is the same class of guess the sign bug was.
 *
 * So: refuse on the single-line tools (the caller named one line and one
 * invoice — the fault IS the request), skip on the bulk tool (one contradictory
 * line must not unwind 499 correct ones). Both reasons come from the same pure
 * function, and because the check is a pre-write READ, `dry_run` reports it too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  findBankTransactionAllocationStates, sqlMock,
  fetchBankTransaction, confirmReceiptMatch, applyBankLineToSupplierInvoices,
} = vi.hoisted(() => ({
  findBankTransactionAllocationStates: vi.fn(),
  sqlMock: vi.fn(),
  fetchBankTransaction: vi.fn(),
  confirmReceiptMatch: vi.fn(),
  applyBankLineToSupplierInvoices: vi.fn(),
}));

vi.mock('@/modules/accounting/services/bank/bankMatchDbQueries', () => ({
  fetchBankTransaction,
}));
vi.mock('@/modules/accounting/services/ar/receiptMatchConfirmService', () => ({
  confirmReceiptMatch,
}));
vi.mock('@/modules/accounting/services/ap/supplierBankPaymentService', () => ({
  applyBankLineToSupplierInvoices,
}));

vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionAllocationStates,
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

import { partitionAllocationLines } from '@/lib/mcp/tools/bulkAllocationSkip';
import { postAndApplyLine, signMismatchReason } from '@/lib/mcp/tools/allocationApplyRoute';
import { BankLineDirectionError } from '@/lib/mcp/bankLineDirectionError';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TX_IN = 'ttttttt1-tttt-tttt-tttt-tttttttttttt';
const TX_OUT = 'ttttttt2-tttt-tttt-tttt-tttttttttttt';
const INV = 'iiiiiii1-iiii-iiii-iiii-iiiiiiiiiiii';

describe('signMismatchReason', () => {
  it('refuses a money-IN line against a bill', () => {
    const r = signMismatchReason('supplier', 120290);
    expect(r).toMatch(/money IN/);
    expect(r).toMatch(/cannot settle a bill/);
    // The refusal has to say what to do instead, or the agent retries the same
    // payload. This is the one behaviour the brief named as non-negotiable:
    // guessing the direction is what must not remain.
    expect(r).toMatch(/drop invoice_id/);
    expect(r).toMatch(/120290\.00/);
  });

  it('allows a money-OUT line against a bill', () => {
    expect(signMismatchReason('supplier', -115)).toBeNull();
  });

  it('refuses a money-OUT line against a customer invoice', () => {
    const r = signMismatchReason('customer', -500);
    expect(r).toMatch(/money OUT/);
    expect(r).toMatch(/cannot settle a customer invoice/);
    // Rendered as a magnitude — an agent reading "R-500.00 is money OUT" has to
    // decide whether the minus is part of the claim or part of the number.
    expect(r).toMatch(/R500\.00/);
  });

  it('allows a money-IN line against a customer invoice', () => {
    expect(signMismatchReason('customer', 500)).toBeNull();
  });

  // A ZERO line is refused too, and the reason it must be is subtle. The
  // earlier version of this guard passed zero through on the reasoning that
  // `skipReasonForInvoice` would refuse it against the outstanding balance. It
  // does not: `skipReasonForInvoice(state, id, 0)` with R500 outstanding runs
  // `0 > 500.01` → false → null → the line is POSTABLE. It then reaches
  // `validateBankSupplierPayment` (`tx.amount >= 0`) or
  // `validateBankReceiptApplication` (`tx.amount <= 0`), both of which THROW —
  // mid-write, past the point `bulkAllocationSkip` can skip around it, so the
  // registry savepoint unwinds all 500 lines of the batch. One R0.00 statement
  // line would destroy a batch, which is the single outcome that file exists to
  // prevent. The guard therefore uses the SAME thresholds as the services it
  // fronts: >= 0 for a bill, <= 0 for a customer invoice.
  it('refuses a zero line, matching the services it fronts', () => {
    expect(signMismatchReason('supplier', 0)).toMatch(/R0\.00 settles nothing/);
    expect(signMismatchReason('customer', 0)).toMatch(/R0\.00 settles nothing/);
  });
});

function line(index: number, txId: string, allocType: 'supplier' | 'customer') {
  return {
    index,
    txId,
    line: {
      allocType, entityId: 'e1', invoiceId: INV,
      contraAccountId: undefined, description: 'x', vatCode: undefined,
    },
  } as never;
}

describe('partitionAllocationLines — the sign guard in a batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findBankTransactionAllocationStates.mockResolvedValue(new Map([
      [TX_IN, { id: TX_IN, status: 'imported', matchedJournalLineId: null, amount: 120290 }],
      [TX_OUT, { id: TX_OUT, status: 'imported', matchedJournalLineId: null, amount: -115 }],
    ]));
    sqlMock.mockResolvedValue([
      { id: INV, invoice_number: 'INV-1', total_amount: '500000.00', amount_paid: '0.00', status: 'approved' },
    ]);
  });

  it('skips the inverted line and posts the rest', async () => {
    const result = await partitionAllocationLines(COMPANY, [
      line(0, TX_IN, 'supplier'),
      line(1, TX_OUT, 'supplier'),
    ]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ index: 0, transaction_id: TX_IN });
    expect(result.skipped[0]!.reason).toMatch(/money IN/);
    expect(result.postable.map((l) => l.index)).toEqual([1]);
  });

  // The order matters: an impossible line must not eat the invoice's remaining
  // balance, or the correct line beside it is skipped for "exceeds the
  // outstanding" — a number the agent would then go and try to fix.
  it('does not let an inverted line consume the invoice balance', async () => {
    sqlMock.mockResolvedValue([
      { id: INV, invoice_number: 'INV-1', total_amount: '115.00', amount_paid: '0.00', status: 'approved' },
    ]);
    const result = await partitionAllocationLines(COMPANY, [
      line(0, TX_IN, 'supplier'),
      line(1, TX_OUT, 'supplier'),
    ]);
    expect(result.postable.map((l) => l.index)).toEqual([1]);
    expect(result.skipped[0]!.reason).not.toMatch(/outstanding/);
  });

  it('skips a zero line rather than letting it unwind the batch', async () => {
    findBankTransactionAllocationStates.mockResolvedValue(new Map([
      [TX_IN, { id: TX_IN, status: 'imported', matchedJournalLineId: null, amount: 0 }],
      [TX_OUT, { id: TX_OUT, status: 'imported', matchedJournalLineId: null, amount: -115 }],
    ]));
    const result = await partitionAllocationLines(COMPANY, [
      line(0, TX_IN, 'supplier'),
      line(1, TX_OUT, 'supplier'),
    ]);
    expect(result.skipped.map((s) => s.index)).toEqual([0]);
    expect(result.postable.map((l) => l.index)).toEqual([1]);
  });

  it('leaves a line that names no invoice alone, whatever its sign', async () => {
    const noInvoice = {
      index: 0,
      txId: TX_IN,
      line: {
        allocType: 'supplier', entityId: 'e1', invoiceId: undefined,
        contraAccountId: undefined, description: 'x', vatCode: undefined,
      },
    } as never;
    const result = await partitionAllocationLines(COMPANY, [noInvoice]);
    expect(result.skipped).toHaveLength(0);
    expect(result.postable).toHaveLength(1);
  });
});

describe('postAndApplyLine — the single-line refusal', () => {
  const ctx = {
    companyId: COMPANY,
    userId: '11111111-1111-1111-1111-111111111111',
  } as never;

  beforeEach(() => vi.clearAllMocks());

  it('throws before applying anything when the line points the wrong way', async () => {
    fetchBankTransaction.mockResolvedValue({ id: TX_IN, amount: 120290 });

    await expect(postAndApplyLine({
      ctx, txId: TX_IN, kind: 'supplier', invoiceId: INV, toolName: 'allocate_bank_transaction',
    })).rejects.toThrow(BankLineDirectionError);

    // The whole point of raising it PRE-write: a savepoint that unwinds is a
    // weaker guarantee than a write that never started, and the apply services
    // are the ones that move `amount_paid`.
    expect(applyBankLineToSupplierInvoices).not.toHaveBeenCalled();
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
  });

  it('carries the transaction id, so the registry can name it', async () => {
    fetchBankTransaction.mockResolvedValue({ id: TX_IN, amount: 120290 });
    await expect(postAndApplyLine({
      ctx, txId: TX_IN, kind: 'supplier', invoiceId: INV, toolName: 'allocate_bank_transaction',
    })).rejects.toMatchObject({ transactionId: TX_IN });
  });

  it('applies a correctly-signed line as before, at its ABSOLUTE value', async () => {
    fetchBankTransaction.mockResolvedValue({ id: TX_OUT, amount: -115 });
    applyBankLineToSupplierInvoices.mockResolvedValue({ journalEntryId: 'je-1' });

    const result = await postAndApplyLine({
      ctx, txId: TX_OUT, kind: 'supplier', invoiceId: INV, toolName: 'allocate_bank_transaction',
    });

    expect(result).toEqual({ journalEntryId: 'je-1', transactionId: TX_OUT });
    const [, params] = applyBankLineToSupplierInvoices.mock.calls[0]!;
    expect(params.allocations).toEqual([{ invoiceId: INV, amount: 115 }]);
  });
});
