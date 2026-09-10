import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({
  assertJournalAnalysisDimensions: vi.fn(),
  sql: vi.fn(async () => []),
}));

vi.mock('@/lib/neon', () => ({ sql: mocks.sql }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  withAuth: (handler: unknown) => handler,
  withWriteAccess: (handler: unknown) => handler,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (handler: unknown) => handler }));
vi.mock('@/modules/accounting/services/gl/journalCostCentreValidation', () => ({
  assertJournalAnalysisDimensions: mocks.assertJournalAnalysisDimensions,
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  assertCustomerInCompany: vi.fn(),
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

import handler from '../../../pages/api/accounting/bank-transactions-action';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const TX = '22222222-2222-4222-8222-222222222222';
const CC1 = '33333333-3333-4333-8333-333333333333';
const CC2 = '44444444-4444-4444-8444-444444444444';
const BU = '55555555-5555-4555-8555-555555555555';

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as NextApiResponse;
}

function request() {
  return {
    method: 'POST', companyId: COMPANY, user: { id: 'user' }, query: {},
    body: { action: 'save_dimensions', bankTransactionId: TX, cc1Id: CC1, cc2Id: CC2, buId: BU },
  } as unknown as NextApiRequest;
}

describe('bank saved-dimension assignment policy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validates all three assignments before updating the bank row', async () => {
    mocks.assertJournalAnalysisDimensions.mockResolvedValueOnce(undefined);
    const res = response();
    await handler(request(), res);
    expect(mocks.assertJournalAnalysisDimensions).toHaveBeenCalledWith(COMPANY, [{
      cc1Id: CC1, cc2Id: CC2, buId: BU,
    }]);
    expect(mocks.assertJournalAnalysisDimensions.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.sql.mock.invocationCallOrder[0]!);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns the policy refusal without writing', async () => {
    mocks.assertJournalAnalysisDimensions.mockRejectedValueOnce(
      new Error('CC1 must name an active CC1 cost centre in this company'),
    );
    const res = response();
    await handler(request(), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
