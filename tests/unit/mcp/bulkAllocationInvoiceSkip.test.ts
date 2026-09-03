/**
 * A bad invoice on one line SKIPS that line — it does not unwind the batch.
 *
 * `receiptAllocationLines` refuses an over-allocation by THROWING, mid-write.
 * In `bulk_allocate_bank_transactions` that throw unwinds the tool's single
 * savepoint, so one line whose invoice was part-paid five minutes ago rolls
 * back the 199 good lines beside it and the caller's only recourse is to
 * bisect the batch by hand — the exact work the bulk tool exists to remove.
 *
 * This module's own rule decides it: a refusal is about the REQUEST, a skip is
 * about the DATA. An invoice's remaining balance is data state, so it is a skip
 * with a reason, the way `bulk_allocate` already skips allocated and excluded
 * rows. The single-line tools still refuse, because there the caller named one
 * invoice and one amount and the fault IS the request.
 *
 * Because the check is a READ that runs before the first write, it is also what
 * `dry_run` reports — a dry run that passed where the live call refuses would
 * defeat the point of previewing a batch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findBankTransactionAllocationStates, sqlMock } = vi.hoisted(() => ({
  findBankTransactionAllocationStates: vi.fn(),
  sqlMock: vi.fn(),
}));

vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionAllocationStates,
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

import { partitionAllocationLines } from '@/lib/mcp/tools/bulkAllocationSkip';
import { skipReasonForInvoice } from '@/lib/mcp/tools/allocationApplyRoute';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TX1 = 'ttttttt1-tttt-tttt-tttt-tttttttttttt';
const TX2 = 'ttttttt2-tttt-tttt-tttt-tttttttttttt';
const INV_OK = 'iiiiiii1-iiii-iiii-iiii-iiiiiiiiiiii';
const INV_SETTLED = 'iiiiiii2-iiii-iiii-iiii-iiiiiiiiiiii';

function resolved(index: number, txId: string, invoiceId: string) {
  return {
    index,
    txId,
    line: {
      allocType: 'customer', entityId: 'e1', invoiceId,
      contraAccountId: undefined, description: 'Receipt', vatCode: undefined,
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  findBankTransactionAllocationStates.mockResolvedValue(new Map([
    [TX1, { id: TX1, status: 'imported', matchedJournalLineId: null, amount: 100 }],
    [TX2, { id: TX2, status: 'imported', matchedJournalLineId: null, amount: 100 }],
  ]));
  // One invoice open at R500, one already settled.
  sqlMock.mockResolvedValue([
    { id: INV_OK, invoice_number: 'INV-1', total_amount: '500.00', amount_paid: '0.00', status: 'approved' },
    { id: INV_SETTLED, invoice_number: 'INV-2', total_amount: '500.00', amount_paid: '500.00', status: 'paid' },
  ]);
});

describe('partitionAllocationLines — invoice state', () => {
  it('skips the bad line and still posts the good one', async () => {
    // Mutation: remove the invoice pass and BOTH lines become postable, so the
    // settled one reaches receiptAllocationLines and throws, unwinding both.
    const { postable, skipped } = await partitionAllocationLines(COMPANY, [
      resolved(0, TX1, INV_OK),
      resolved(1, TX2, INV_SETTLED),
    ]);
    expect(postable).toHaveLength(1);
    expect(postable[0]!.index).toBe(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.index).toBe(1);
  });

  it('names the offending line by the index the CALLER sent', async () => {
    // An agent cannot bisect a 200-line batch from a reason that does not say
    // which line it belongs to.
    const { skipped } = await partitionAllocationLines(COMPANY, [
      resolved(7, TX2, INV_SETTLED),
    ]);
    expect(skipped[0]!.index).toBe(7);
    expect(skipped[0]!.transaction_id).toBe(TX2);
    expect(skipped[0]!.reason).toMatch(/already settled/);
  });

  it('leaves a line naming no invoice completely alone', async () => {
    const line = resolved(0, TX1, INV_OK) as unknown as { line: { invoiceId?: string } };
    line.line.invoiceId = undefined;
    const { postable, skipped } = await partitionAllocationLines(COMPANY, [line as never]);
    expect(postable).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it('still skips on row state before it ever looks at the invoice', async () => {
    findBankTransactionAllocationStates.mockResolvedValue(new Map([
      [TX1, { id: TX1, status: 'allocated', matchedJournalLineId: 'jl-1', amount: 100 }],
    ]));
    const { postable, skipped } = await partitionAllocationLines(COMPANY, [resolved(0, TX1, INV_OK)]);
    expect(postable).toHaveLength(0);
    expect(skipped[0]!.reason).toMatch(/already allocated/);
  });
});

describe('skipReasonForInvoice', () => {
  const open = { invoiceNumber: 'INV-1', outstanding: 500, status: 'approved' };

  it('allows an amount within the outstanding balance', () => {
    expect(skipReasonForInvoice(open, INV_OK, 500)).toBeNull();
    expect(skipReasonForInvoice(open, INV_OK, 250)).toBeNull();
  });

  it('refuses an over-allocation, quoting both figures', () => {
    const r = skipReasonForInvoice(open, INV_OK, 600);
    expect(r).toMatch(/R600\.00 exceeds the R500\.00 outstanding on invoice INV-1/);
  });

  it('tolerates a cent of rounding rather than refusing on it', () => {
    expect(skipReasonForInvoice(open, INV_OK, 500.005)).toBeNull();
  });

  it('reports a settled invoice, a draft and a cancellation distinctly', () => {
    expect(skipReasonForInvoice({ ...open, outstanding: 0 }, INV_OK, 10)).toMatch(/already settled/);
    expect(skipReasonForInvoice({ ...open, status: 'draft' }, INV_OK, 10)).toMatch(/is draft/);
    expect(skipReasonForInvoice({ ...open, status: 'cancelled' }, INV_OK, 10)).toMatch(/is cancelled/);
  });

  it('reports a missing invoice without revealing another tenant has it', () => {
    const r = skipReasonForInvoice(undefined, INV_OK, 10);
    expect(r).toBe(`invoice ${INV_OK} not found`);
  });
});
