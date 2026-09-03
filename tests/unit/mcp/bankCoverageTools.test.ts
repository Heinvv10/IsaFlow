/**
 * `bank_statement_coverage`, `get_opening_balances` and
 * `perform_bank_reconciliation`.
 *
 * The write tool is where the care goes. Ownership is checked BEFORE any
 * service call because `bank_account_id` becomes a foreign key and nothing
 * downstream re-checks the tenant. A second in-progress session is refused from
 * a READ, so the refusal is pre-write. And once `startReconciliation` has run,
 * every failure must RETHROW — a returned tool error would commit a
 * half-started reconciliation AND free the key for a retry that starts another.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankStatementCoverageService', () => ({
  DEFAULT_MIN_GAP_DAYS: 7,
  getBankStatementCoverage: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/openingBalanceReadService', () => ({
  getOpeningBalances: vi.fn(),
}));
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
}));

import { getBankStatementCoverage } from '@/modules/accounting/services/bank/bankStatementCoverageService';
import { getOpeningBalances } from '@/modules/accounting/services/gl/openingBalanceReadService';
import { bankGlAccountBelongsToCompany } from '@/modules/accounting/services/bank/bankStatementImportService';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import {
  autoMatchTransactions,
  completeReconciliation,
  getReconciliationById,
  getReconciliations,
  startReconciliation,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import { bankStatementCoverageTool, getOpeningBalancesTool } from '@/lib/mcp/tools/bankCoverage';
import { performBankReconciliationTool } from '@/lib/mcp/tools/writeBankReconciliation';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { assertEnvelopeSound } from '@/lib/mcp/contracts';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const ctx: McpToolContext = {
  userId: 'u', companyId: '22222222-2222-2222-2222-222222222222',
  scopes: ['read:bank-tx', 'read:reports', 'write:bank-tx', 'write:post'],
  tokenJti: 'j', oauthAppId: null,
};
const ACC = '33333333-3333-3333-3333-333333333333';
const KEY = { idempotency_key: 'k-1' };

function body(res: McpToolResult): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

const account = {
  bankAccountId: ACC, accountCode: '1110', accountName: 'ABSA', isActive: false,
  firstTransactionDate: '2025-04-01', lastTransactionDate: '2026-02-04',
  transactionCount: 575, netMovement: 3626.98, staleDays: 211,
  months: [{ month: '2025-04', transactionCount: 10, net: 1, debits: 0, credits: 1 }],
  gaps: [{ afterDate: '2025-12-20', beforeDate: '2026-04-14', missingDays: 114 }],
  duplicateReferences: [{ reference: 'X', count: 3, totalAmount: -300, transactionIds: ['a'] }],
  openingBalance: { amount: null, asAt: null },
  glBalance: 3353164.26, statementBalance: 3626.98, computedBalance: 3626.98,
  glVsComputedDifference: 3349537.28,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(bankGlAccountBelongsToCompany).mockResolvedValue(true);
  vi.mocked(getBankStatementCoverage).mockResolvedValue({
    asAt: '2026-09-03', accounts: [account],
    totals: {
      glBalance: 3353164.26, statementBalance: 3626.98, computedBalance: 3626.98,
      difference: 3349537.28, transactionCount: 575,
    },
    postedThrough: '2026-09-03T03:10:16.064Z',
  });
  vi.mocked(getOpeningBalances).mockResolvedValue({
    rows: [], disagreements: [], accountsWithoutOpeningBalance: ['1110'],
    totals: { posted: 0, metadata: 0 }, postedThrough: null,
  });
});

describe('registration', () => {
  it('registers all three with the right scopes', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    for (const n of ['bank_statement_coverage', 'get_opening_balances', 'perform_bank_reconciliation']) {
      expect(names, n).toContain(n);
      expect(CLIENT_MCP_TOOL_NAMES, n).toContain(n);
    }
    expect(bankStatementCoverageTool.write).toBe(false);
    expect(performBankReconciliationTool.requiresPost).toBe(true);
  });
});

describe('bank_statement_coverage', () => {
  it('returns a sound envelope naming cash.ledger.v1 as its basis', async () => {
    const env = body(await bankStatementCoverageTool.handler({}, ctx));
    assertEnvelopeSound(env as never);
    expect(env.figureBasis).toBe('cash.ledger.v1');
    expect(env.posted_through).toBe('2026-09-03T03:10:16.064Z');
  });

  it('keeps the three balances SEPARATE — the gap is the finding', async () => {
    const env = body(await bankStatementCoverageTool.handler({}, ctx));
    const row = (env.rows as Array<Record<string, unknown>>)[0]!;
    expect(row.gl_balance).toBeCloseTo(3353164.26, 2);
    expect(row.statement_balance).toBeCloseTo(3626.98, 2);
    expect(row.computed_balance).toBeCloseTo(3626.98, 2);
    expect(row.gl_vs_computed_difference).toBeCloseTo(3349537.28, 2);
  });

  it('reports a DEACTIVATED account rather than dropping it', async () => {
    const env = body(await bankStatementCoverageTool.handler({}, ctx));
    expect((env.rows as Array<Record<string, unknown>>)[0]!.is_active).toBe(false);
  });

  it('omits the month table at standard detail and includes it at full', async () => {
    const std = body(await bankStatementCoverageTool.handler({}, ctx));
    expect((std.rows as Array<Record<string, unknown>>)[0]!.months).toBeUndefined();
    expect((std.rows as Array<Record<string, unknown>>)[0]!.gap_count).toBe(1);

    const full = body(await bankStatementCoverageTool.handler({ detail: 'full' }, ctx));
    const row = (full.rows as Array<Record<string, unknown>>)[0]!;
    expect(row.months).toHaveLength(1);
    expect(row.gaps).toHaveLength(1);
    expect(row.duplicate_references).toHaveLength(1);
  });

  it('checks ownership BEFORE the service call and answers the shared miss', async () => {
    vi.mocked(bankGlAccountBelongsToCompany).mockResolvedValue(false);
    const res = await bankStatementCoverageTool.handler({ bank_account_id: ACC }, ctx);
    expect(res.content[0]!.text).toBe('Not found');
    expect(getBankStatementCoverage).not.toHaveBeenCalled();
  });

  it('refuses a malformed date before any query — a cast would abort the transaction', async () => {
    const res = await bankStatementCoverageTool.handler({ as_at: '2026-02-31' }, ctx);
    expect(res.isError).toBe(true);
    expect(getBankStatementCoverage).not.toHaveBeenCalled();
  });

  it('refuses a nonsensical min_gap_days', async () => {
    const res = await bankStatementCoverageTool.handler({ min_gap_days: 0 }, ctx);
    expect(res.isError).toBe(true);
  });
});

describe('get_opening_balances', () => {
  it('lists the accounts that have none, and the disagreements separately', async () => {
    vi.mocked(getOpeningBalances).mockResolvedValue({
      rows: [{
        accountId: ACC, accountCode: '1120', accountName: 'Paycard', accountSubtype: 'bank',
        isActive: true, postedAmount: null, postedAsAt: null,
        metadataAmount: 1200, metadataAsAt: '2025-04-01', agrees: false,
        journalEntryIds: [], entryNumbers: [],
      }],
      disagreements: [{
        accountId: ACC, accountCode: '1120', accountName: 'Paycard', accountSubtype: 'bank',
        isActive: true, postedAmount: null, postedAsAt: null,
        metadataAmount: 1200, metadataAsAt: '2025-04-01', agrees: false,
        journalEntryIds: [], entryNumbers: [],
      }],
      accountsWithoutOpeningBalance: ['1110'],
      totals: { posted: 0, metadata: 1200 }, postedThrough: null,
    });

    const env = body(await getOpeningBalancesTool.handler({}, ctx));
    assertEnvelopeSound(env as never);
    expect(env.disagreement_count).toBe(1);
    expect(env.accounts_without_opening_balance).toEqual(['1110']);
    expect(env.disagreements).toEqual([
      { account_code: '1120', posted_amount: null, metadata_amount: 1200 },
    ]);
  });

  it('checks ownership before the service call', async () => {
    vi.mocked(bankGlAccountBelongsToCompany).mockResolvedValue(false);
    const res = await getOpeningBalancesTool.handler({ bank_account_id: ACC }, ctx);
    expect(res.content[0]!.text).toBe('Not found');
    expect(getOpeningBalances).not.toHaveBeenCalled();
  });
});

describe('perform_bank_reconciliation', () => {
  const started = {
    id: 'rec-1', bankAccountId: ACC, statementDate: '2026-08-31', statementBalance: 1000,
    glBalance: 900, reconciledBalance: 900, difference: 100, status: 'in_progress' as const,
    startedBy: 'u', startedAt: 'now', createdAt: 'now', updatedAt: 'now',
  };

  beforeEach(() => {
    vi.mocked(getReconciliations).mockResolvedValue([]);
    vi.mocked(startReconciliation).mockResolvedValue(started);
    vi.mocked(autoMatchTransactions).mockResolvedValue({
      matched: 12, unmatched: 3, candidates: [], skippedRaced: 0,
    });
    vi.mocked(getReconciliationById).mockResolvedValue({ ...started, difference: 0, reconciledBalance: 1000 });
    vi.mocked(completeReconciliation).mockResolvedValue({
      ...started, difference: 0, reconciledBalance: 1000, status: 'completed' as const,
    });
    vi.mocked(getCashBalance).mockResolvedValue({
      asAt: '2026-08-31', total: 900,
      accounts: [{ accountId: ACC, accountCode: '1110', accountName: 'ABSA', isActive: true, glBalance: 900 }],
      deactivatedWithBalance: [], postedThrough: null,
    });
  });

  const base = { bank_account_id: ACC, statement_date: '2026-08-31', statement_balance: 1000, ...KEY };

  it('checks ownership BEFORE anything writes', async () => {
    vi.mocked(bankGlAccountBelongsToCompany).mockResolvedValue(false);
    const res = await performBankReconciliationTool.handler(base, ctx);
    expect(res.content[0]!.text).toBe('Not found');
    expect(startReconciliation).not.toHaveBeenCalled();
  });

  it('refuses a second in-progress session, from a READ, before writing', async () => {
    vi.mocked(getReconciliations).mockResolvedValue([started]);
    const res = await performBankReconciliationTool.handler(base, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/already in progress/);
    expect(startReconciliation).not.toHaveBeenCalled();
  });

  it('a dry run runs every guard, writes nothing, and frees the key', async () => {
    const res = await performBankReconciliationTool.handler({ ...base, dry_run: true }, ctx);
    expect((res as { wroteNothing?: boolean }).wroteNothing).toBe(true);
    expect(startReconciliation).not.toHaveBeenCalled();
    expect(autoMatchTransactions).not.toHaveBeenCalled();
    const b = body(res);
    expect(b.gl_balance).toBe(900);
    expect(b.difference).toBe(100);
  });

  it('a dry run refuses an existing session exactly where the live call would', async () => {
    vi.mocked(getReconciliations).mockResolvedValue([started]);
    const res = await performBankReconciliationTool.handler({ ...base, dry_run: true }, ctx);
    expect(res.isError).toBe(true);
  });

  it('starts, auto-matches, and reports the difference after matching', async () => {
    const b = body(await performBankReconciliationTool.handler(base, ctx));
    expect(startReconciliation)
      .toHaveBeenCalledWith(ctx.companyId, ACC, '2026-08-31', 1000, ctx.userId);
    expect(autoMatchTransactions).toHaveBeenCalledWith(ctx.companyId, ACC, 'rec-1');
    expect(b.auto_matched).toBe(12);
    expect(b.difference).toBe(0);
    expect(b.completed).toBe(false);
  });

  it('completes only when asked AND the session balances exactly', async () => {
    const b = body(await performBankReconciliationTool.handler({ ...base, complete: true }, ctx));
    expect(completeReconciliation).toHaveBeenCalledWith(ctx.companyId, 'rec-1', ctx.userId);
    expect(b.completed).toBe(true);
    expect(b.status).toBe('completed');
  });

  it('does NOT complete an unbalanced session, and does NOT throw away the work', async () => {
    vi.mocked(getReconciliationById).mockResolvedValue({ ...started, difference: 250 });
    const res = await performBankReconciliationTool.handler({ ...base, complete: true }, ctx);

    expect(res.isError).toBeFalsy();
    expect(completeReconciliation).not.toHaveBeenCalled();
    const b = body(res);
    expect(b.completed).toBe(false);
    expect(b.difference).toBe(250);
    expect(String(b.note)).toMatch(/still in progress/);
    // It WROTE, so the key must be consumed: a retry must not open a second session.
    expect((res as { wroteNothing?: boolean }).wroteNothing).toBeUndefined();
  });

  it('will NOT complete a reconciliation that matched nothing', async () => {
    // Production holds a COMPLETED reconciliation with a R0.00 difference and
    // zero matched transactions. It balances because reconciled_balance starts
    // AT gl_balance, so an empty session is trivially "balanced" — and a
    // reconciliation that matched nothing proves nothing while looking, in
    // every list and report, exactly like one that proved everything.
    vi.mocked(getReconciliationById).mockResolvedValue({
      ...started, difference: 0, matchedCount: 0, unmatchedCount: 0,
    });
    vi.mocked(autoMatchTransactions).mockResolvedValue({
      matched: 0, unmatched: 0, candidates: [], skippedRaced: 0,
    });

    const res = await performBankReconciliationTool.handler({ ...base, complete: true }, ctx);

    expect(res.isError).toBeFalsy();
    expect(completeReconciliation).not.toHaveBeenCalled();
    const b = body(res);
    expect(b.completed).toBe(false);
    expect(b.matched_count).toBe(0);
    expect(String(b.note)).toMatch(/matched no transactions/i);
  });

  it('completes when it balances AND actually matched something', async () => {
    vi.mocked(getReconciliationById).mockResolvedValue({
      ...started, difference: 0, reconciledBalance: 1000, matchedCount: 12,
    });
    const b = body(await performBankReconciliationTool.handler({ ...base, complete: true }, ctx));
    expect(completeReconciliation).toHaveBeenCalled();
    expect(b.completed).toBe(true);
  });

  it('skips auto-matching when asked to', async () => {
    await performBankReconciliationTool.handler({ ...base, auto_match: false }, ctx);
    expect(autoMatchTransactions).not.toHaveBeenCalled();
    expect(startReconciliation).toHaveBeenCalled();
  });

  it('RETHROWS a failure after the first write instead of returning a tool error', async () => {
    vi.mocked(autoMatchTransactions).mockRejectedValue(new Error('FK violation'));
    await expect(performBankReconciliationTool.handler(base, ctx)).rejects.toThrow('FK violation');
  });

  it('refuses a non-numeric statement_balance before any query', async () => {
    const res = await performBankReconciliationTool.handler(
      { ...base, statement_balance: 'one thousand' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(bankGlAccountBelongsToCompany).not.toHaveBeenCalled();
  });

  it('refuses an impossible statement_date before any query', async () => {
    const res = await performBankReconciliationTool.handler(
      { ...base, statement_date: '2026-02-31' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(bankGlAccountBelongsToCompany).not.toHaveBeenCalled();
  });
});
