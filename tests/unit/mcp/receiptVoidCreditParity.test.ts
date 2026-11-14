/**
 * WIRING, not arithmetic: how `reverse_allocations` (the one MCP reversal with a dry run) reaches the receipt credit
 * judgment (ar/customerVoidCredit) — the dry run and the live call run the SAME up-front judgment of the range's
 * receipts and refunds, so they refuse or pass together; the live call refuses before reversing any line; a set that
 * passes is reversed in line order with no retry, each receipt's own check only verifying the judgment; the dry run
 * keeps its idempotency key free. The per-day figures are a fixture (`customerCreditDays` stands in for its SQL); the
 * rule on them is the real `judgeCreditDays` (pinned in tests/unit/services/ar/customerVoidCredit.test.ts) and the
 * whole path runs on a real ledger in tests/integration/ar-receipt-void-after-refund-bulk.int.test.ts and
 * ar-receipt-credit-breaker.int.test.ts (a customer already below zero on an unrelated later date: breaker B).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', async () => (await import('../helpers/bankControlGateMocks')).importerGateOpen());
vi.mock('@/modules/accounting/services/bank/bankReversalGate', async () => (await import('../helpers/bankControlGateMocks')).reversalGateOpen());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const RECEIPT = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const REFUND = '11111111-1111-4111-8111-bbbbbbbbbbbb';
const LINE_RECEIPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LINE_REFUND = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** The fixture ledger: a receipt and the refund that spent it; `live` rows are not yet cancelled. */
const state = vi.hoisted(() => ({ unapplied: 500, live: new Set<string>(), lockCalls: 0 }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: readonly string[], ...values: unknown[]) => {
    const text = strings.join('?');
    const ids = ((values.find(Array.isArray) ?? []) as string[]);
    if (text.includes('FROM supplier_payments sp')) return [];
    if (text.includes('SELECT cp.id FROM customer_payments cp')) { // the receipts on the lines' journals
      return [...(ids.includes('je-receipt') ? [{ id: RECEIPT }] : []), ...(ids.includes('je-refund') ? [{ id: REFUND }] : [])];
    }
    if (text.includes('cp.client_id IS NOT NULL')) { // the named rows, live only
      return ids.filter((id) => state.live.has(id))
        .map((id) => ({ id, customer_id: 'cust', remainder: id === RECEIPT ? state.unapplied : -500 }));
    }
    return [];
  }),
}));
vi.mock('@/modules/accounting/services/ar/customerRunningCredit', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/customerRunningCredit')>()),
  customerCreditDays: vi.fn(async (_c: string, _cust: string, removals: { paymentId: string; amount?: number }[]) => {
    const row = (id: string, d: string, remainder: number) => {
      if (!state.live.has(id)) return { d, amount: 0, removed: 0, lowers: 0, others: 0 };
      const r = removals.find((x) => x.paymentId === id);
      const removed = r ? (r.amount ?? remainder) : 0;
      return { d, amount: remainder, removed, lowers: Math.max(removed, 0), others: r ? 0 : remainder };
    };
    return { customerName: 'Acme', days: [row(RECEIPT, '2026-03-04', state.unapplied), row(REFUND, '2026-03-05', -500)] };
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

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { unapplied: 500, live: new Set([RECEIPT, REFUND]), lockCalls: 0 });
  vi.mocked(bankGlAccountBelongsToCompany).mockResolvedValue(true);
  // Stands in for the unwind: each line's document asks its own check, then is cancelled.
  vi.mocked(reverseReconciledTransaction).mockImplementation(async (_c, lineId) => {
    const doc = lineId === LINE_RECEIPT ? RECEIPT : REFUND;
    await assertReceiptVoidKeepsCredit(COMPANY, [doc]);
    state.live.delete(doc);
    return { invoicesReopened: 0, amountUnapplied: 0, paymentsCancelled: 1 };
  });
});

describe('reverse_allocations: one judgment for the dry run and the live call', () => {
  it('a receipt whose refund is OUTSIDE the range: both refuse with the same wording; live reverses no line', async () => {
    vi.mocked(countAllocatedInRange).mockResolvedValue(1);
    vi.mocked(findAllocatedInRange).mockResolvedValue([row(LINE_RECEIPT, 'je-receipt')]);
    const dry = await outcome(reverseAllocationsTool.handler({ ...RANGE, dry_run: true }, ctx()));
    const live = await outcome(reverseAllocationsTool.handler(RANGE, ctx()));
    expect(dry).toMatchObject({ ok: false, code: 'RECEIPT_REFUSED' });
    expect(live).toMatchObject({ ok: false, code: 'RECEIPT_REFUSED', text: dry.text });
    expect(dry.text).toMatch(/would leave Acme owing the company: it takes R\s?500\.00 of unapplied cash .* from 2026-03-04/);
    expect(reverseReconciledTransaction).not.toHaveBeenCalled(); // refused up front, before any line
  });

  it('a receipt AND its refund: the dry run passes (key left free) and the live call reverses both, in line order, once each', async () => {
    vi.mocked(countAllocatedInRange).mockResolvedValue(2);
    vi.mocked(findAllocatedInRange).mockResolvedValue([row(LINE_RECEIPT, 'je-receipt'), row(LINE_REFUND, 'je-refund')]);
    const dry = await outcome(reverseAllocationsTool.handler({ ...RANGE, dry_run: true }, ctx()));
    expect(dry).toMatchObject({ ok: true, wroteNothing: true });
    expect(JSON.parse(dry.text).would_reverse).toBe(2);
    expect(state.lockCalls).toBe(0); // the judgment takes no lock
    expect((await outcome(reverseAllocationsTool.handler(RANGE, ctx()))).ok).toBe(true);
    expect(vi.mocked(reverseReconciledTransaction).mock.calls.map((c) => c[1])).toEqual([LINE_RECEIPT, LINE_REFUND]);
    expect(state.lockCalls).toBeGreaterThan(0); // each document's own step locks its customer to verify
  });

  it('a fully applied receipt lowers nothing: both pass without the customer lock', async () => {
    state.unapplied = 0;
    vi.mocked(countAllocatedInRange).mockResolvedValue(1);
    vi.mocked(findAllocatedInRange).mockResolvedValue([row(LINE_RECEIPT, 'je-receipt')]);
    expect((await outcome(reverseAllocationsTool.handler({ ...RANGE, dry_run: true }, ctx()))).ok).toBe(true);
    expect((await outcome(reverseAllocationsTool.handler(RANGE, ctx()))).ok).toBe(true);
    expect(state.lockCalls).toBe(0);
  });
});
