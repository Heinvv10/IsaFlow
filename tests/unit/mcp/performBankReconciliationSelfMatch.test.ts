/**
 * `perform_bank_reconciliation` on books allocated through the bank feed.
 *
 * Production (Velocity Fibre, SBSA to 2025-07-14): every one of 575 lines
 * allocated, ledger = statement to the cent, and the tool reported claimed 0,
 * matched 0, completed false — "the session matched no transactions". An
 * allocated line is matched to its own journal line, so those self-matches must
 * satisfy the at-least-one-match guard, and a balanced session must complete.
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
  // All 575 lines allocated: start self-matches every one; auto-match finds no imported line.
  vi.mocked(startReconciliation).mockResolvedValue({
    ...session, matchedCount: 575, unmatchedCount: 0, selfMatched: 575, claimedUnallocated: 0,
  });
  vi.mocked(autoMatchTransactions).mockResolvedValue({ matched: 0, unmatched: 0, candidates: [] });
  vi.mocked(getReconciliationById).mockResolvedValue({ ...session, matchedCount: 575, unmatchedCount: 0 });
  vi.mocked(completeReconciliation).mockResolvedValue({ ...session, status: 'completed' as const });
});

describe('perform_bank_reconciliation — allocated lines are their own match', () => {
  it('completes a balanced, fully-allocated account although auto-match matched nothing', async () => {
    const b = body(await performBankReconciliationTool.handler({ ...base, complete: true }, ctx));
    expect(completeReconciliation).toHaveBeenCalledWith(ctx.companyId, 'rec-sbsa', ctx.userId);
    expect(b).toMatchObject({
      completed: true, status: 'completed', self_matched: 575, auto_matched: 0,
      matched_count: 575, still_unmatched: 0,
    });
    expect(b.note).toBeUndefined();
  });

  it('still refuses to complete when the difference is not zero, self-matches or not', async () => {
    vi.mocked(getReconciliationById).mockResolvedValue({ ...session, difference: 5, matchedCount: 575 });
    const b = body(await performBankReconciliationTool.handler({ ...base, complete: true }, ctx));
    expect(completeReconciliation).not.toHaveBeenCalled();
    expect(b.completed).toBe(false);
  });

  it('reports the session\'s own unmatched count, not every imported line on the account', async () => {
    vi.mocked(autoMatchTransactions).mockResolvedValue({ matched: 3, unmatched: 180, candidates: [] });
    vi.mocked(getReconciliationById).mockResolvedValue({ ...session, matchedCount: 578, unmatchedCount: 4 });
    const b = body(await performBankReconciliationTool.handler(base, ctx));
    expect(b.still_unmatched).toBe(4);
    expect(b.matched_count).toBe(578);
  });

  it('dry run reports what would be claimed and self-matched, and writes nothing', async () => {
    vi.mocked(getCashBalance).mockResolvedValue({
      asAt: '2025-07-14', total: 3626.98, deactivatedWithBalance: [], postedThrough: null,
      accounts: [{ accountId: ACC, accountCode: '1110', accountName: 'SBSA', isActive: true, glBalance: 3626.98 }],
    });
    vi.mocked(previewReconciliationClaim).mockResolvedValue({ selfMatched: 575, claimedUnallocated: 0 });
    const res = await performBankReconciliationTool.handler({ ...base, dry_run: true }, ctx);
    expect((res as { wroteNothing?: boolean }).wroteNothing).toBe(true);
    expect(previewReconciliationClaim).toHaveBeenCalledWith(ctx.companyId, ACC, '2025-07-14');
    expect(startReconciliation).not.toHaveBeenCalled();
    expect(body(res)).toMatchObject({ would_self_match: 575, would_claim_unallocated: 0, difference: 0 });
  });
});
