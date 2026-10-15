/**
 * PR #711 — `bank-transactions-action` split_allocate: each line names EXACTLY
 * one target (a GL account, or a supplier/customer), as the MCP tool requires.
 * Before, a line naming both silently dropped the account, and a contactId with
 * no contactType silently became a GL line. Amounts are positive rand and cents.
 *
 * The real handler and schema run; only the service and the I/O are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', async () => (await import('../helpers/bankControlGateMocks')).importerGateOpen());
vi.mock('@/modules/accounting/services/bank/bankReversalGate', async () => (await import('../helpers/bankControlGateMocks')).reversalGateOpen());
vi.mock('@/modules/accounting/services/bank/bankControlResponse', () => ({ respondIfBankControlRefused: () => false }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  matchTransaction: vi.fn(), unmatchTransaction: vi.fn(), excludeTransaction: vi.fn(), autoMatchTransactions: vi.fn(),
  allocateTransaction: vi.fn(), splitAllocateTransaction: vi.fn(async () => ({ journalEntryId: 'je-1' })),
  deleteTransactions: vi.fn(), bulkAcceptTransactions: vi.fn(), reverseReconciledTransaction: vi.fn(),
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

import handler from '../../../pages/api/accounting/bank-transactions-action';
import { splitAllocateTransaction } from '@/modules/accounting/services/bank/bankReconciliationService';
import { apiResponse } from '@/lib/apiResponse';

const TX = '00000000-0000-4000-8000-000000000003';
const ACCT = '00000000-0000-4000-8000-0000000000aa';
const SUP = '00000000-0000-4000-8000-0000000000bb';
const split = (lines: Record<string, unknown>[]) => handler(
  { method: 'POST', companyId: 'c-1', user: { id: 'u-1' }, body: { action: 'split_allocate', bankTransactionId: TX, lines } } as never,
  {} as never,
);
const gl = { contraAccountId: ACCT, amount: 100 };

beforeEach(() => vi.clearAllMocks());

describe('split_allocate lines name exactly one target', () => {
  it.each([
    ['both an account and a supplier', { contraAccountId: ACCT, contactType: 'supplier', contactId: SUP, amount: 100 }],
    ['a contactId with no contactType', { contactId: SUP, amount: 100 }],
    ['a contactType with no contactId', { contactType: 'supplier', amount: 100 }],
    ['neither', { amount: 100 }],
    ['autoApply on a GL line', { contraAccountId: ACCT, amount: 100, autoApply: 'none' }],
    ['dimensions on a supplier line', { contactType: 'supplier', contactId: SUP, amount: 100, cc2Id: ACCT }],
    ['a zero amount', { contactType: 'supplier', contactId: SUP, amount: 0 }],
    ['a negative amount', { contactType: 'supplier', contactId: SUP, amount: -100 }],
    ['a fraction of a cent', { contactType: 'supplier', contactId: SUP, amount: 100.005 }],
  ])('refuses %s, before the service', async (_what, line) => {
    expect(await split([gl, line])).toMatchObject({ kind: 'validationError' });
    expect(splitAllocateTransaction).not.toHaveBeenCalled();
  });

  it('passes an account line and a supplier line through to the service', async () => {
    const line = { contactType: 'supplier', contactId: SUP, amount: 59.48, autoApply: 'none' };
    expect(await split([gl, line])).toMatchObject({ kind: 'success' });
    expect(apiResponse.validationError).not.toHaveBeenCalled();
    expect(vi.mocked(splitAllocateTransaction).mock.calls[0]![2]).toEqual([gl, line]);
  });
});
