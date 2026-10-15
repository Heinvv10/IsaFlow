/**
 * bulk_allocate_bank_transactions: an account line onto AP/AR control is SKIPPED by the pre-check, not handed to
 * allocateTransaction. Its refusal there would unwind the whole batch (bulkAllocationPost rethrows any non-race
 * error), so one bad line failed every good line beside it. The pre-check reads once for the batch and reports
 * the line as a skip with the guard's own sentence.
 */
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({ findBankTransactionAllocationStates: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankLineJournalGate', () => ({ handKeyedAccountLineSkips: vi.fn(async () => new Map()) }));
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/bank/bankLineImporterGate')>()),
  importerHeldLineSkips: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/bank/contactControlGuard', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/bank/contactControlGuard')>()),
  contactControlLineSkips: vi.fn(),
}));
vi.mock('@/lib/mcp/tools/allocationApplyRoute', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/tools/allocationApplyRoute')>()),
  fetchInvoiceStates: vi.fn(async () => new Map()),
}));

import { findBankTransactionAllocationStates } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { contactControlLineSkips } from '@/modules/accounting/services/bank/contactControlGuard';
import { partitionAllocationLines } from '@/lib/mcp/tools/bulkAllocationSkip';
import type { ResolvedLine } from '@/lib/mcp/tools/bulkAllocationPrepare';

const TX = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AP = '0b000000-0000-4000-8000-000000000001';
const FUEL = '0b000000-0000-4000-8000-000000000002';
const resolved = (n: number, contraAccountId: string): ResolvedLine => ({
  index: n - 1, txId: TX(n),
  line: { selector: { transactionId: TX(n) }, contraAccountId, allocType: 'account', entityId: '', autoApply: 'fifo' } as never,
});

beforeEach(() => {
  vi.mocked(findBankTransactionAllocationStates).mockResolvedValue(new Map([1, 2, 3].map((n) => [TX(n), {
    id: TX(n), status: 'imported', matchedJournalLineId: null, amount: -100, feedState: 'posted',
  }])) as never);
  vi.mocked(contactControlLineSkips).mockImplementation(async (_c, lines) =>
    new Map(lines.filter((l) => l.accountId === AP).map((l) => [l.txId, 'This allocation posts to the accounts payable control account: name the supplier instead (allocate it as a supplier), so it gets its document'])));
});

it('skips the AP-control line with the guard\'s sentence and keeps the rest postable', async () => {
  const { postable, skipped } = await partitionAllocationLines('c-1', [resolved(1, FUEL), resolved(2, AP), resolved(3, FUEL)], 'u-1');
  expect(postable.map((l) => l.txId)).toEqual([TX(1), TX(3)]);
  expect(skipped).toEqual([{ index: 1, transaction_id: TX(2), reason: expect.stringMatching(/accounts payable control account/) }]);
  // One read for the batch, over the account lines.
  expect(vi.mocked(contactControlLineSkips).mock.calls).toEqual([[
    'c-1', [{ txId: TX(1), accountId: FUEL }, { txId: TX(2), accountId: AP }, { txId: TX(3), accountId: FUEL }],
  ]]);
});
