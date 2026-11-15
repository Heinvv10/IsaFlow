/**
 * `perform_bank_reconciliation` completes only at a difference of exactly R0.00 (WP2 row 3): R0.01 either way is
 * not balanced, the service is never asked to complete, and the session stays in progress.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankStatementImportService', () => ({
  bankGlAccountBelongsToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/cashBalanceService', () => ({
  getCashBalance: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  getReconciliations: vi.fn(),
  getReconciliationById: vi.fn(),
  startReconciliation: vi.fn(),
  autoMatchTransactions: vi.fn(),
  completeReconciliation: vi.fn(),
  previewReconciliationClaim: vi.fn(),
}));

import { bankGlAccountBelongsToCompany } from '@/modules/accounting/services/bank/bankStatementImportService';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import {
  autoMatchTransactions, completeReconciliation, getReconciliationById, getReconciliations,
  previewReconciliationClaim, startReconciliation,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import { ReconciliationNotBalancedError } from '@/modules/accounting/services/bank/reconciliationBalanced';
import { performBankReconciliationTool } from '@/lib/mcp/tools/writeBankReconciliation';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const ctx: McpToolContext = {
  userId: 'u', companyId: '22222222-2222-2222-2222-222222222222',
  scopes: ['read:bank-tx', 'write:bank-tx', 'write:post'], tokenJti: 'j', oauthAppId: null,
};
const ACC = '33333333-3333-3333-3333-333333333333';
const base = {
  bank_account_id: ACC, statement_date: '2025-07-14', statement_balance: 3626.98,
  idempotency_key: 'k-1',
};
const session = {
  id: 'rec-sbsa', bankAccountId: ACC, statementDate: '2025-07-14', statementBalance: 3626.98,
  glBalance: 3626.98, reconciledBalance: 3626.98, difference: 0, status: 'in_progress' as const,
  startedBy: 'u', startedAt: 'now', createdAt: 'now', updatedAt: 'now',
};
const body = (r: McpToolResult) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(bankGlAccountBelongsToCompany).mockResolvedValue(true);
  vi.mocked(getReconciliations).mockResolvedValue([]);
  vi.mocked(startReconciliation).mockResolvedValue({
    ...session, matchedCount: 5, unmatchedCount: 0, selfMatched: 5, claimedUnallocated: 0,
  });
  vi.mocked(autoMatchTransactions).mockResolvedValue({ matched: 0, unmatched: 0, candidates: [] });
  vi.mocked(completeReconciliation).mockResolvedValue({ ...session, status: 'completed' as const });
});

describe('perform_bank_reconciliation — exactly R0.00', () => {
  it.each([0.01, -0.01])('difference %s: not balanced, not completed, the service is not asked', async (difference) => {
    vi.mocked(getReconciliationById).mockResolvedValue({ ...session, difference, matchedCount: 5, unmatchedCount: 0 });
    const b = body(await performBankReconciliationTool.handler({ ...base, complete: true }, ctx));
    expect(completeReconciliation).not.toHaveBeenCalled();
    expect(b).toMatchObject({ completed: false, balanced: false, status: 'in_progress' });
    expect(String(b.note)).toContain(`R${difference.toFixed(2)}`);
  });

  it('difference 0: balanced and completed', async () => {
    vi.mocked(getReconciliationById).mockResolvedValue({ ...session, difference: 0, matchedCount: 5, unmatchedCount: 0 });
    const b = body(await performBankReconciliationTool.handler({ ...base, complete: true }, ctx));
    expect(completeReconciliation).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ completed: true, balanced: true });
  });

  it('the ledger moved after the check: completion refuses, the tool answers completed:false with the new difference', async () => {
    vi.mocked(getReconciliationById)
      .mockResolvedValueOnce({ ...session, difference: 0, matchedCount: 5, unmatchedCount: 0 })
      // the header completion's catch refreshed: statement 3626.98, ledger now 50 higher
      .mockResolvedValueOnce({ ...session, glBalance: 3676.98, reconciledBalance: 3676.98, difference: -50, matchedCount: 5, unmatchedCount: 0 });
    vi.mocked(completeReconciliation).mockRejectedValue(new ReconciliationNotBalancedError(-50));
    const b = body(await performBankReconciliationTool.handler({ ...base, complete: true }, ctx));
    expect(b).toMatchObject({ completed: false, balanced: false, difference: -50, reconciled_balance: 3676.98, status: 'in_progress' });
    expect(String(b.note)).toContain('R-50.00');
  });
});
