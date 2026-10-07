/**
 * Task 3 (fix round 1, finding 3) — `bank-transactions-action`'s pending-feed
 * coverage the integration suite doesn't reach:
 *   - `save_selection`'s UPDATE carries the `feed_state = 'posted'` predicate.
 *   - a bare `BankTransactionNotPostedError` (match/unmatch/exclude) maps to
 *     409, not the route's generic 400 branch.
 *   - a `BankAllocationRefusal` carrying the feed state (allocate/split) is
 *     409 too — one status for a pending-row refusal (F-M1); any other
 *     `BankAllocationRefusal` keeps the route's 400.
 *   - save_selection on a non-posted row answers 409 from a pre-read instead
 *     of `{ saved: true }` for a no-op UPDATE (F-M2).
 *
 * Only the SQL layer and the service module are mocked; the real handler and
 * the real error-mapping catch block run, following the pattern in
 * tests/unit/services/bankFeedSyncRouteRefusal.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/core/retryableContention', () => ({
  isRetryableContention: vi.fn(() => false),
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  assertCustomerInCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalCostCentreValidation', () => ({
  assertJournalAnalysisDimensions: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  matchTransaction: vi.fn(),
  unmatchTransaction: vi.fn(),
  excludeTransaction: vi.fn(),
  autoMatchTransactions: vi.fn(),
  allocateTransaction: vi.fn(),
  splitAllocateTransaction: vi.fn(),
  deleteTransactions: vi.fn(),
  bulkAcceptTransactions: vi.fn(),
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_res: unknown, message: string) => ({ kind: 'badRequest', message })),
    conflict: vi.fn((_res: unknown, message: string) => ({ kind: 'conflict', message })),
    validationError: vi.fn((_res: unknown, errors: unknown) => ({ kind: 'validationError', errors })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));

import handler from '../../../../pages/api/accounting/bank-transactions-action';
import { matchTransaction, allocateTransaction } from '@/modules/accounting/services/bank/bankReconciliationService';
import { BankTransactionNotPostedError, assertPostedForAllocation } from '@/modules/accounting/services/bank/bankFeedStateGuard';
import { BankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000002';
const BANK_TX_ID = '00000000-0000-0000-0000-000000000003';
const JOURNAL_LINE_ID = '00000000-0000-0000-0000-000000000004';

function req(body: Record<string, unknown>) {
  return { method: 'POST', companyId: COMPANY_ID, user: { id: USER_ID }, body } as never;
}

beforeEach(() => vi.clearAllMocks());

describe('save_selection — feed_state predicate', () => {
  it("a posted row: the UPDATE runs and still carries status IN (...) AND feed_state = 'posted'", async () => {
    sqlMock.mockResolvedValueOnce([{ feed_state: 'posted' }]).mockResolvedValue([]);

    const out = await handler(req({
      action: 'save_selection', bankTransactionId: BANK_TX_ID, selectionType: 'account',
    }), {} as NextApiResponse) as { kind: string };

    expect(out.kind).toBe('success');
    expect(sqlMock).toHaveBeenCalledTimes(2);
    const text = (sqlMock.mock.calls[1]![0] as TemplateStringsArray).join('?');
    expect(text).toMatch(/UPDATE bank_transactions/);
    expect(text).toMatch(/status IN/);
    expect(text).toMatch(/feed_state = 'posted'/);
  });

  it.each([['pending', /still pending at the bank/], ['removed', /removed by the bank/]])(
    'a %s row answers 409 and writes nothing (F-M2)', async (state, message) => {
      sqlMock.mockResolvedValueOnce([{ feed_state: state }]).mockResolvedValue([]);

      const out = await handler(req({
        action: 'save_selection', bankTransactionId: BANK_TX_ID, selectionType: 'account',
      }), {} as NextApiResponse) as { kind: string; message: string };

      expect(out).toEqual({ kind: 'conflict', message: expect.stringMatching(message) });
      expect(sqlMock).toHaveBeenCalledTimes(1);
    },
  );
});

describe('bank-transactions-action — pending-row refusal mapping', () => {
  it('maps a bare BankTransactionNotPostedError (match) to 409', async () => {
    (matchTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new BankTransactionNotPostedError(BANK_TX_ID, 'pending', 'match'),
    );

    const out = await handler(req({
      action: 'match', bankTransactionId: BANK_TX_ID, journalLineId: JOURNAL_LINE_ID,
    }), {} as NextApiResponse) as { kind: string; message: string };

    expect(out.kind).toBe('conflict');
    expect(out.message).toMatch(/still pending at the bank/);
  });

  it("maps allocate's feed-state BankAllocationRefusal to 409 too (F-M1)", async () => {
    let refusal: unknown;
    try { assertPostedForAllocation({ feed_state: 'pending' }, BANK_TX_ID, 'allocate'); } catch (e) { refusal = e; }
    (allocateTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(refusal);

    const out = await handler(req({
      action: 'allocate', bankTransactionId: BANK_TX_ID, allocationType: 'account',
      contraAccountId: '00000000-0000-0000-0000-000000000005',
    }), {} as NextApiResponse) as { kind: string; message: string };

    expect(out.kind).toBe('conflict');
    expect(out.message).toMatch(/still pending at the bank/);
  });

  it('leaves any other BankAllocationRefusal on the 400 branch', async () => {
    (allocateTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new BankAllocationRefusal('Transaction already allocated — cannot allocate'),
    );

    const out = await handler(req({
      action: 'allocate', bankTransactionId: BANK_TX_ID, allocationType: 'account',
      contraAccountId: '00000000-0000-0000-0000-000000000005',
    }), {} as NextApiResponse) as { kind: string };

    expect(out.kind).toBe('badRequest');
  });
});
