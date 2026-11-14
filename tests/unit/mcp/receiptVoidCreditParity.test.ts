/**
 * The receipt credit refusal (ar/customerVoidCredit, 2026-11-14) through the MCP reversals: a customer receipt whose
 * unapplied cash a refund has already returned cannot be cancelled. `reverse_allocations` (the range) is the one of
 * them with a dry run; it must refuse exactly when the live call does, write nothing, and leave the idempotency key
 * unspent. The live reversal asks the check from inside the unwind (`bankAllocationUnwind.unwindOnePayment`); here
 * `reverseReconciledTransaction` stands in for that and asks the REAL check, and the real credit-last retry
 * (`bank/reverseLinesCreditLast`) runs. `void_receipt`, `reverse_bank_allocation` and `_batch` have no dry run; their
 * refusal is the same throw (no catch in the handler), proven on a real ledger in
 * tests/integration/ar-receipt-void-after-refund*.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', async () => (await import('../helpers/bankControlGateMocks')).importerGateOpen());
vi.mock('@/modules/accounting/services/bank/bankReversalGate', async () => (await import('../helpers/bankControlGateMocks')).reversalGateOpen());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const state = vi.hoisted(() => ({ refundStands: true, unapplied: 500, lockCalls: 0 }));
const RECEIPT = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const REFUND = '11111111-1111-4111-8111-bbbbbbbbbbbb';
const LINE_RECEIPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LINE_REFUND = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** The ledger as the credit SQL would read it: R500 receipt, a R500 refund that spent it while it stands. */
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: readonly string[], ...values: unknown[]) => {
    const text = strings.join('?');
    const ids = (values.find(Array.isArray) ?? []) as string[];
    if (text.includes('FROM supplier_payments sp')) return [];
    if (text.includes('SELECT cp.id FROM customer_payments cp')) { // the receipts on the lines' journals
      return [...(ids.includes('je-receipt') ? [{ id: RECEIPT }] : []), ...(ids.includes('je-refund') ? [{ id: REFUND }] : [])];
    }
    if (text.includes('GROUP BY cp.client_id')) {
      return ids.includes(RECEIPT) ? [{ customer_id: 'cust', lowers: state.unapplied }] : [];
    }
    if (text.includes('WITH pay AS')) {
      const together = ids.includes(RECEIPT) && ids.includes(REFUND);
      const after = together || !state.refundStands ? 0 : -state.unapplied;
      return [{ customer_name: 'Acme', from_date: '2026-03-04', lowers: state.unapplied, lowest: after + state.unapplied, lowest_after: after }];
    }
    return [];
  }),
}));
vi.mock('@/modules/accounting/services/ar/customerCreditLock', () => ({
  tryLockCustomerCredit: vi.fn(async () => { state.lockCalls += 1; }),
}));
vi.mock('@/modules/accounting/services/shared/journalChainHead', () => ({ findJournalChainRoot: vi.fn(async (_c: string, je: string) => je) }));
vi.mock('@/modules/accounting/services/ap/supplierVoidCredit', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ap/supplierVoidCredit')>()),
  assertVoidKeepsCredit: vi.fn(async () => {}),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({ reverseReconciledTransaction: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankAllocationRangeService', () => ({ findAllocatedInRange: vi.fn(), countAllocatedInRange: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankStatementImportService', () => ({ bankGlAccountBelongsToCompany: vi.fn() }));

import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { countAllocatedInRange, findAllocatedInRange } from '@/modules/accounting/services/bank/bankAllocationRangeService';
import { bankGlAccountBelongsToCompany } from '@/modules/accounting/services/bank/bankStatementImportService';
import { assertReceiptVoidKeepsCredit } from '@/modules/accounting/services/ar/customerVoidCredit';
import { reverseAllocationsTool } from '@/lib/mcp/tools/writeBankReverseRange';
import { thrownToolErrorText } from '@/lib/mcp/thrownToolErrorText';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '33333333-3333-4333-8333-333333333333';
const RANGE = { bank_account_id: '22222222-2222-4222-8222-222222222222', from_date: '2026-03-01', to_date: '2026-03-31', idempotency_key: 'k1' };
const ctx = () => ({ userId: '44444444-4444-4444-8444-444444444444', companyId: COMPANY, scopes: ['write:bank-tx', 'write:post'], tokenJti: 'jti', oauthAppId: null }) as McpToolContext;
const row = (id: string, je: string) => ({ id, transactionDate: '2026-03-04', amount: 500, description: 'x', reference: null, journalEntryId: je, allocationBatchId: null, allocationRuleName: null });
const outcome = (p: Promise<McpToolResult>) => p.then(
  (r) => ({ ok: !r.isError, wroteNothing: r.wroteNothing === true, text: r.content[0]!.text }),
  (e: unknown) => ({ ok: false, wroteNothing: false, text: thrownToolErrorText('reverse_allocations', e), code: (e as { code?: string }).code }));

/** Stands in for the unwind: the receipt's line asks the real check; the refund's line reversal raises the credit. */
function liveReversal() {
  vi.mocked(reverseReconciledTransaction).mockImplementation(async (_c, lineId) => {
    if (lineId === LINE_RECEIPT) await assertReceiptVoidKeepsCredit(COMPANY, [RECEIPT]);
    else state.refundStands = false;
    return { invoicesReopened: 0, amountUnapplied: 0, paymentsCancelled: 1 };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { refundStands: true, unapplied: 500, lockCalls: 0 });
  vi.mocked(bankGlAccountBelongsToCompany).mockResolvedValue(true);
  liveReversal();
});

describe('reverse_allocations: the receipt credit refusal, dry run and live alike', () => {
  it('a receipt whose refund is OUTSIDE the range: the dry run refuses as the live call does, naming the figures', async () => {
    vi.mocked(countAllocatedInRange).mockResolvedValue(1);
    vi.mocked(findAllocatedInRange).mockResolvedValue([row(LINE_RECEIPT, 'je-receipt')]);
    const dry = await outcome(reverseAllocationsTool.handler({ ...RANGE, dry_run: true }, ctx()));
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
    const live = await outcome(reverseAllocationsTool.handler(RANGE, ctx()));
    expect(dry).toMatchObject({ ok: false, code: 'RECEIPT_REFUSED' });
    expect(live).toMatchObject({ ok: false, code: 'RECEIPT_REFUSED' });
    for (const o of [dry, live]) {
      expect(o.text).toMatch(/would leave Acme owing the company: it takes R\s?500\.00 of unapplied cash .* from 2026-03-04/);
      expect(o.text).toMatch(/Reverse the refund first/);
    }
    // the live call retried the refused line once, after the rest, then gave up — all-or-nothing
    expect(reverseReconciledTransaction).toHaveBeenCalledTimes(2);
  });

  it('a receipt AND its refund in the range: the dry run passes (judged together) and the live call reverses both', async () => {
    vi.mocked(countAllocatedInRange).mockResolvedValue(2);
    vi.mocked(findAllocatedInRange).mockResolvedValue([row(LINE_RECEIPT, 'je-receipt'), row(LINE_REFUND, 'je-refund')]);
    const dry = await outcome(reverseAllocationsTool.handler({ ...RANGE, dry_run: true }, ctx()));
    expect(dry).toMatchObject({ ok: true, wroteNothing: true });
    expect(JSON.parse(dry.text).would_reverse).toBe(2);
    const live = await outcome(reverseAllocationsTool.handler(RANGE, ctx()));
    expect(live.ok).toBe(true);
    // receipt refused while the refund stood, refund reversed, receipt retried and passed
    expect(vi.mocked(reverseReconciledTransaction).mock.calls.map((c) => c[1])).toEqual([LINE_RECEIPT, LINE_REFUND, LINE_RECEIPT]);
  });

  it('a fully applied receipt lowers nothing: the dry run passes without taking the customer lock', async () => {
    state.unapplied = 0;
    vi.mocked(countAllocatedInRange).mockResolvedValue(1);
    vi.mocked(findAllocatedInRange).mockResolvedValue([row(LINE_RECEIPT, 'je-receipt')]);
    expect((await outcome(reverseAllocationsTool.handler({ ...RANGE, dry_run: true }, ctx()))).ok).toBe(true);
    expect((await outcome(reverseAllocationsTool.handler(RANGE, ctx()))).ok).toBe(true);
    expect(state.lockCalls).toBe(0);
  });
});
