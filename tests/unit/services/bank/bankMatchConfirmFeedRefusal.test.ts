/**
 * A-3 / F-M1 — bank-match-confirm answers a pending/removed feed row 409 in
 * both shapes it can arrive in: the bare BankTransactionNotPostedError
 * (matchTransaction, journal_line / bank_transfer) and allocateTransaction's
 * BankAllocationRefusal carrying the feed state (purchase_order). Every other
 * BankAllocationRefusal keeps its 400. Both are raised before the first write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Step 2's bank gates read Postgres; stubbed open here, proven in tests/integration/bank-controls-*.int.test.ts.
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', async () => (await import('../../helpers/bankControlGateMocks')).importerGateOpen());
vi.mock('@/modules/accounting/services/bank/bankReversalGate', async () => (await import('../../helpers/bankControlGateMocks')).reversalGateOpen());
vi.mock('@/modules/accounting/services/bank/bankControlResponse', () => ({ respondIfBankControlRefused: () => false }));
import type { NextApiResponse } from 'next';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  allocateTransaction: vi.fn(), matchTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/confirmSupplierMatch', () => ({ confirmSupplierInvoiceMatch: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/confirmCustomerMatch', () => ({ confirmCustomerInvoiceMatch: vi.fn() }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_r: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_r: unknown, message: string) => ({ kind: 'badRequest', message })),
    conflict: vi.fn((_r: unknown, message: string) => ({ kind: 'conflict', message })),
    notFound: vi.fn(() => ({ kind: 'notFound' })),
    internalError: vi.fn((_r: unknown, _e: unknown, message: string) => ({ kind: 'internalError', message })),
    validationError: vi.fn(() => ({ kind: 'validationError' })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));

import handler from '../../../../pages/api/accounting/bank-match-confirm';
import { allocateTransaction, matchTransaction } from '@/modules/accounting/services/bank/bankReconciliationService';
import { BankTransactionNotPostedError, assertPostedForAllocation } from '@/modules/accounting/services/bank/bankFeedStateGuard';
import { BankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';

const TX = '00000000-0000-4000-8000-000000000003';
const CANDIDATE = '00000000-0000-4000-8000-000000000004';
const req = (candidateType: string) => ({
  method: 'POST', companyId: 'co', user: { id: 'u1' }, body: { bankTransactionId: TX, candidateType, candidateId: CANDIDATE },
}) as never;
const pendingAllocationRefusal = (): unknown => {
  try { assertPostedForAllocation({ feed_state: 'pending' }, TX, 'allocate'); } catch (e) { return e; }
  throw new Error('assertPostedForAllocation did not refuse a pending row');
};

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockReset();
  sqlMock.mockResolvedValueOnce([{ amount: -100 }]).mockResolvedValue([{ id: CANDIDATE, supplier_id: 's1', total: 100 }]);
});

describe('bank-match-confirm — pending feed row', () => {
  it('journal_line: a bare BankTransactionNotPostedError is 409, not 500', async () => {
    vi.mocked(matchTransaction).mockRejectedValue(new BankTransactionNotPostedError(TX, 'pending', 'match'));
    const out = await handler(req('journal_line'), {} as NextApiResponse) as { kind: string; message: string };
    expect(out).toEqual({ kind: 'conflict', message: expect.stringMatching(/still pending at the bank/) });
  });

  it("purchase_order: allocateTransaction's feed-state refusal is 409", async () => {
    vi.mocked(allocateTransaction).mockRejectedValue(pendingAllocationRefusal());
    const out = await handler(req('purchase_order'), {} as NextApiResponse) as { kind: string; message: string };
    expect(out).toEqual({ kind: 'conflict', message: expect.stringMatching(/still pending at the bank/) });
  });

  it('any other BankAllocationRefusal keeps 400', async () => {
    vi.mocked(allocateTransaction).mockRejectedValue(new BankAllocationRefusal('Transaction already allocated'));
    const out = await handler(req('purchase_order'), {} as NextApiResponse) as { kind: string };
    expect(out.kind).toBe('badRequest');
  });
});
