/**
 * bank-transactions-action records the person's decision on ISAFlow's suggestion after each coding verb:
 * allocate (accepted / recoded by the final target), split and match (never the one suggested target),
 * exclude (rejected), reverse and unmatch (an auto-posted line undone). The writer is mocked here; its SQL
 * is pinned in tests/unit/bank/codingDecisionLog.test.ts and against a schema in the integration suite.
 * The company and user come from the authenticated request, never from the body.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', async () => (await import('../helpers/bankControlGateMocks')).importerGateOpen());
vi.mock('@/modules/accounting/services/bank/bankReversalGate', async () => (await import('../helpers/bankControlGateMocks')).reversalGateOpen());
vi.mock('@/modules/accounting/services/bank/bankControlResponse', () => ({ respondIfBankControlRefused: () => false }));
import type { NextApiResponse } from 'next';

const { log } = vi.hoisted(() => ({
  log: {
    recordAllocationDecision: vi.fn(async () => undefined),
    recordAutoPostUndone: vi.fn(async () => undefined),
    recordExcluded: vi.fn(async () => undefined),
  },
}));
vi.mock('@/modules/accounting/services/bank/codingDecisionLog', () => log);
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

import handler from '../../../pages/api/accounting/bank-transactions-action';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankReconciliationService';

const CO = '00000000-0000-4000-8000-000000000001';
const USER = 'user-1';
const TX = '00000000-0000-4000-8000-000000000003';
const GL = '00000000-0000-4000-8000-000000000004';
const SUP = '00000000-0000-4000-8000-000000000005';
const FOREIGN_CO = '00000000-0000-4000-8000-0000000000ff';

const call = (body: Record<string, unknown>) =>
  handler({ method: 'POST', companyId: CO, user: { id: USER }, body } as never, {} as NextApiResponse) as Promise<{ kind: string }>;

beforeEach(() => vi.clearAllMocks());

describe('allocate', () => {
  it('to an account: the decision names the account the person chose', async () => {
    expect((await call({ action: 'allocate', bankTransactionId: TX, allocationType: 'account', contraAccountId: GL })).kind).toBe('success');
    expect(log.recordAllocationDecision).toHaveBeenCalledWith(CO, TX, USER, { glAccountId: GL, contactId: null });
  });
  it('to a supplier: the decision names the supplier', async () => {
    await call({ action: 'allocate', bankTransactionId: TX, allocationType: 'supplier', entityId: SUP });
    expect(log.recordAllocationDecision).toHaveBeenCalledWith(CO, TX, USER, { glAccountId: null, contactId: SUP });
  });
  it('a refused allocation records nothing', async () => {
    vi.mocked(allocateTransaction).mockRejectedValueOnce(new Error('period closed'));
    expect((await call({ action: 'allocate', bankTransactionId: TX, allocationType: 'account', contraAccountId: GL })).kind).toBe('badRequest');
    expect(log.recordAllocationDecision).not.toHaveBeenCalled();
  });
  it('a companyId in the body is not a field the route reads', async () => {
    await call({ action: 'allocate', bankTransactionId: TX, allocationType: 'account', contraAccountId: GL, companyId: FOREIGN_CO });
    for (const c of log.recordAllocationDecision.mock.calls as unknown as unknown[][]) expect(c[0]).toBe(CO);
  });
});

describe('the other verbs', () => {
  it('split: no single target, so recoded', async () => {
    await call({ action: 'split_allocate', bankTransactionId: TX, lines: [{ contraAccountId: GL, amount: 10 }] });
    expect(log.recordAllocationDecision).toHaveBeenCalledWith(CO, TX, USER, { glAccountId: null, contactId: null });
  });
  it('match to an existing journal line: no single suggested target either', async () => {
    await call({ action: 'match', bankTransactionId: TX, journalLineId: GL });
    expect(log.recordAllocationDecision).toHaveBeenCalledWith(CO, TX, USER, { glAccountId: null, contactId: null });
  });
  it('exclude: rejected', async () => {
    await call({ action: 'exclude', bankTransactionId: TX });
    expect(log.recordExcluded).toHaveBeenCalledWith(CO, TX, USER);
  });
  it('reverse and unmatch: an auto-posted decision undone', async () => {
    await call({ action: 'reverse', bankTransactionId: TX });
    await call({ action: 'unmatch', bankTransactionId: TX });
    expect(log.recordAutoPostUndone).toHaveBeenCalledTimes(2);
    expect(log.recordAutoPostUndone).toHaveBeenCalledWith(CO, TX, USER);
  });
});
