/**
 * #1656 round 6 (F-M2): the bulk statement commit's import posts journals through its outflow auto-post sweep and its optional rule pass. Both run
 * only for a person with Banking Approve; the import itself lands either way. This is the test the census-exempt marker on importParsedTransactions
 * names: forcing skipAutoPost to false (or the rule pass on) without Approve turns it red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/billing/getCompanyPlan', () => ({ getCompanyPlan: vi.fn(async () => ({ planCode: 'pro' })) }));
vi.mock('@/modules/billing/services/flowWalletService', () => ({
  deductFlows: vi.fn(), refundFlows: vi.fn(), triggerAutoTopup: vi.fn(), recalculateNudge: vi.fn(), InsufficientFlowsError: class extends Error {},
}));
vi.mock('@/modules/billing/services/flowOperationCatalog', () => ({ getFlowCost: vi.fn(() => 1) }));
vi.mock('@/modules/accounting/services/bank/bankAccountGuard', () => ({
  assertBankAccountInCompany: vi.fn(async () => ({ bankAccountNumber: '123' })), isBankAccountGuardRefusal: () => false,
}));
vi.mock('@/modules/accounting/services/bank/bankStatementParseService', () => ({
  parseStatement: vi.fn(async () => ({ transactions: [{ date: '2026-05-01', description: 'x', amount: -10, reference: '' }], errors: [], accountNumber: null })),
}));
vi.mock('@/modules/accounting/services/bank/bankStatementDedupe', () => ({ existingStatementHashes: vi.fn(async () => new Set()), statementLineHash: vi.fn(() => 'h') }));
vi.mock('@/modules/accounting/services/bank/bankIngestLock', () => ({ lockBankAccountIngest: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/bank/bankStatementDateRange', () => ({ dateRangeOf: vi.fn(() => ({ from: '2026-05-01', to: '2026-05-01' })) }));
vi.mock('@/modules/accounting/services/bank/bankImportService', () => ({
  importParsedTransactions: vi.fn(async () => ({ batchId: 'b1', transactionCount: 1, errors: [] })), uploadProvenance: vi.fn(() => ({})),
}));
vi.mock('@/modules/accounting/services/bank/bankBulkCommitRules', () => ({ applyRulesAfterBulkFile: vi.fn(async () => ({ applied: 1, skippedLocked: 0 })) }));
vi.mock('@/modules/accounting/services/core/approvePermission', async (orig) => ({ ...(await orig<object>()), mayApprove: vi.fn(async () => false) }));

import { mayApprove } from '@/modules/accounting/services/core/approvePermission';
import { importParsedTransactions } from '@/modules/accounting/services/bank/bankImportService';
import { applyRulesAfterBulkFile } from '@/modules/accounting/services/bank/bankBulkCommitRules';
import handler from '../../../pages/api/accounting/bank-transactions-bulk-commit';

const C = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
function commit(extra: Record<string, unknown> = {}) {
  const req = { method: 'POST', query: {}, headers: {}, companyId: C, user: { id: 'u-1' },
    body: { bankAccountId: A, bulkImportId: B, bulkSequence: 1, filename: 's.csv', fileType: 'csv', statementDate: '2026-05-31', csvContent: 'a,b', ...extra } } as unknown as NextApiRequest;
  const res = { statusCode: 0, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; } };
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}
const options = () => vi.mocked(importParsedTransactions).mock.calls[0]![4] as { skipAutoPost?: boolean };

beforeEach(() => { vi.clearAllMocks(); vi.mocked(mayApprove).mockResolvedValue(false); });

describe('bank-transactions-bulk-commit', () => {
  it('without Banking Approve the import lands with its auto-post sweep skipped, and the rule pass does not run even when asked', async () => {
    const res = await commit({ applyBankRules: true });
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(200);
    expect(importParsedTransactions).toHaveBeenCalledOnce();
    expect(options().skipAutoPost).toBe(true);
    expect(applyRulesAfterBulkFile).not.toHaveBeenCalled();
    expect(mayApprove).toHaveBeenCalledWith(C, 'u-1', 'banking');
  });

  it('with Banking Approve the sweep runs, and the rule pass runs when asked', async () => {
    vi.mocked(mayApprove).mockResolvedValue(true);
    await commit({ applyBankRules: true });
    expect(options().skipAutoPost).toBe(false);
    expect(applyRulesAfterBulkFile).toHaveBeenCalledOnce();
  });

  it('with Banking Approve and no request for rules the rule pass does not run', async () => {
    vi.mocked(mayApprove).mockResolvedValue(true);
    await commit();
    expect(applyRulesAfterBulkFile).not.toHaveBeenCalled();
  });
});
