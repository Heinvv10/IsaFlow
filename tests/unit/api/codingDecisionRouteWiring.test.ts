/**
 * bank-transactions-action no longer writes the learning-loop log itself: each service records its own
 * decision (codingDecisionLog, called from allocate / split / match / exclude / unmatch / reverse), so the MCP
 * tools and the other routes are covered too. What the route owns is handing every service the company and
 * the person from the authenticated request, never from the body. The services' own logging runs against a
 * real schema in tests/integration/coding-decision-paths.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', async () => (await import('../helpers/bankControlGateMocks')).importerGateOpen());
vi.mock('@/modules/accounting/services/bank/bankReversalGate', async () => (await import('../helpers/bankControlGateMocks')).reversalGateOpen());
vi.mock('@/modules/accounting/services/bank/bankControlResponse', () => ({ respondIfBankControlRefused: () => false }));
import type { NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  assertCustomerInCompany: vi.fn(), assertSupplierInCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  matchTransaction: vi.fn(async () => ({})),
  unmatchTransaction: vi.fn(async () => ({})),
  excludeTransaction: vi.fn(async () => ({})),
  autoMatchTransactions: vi.fn(),
  allocateTransaction: vi.fn(async () => ({ journalEntryId: 'je' })),
  splitAllocateTransaction: vi.fn(async () => ({ journalEntryId: 'je' })),
  deleteTransactions: vi.fn(),
  bulkAcceptTransactions: vi.fn(),
  reverseReconciledTransaction: vi.fn(async () => undefined),
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

import { readFileSync } from 'node:fs';
import handler from '../../../pages/api/accounting/bank-transactions-action';
import {
  allocateTransaction, excludeTransaction, matchTransaction, reverseReconciledTransaction, splitAllocateTransaction,
  unmatchTransaction,
} from '@/modules/accounting/services/bank/bankReconciliationService';

const CO = '00000000-0000-4000-8000-000000000001';
const USER = 'user-1';
const TX = '00000000-0000-4000-8000-000000000003';
const GL = '00000000-0000-4000-8000-000000000004';
const SUP = '00000000-0000-4000-8000-000000000005';
const FOREIGN_CO = '00000000-0000-4000-8000-0000000000ff';

const call = (body: Record<string, unknown>) =>
  handler({ method: 'POST', companyId: CO, user: { id: USER }, body } as never, {} as NextApiResponse) as Promise<{ kind: string }>;

beforeEach(() => vi.clearAllMocks());

const JL = '00000000-0000-4000-8000-000000000006';

describe('every coding verb hands the service the authenticated person', () => {
  it('match: the person, so the service can record the decision', async () => {
    expect((await call({ action: 'match', bankTransactionId: TX, journalLineId: JL })).kind).toBe('success');
    expect(matchTransaction).toHaveBeenCalledWith(CO, TX, JL, undefined, USER);
  });
  it('unmatch and exclude', async () => {
    await call({ action: 'unmatch', bankTransactionId: TX });
    await call({ action: 'exclude', bankTransactionId: TX, excludeReason: 'dup' });
    expect(unmatchTransaction).toHaveBeenCalledWith(CO, TX, USER);
    expect(excludeTransaction).toHaveBeenCalledWith(CO, TX, 'dup', USER);
  });
  it('allocate, split and reverse', async () => {
    await call({ action: 'allocate', bankTransactionId: TX, allocationType: 'account', contraAccountId: GL });
    await call({ action: 'split_allocate', bankTransactionId: TX, lines: [{ contraAccountId: GL, amount: 10 }] });
    await call({ action: 'reverse', bankTransactionId: TX });
    expect(vi.mocked(allocateTransaction).mock.calls[0]!.slice(0, 4)).toEqual([CO, TX, GL, USER]);
    expect(vi.mocked(splitAllocateTransaction).mock.calls[0]!.slice(0, 1)).toEqual([CO]);
    expect(vi.mocked(splitAllocateTransaction).mock.calls[0]![3]).toBe(USER);
    expect(reverseReconciledTransaction).toHaveBeenCalledWith(CO, TX, USER);
  });
  it('a companyId in the body is not a field the route reads', async () => {
    await call({ action: 'allocate', bankTransactionId: TX, allocationType: 'account', contraAccountId: GL, companyId: FOREIGN_CO });
    await call({ action: 'match', bankTransactionId: TX, journalLineId: JL, companyId: FOREIGN_CO });
    expect(vi.mocked(allocateTransaction).mock.calls[0]![0]).toBe(CO);
    expect(vi.mocked(matchTransaction).mock.calls[0]![0]).toBe(CO);
  });
});

describe('the route does not write the log itself', () => {
  it('imports nothing from codingDecisionLog (a second write would double-count)', () => {
    const src = readFileSync('pages/api/accounting/bank-transactions-action.ts', 'utf8');
    expect(src).not.toMatch(/codingDecisionLog/);
  });
});
