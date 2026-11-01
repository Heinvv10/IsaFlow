/**
 * Master plan U, security review: the route hands an undo's expectation to the service, answers a changed line 409
 * with the sentence the toast shows, and leaves the ordinary Undo and Reverse buttons exactly as they were.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  matchTransaction: vi.fn(), unmatchTransaction: vi.fn(async () => ({})), excludeTransaction: vi.fn(), autoMatchTransactions: vi.fn(),
  allocateTransaction: vi.fn(), splitAllocateTransaction: vi.fn(), deleteTransactions: vi.fn(), bulkAcceptTransactions: vi.fn(),
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
import { excludeTransaction, reverseReconciledTransaction, unmatchTransaction } from '@/modules/accounting/services/bank/bankReconciliationService';
import { BankLineChangedError, lineChangedMessage } from '@/modules/accounting/services/bank/bankTxStatusErrors';

const CO = '00000000-0000-4000-8000-000000000001';
const TX = '00000000-0000-4000-8000-000000000003';
const JE = '00000000-0000-4000-8000-000000000007';
const USER = 'user-1';
const call = (body: Record<string, unknown>) =>
  handler({ method: 'POST', companyId: CO, user: { id: USER }, body } as never, {} as NextApiResponse) as unknown as Promise<{ kind: string; message?: string }>;

beforeEach(() => vi.clearAllMocks());

describe('bank-transactions-action, an undo that states what it expects', () => {
  it('reverse passes the expected journal to the service', async () => {
    await call({ action: 'reverse', bankTransactionId: TX, expectedJournalEntryId: JE });
    expect(reverseReconciledTransaction).toHaveBeenCalledWith(CO, TX, USER, { expectedJournalEntryId: JE });
  });

  it('unmatch passes the expected status to the service', async () => {
    await call({ action: 'unmatch', bankTransactionId: TX, expectedStatus: 'excluded' });
    expect(unmatchTransaction).toHaveBeenCalledWith(CO, TX, USER, { expectedStatus: 'excluded' });
  });

  it('the plain buttons are unchanged', async () => {
    await call({ action: 'reverse', bankTransactionId: TX });
    await call({ action: 'unmatch', bankTransactionId: TX });
    expect(reverseReconciledTransaction).toHaveBeenCalledWith(CO, TX, USER);
    expect(unmatchTransaction).toHaveBeenCalledWith(CO, TX, USER);
  });

  it.each([
    ['reverse', { action: 'reverse', bankTransactionId: TX, expectedJournalEntryId: JE }, reverseReconciledTransaction, 'allocated'],
    ['unmatch', { action: 'unmatch', bankTransactionId: TX, expectedStatus: 'excluded' }, unmatchTransaction, 'excluded'],
  ] as const)('%s: a changed line answers 409 with the toast\'s sentence', async (_n, body, service, action) => {
    vi.mocked(service).mockRejectedValueOnce(new BankLineChangedError(action));
    expect(await call(body)).toEqual({ kind: 'conflict', message: lineChangedMessage(action) });
  });

  it('the two sentences say what the toast offered to take back', () => {
    expect(new BankLineChangedError('allocated').message).toBe('This line has changed since you allocated it.');
    expect(new BankLineChangedError('excluded').message).toBe('This line has changed since you excluded it.');
  });

  it('reverse reports the dates and the VAT roll of the contra, which the toast warns on', async () => {
    const roll = { rolledFrom: '2026-06-01', date: '2026-11-01', lockedPeriodStart: '2026-05-01', lockedPeriodEnd: '2026-06-30', reason: 'locked' };
    vi.mocked(reverseReconciledTransaction).mockResolvedValueOnce({
      invoicesReopened: 0, amountUnapplied: 0, paymentsCancelled: 0,
      vatLockRoll: roll, originalEntryDate: '2026-06-01', reversalEntryDate: '2026-11-01',
    });
    const res = await call({ action: 'reverse', bankTransactionId: TX, expectedJournalEntryId: JE });
    expect(res).toEqual({ kind: 'success', data: { reversed: true, vatLockRoll: roll, originalEntryDate: '2026-06-01', reversalEntryDate: '2026-11-01' } });
  });

  it('exclude passes on the status it read under the lock', async () => {
    vi.mocked(excludeTransaction).mockResolvedValueOnce({ priorStatus: 'matched' } as never);
    expect(await call({ action: 'exclude', bankTransactionId: TX })).toEqual({ kind: 'success', data: { priorStatus: 'matched' } });
  });

  it('refuses any other expected status: this is not a general compare-and-set', async () => {
    expect((await call({ action: 'unmatch', bankTransactionId: TX, expectedStatus: 'matched' })).kind).toBe('validationError');
    expect(unmatchTransaction).not.toHaveBeenCalled();
  });

  it('refuses an expected journal that is not a uuid', async () => {
    expect((await call({ action: 'reverse', bankTransactionId: TX, expectedJournalEntryId: 'x' })).kind).toBe('validationError');
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });
});
