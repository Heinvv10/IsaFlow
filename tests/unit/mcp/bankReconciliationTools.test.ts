// Tool argument contracts are independently covered for every registered schema.
vi.mock('@/lib/mcp/inputValidation', () => ({ validateToolArguments: (_tool: unknown, args: unknown) => ({ ok: true, args }) }));
// Current authority is independently covered by forensic/currentToolAuthority and real PostgreSQL permission tests.
vi.mock('@/lib/mcp/currentToolAuthority', () => ({ assertCurrentToolAuthority: vi.fn(async () => undefined) }));
/**
 * MCP tools `list_bank_reconciliations` and `cancel_bank_reconciliation`.
 *
 * Load-bearing on the write side: a refusal comes back as a tool error (nothing
 * was written), while any OTHER failure must RETHROW — the registry's savepoint
 * unwinds on a throw only, so returning isError there would commit a partial
 * cancel. A dry run must not burn the idempotency key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  getReconciliations: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankReconciliationCancelService', async () => {
  class ReconciliationNotCancellableError extends Error {}
  return { cancelReconciliation: vi.fn(), ReconciliationNotCancellableError };
});

import { getReconciliations } from '@/modules/accounting/services/bank/bankReconciliationService';
import {
  cancelReconciliation,
  ReconciliationNotCancellableError,
} from '@/modules/accounting/services/bank/bankReconciliationCancelService';
import {
  listBankReconciliationsTool,
  cancelBankReconciliationTool,
} from '@/lib/mcp/tools/bankReconciliations';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { savepointNameFor } from '@/lib/mcp/registry';
import type { McpToolContext } from '@/lib/mcp/types';

const ctx: McpToolContext = {
  userId: 'u', companyId: '22222222-2222-2222-2222-222222222222',
  scopes: ['read:bank-tx', 'write:bank-tx'], tokenJti: 'j', oauthAppId: null,
};
const RECON_ID = '44444444-4444-4444-4444-444444444444';
const KEY = { idempotency_key: 'k-1' };

const recon = {
  id: RECON_ID, bankAccountId: 'acc', statementDate: '2026-08-31', statementBalance: 100,
  glBalance: 90, reconciledBalance: 90, difference: 10, status: 'in_progress' as const,
  startedBy: 'u', startedAt: 'now', createdAt: 'now', updatedAt: 'now',
  bankAccountName: 'FNB Cheque', matchedCount: 4, unmatchedCount: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getReconciliations).mockResolvedValue([recon]);
  vi.mocked(cancelReconciliation).mockResolvedValue({ revertedMatches: 4, releasedTransactions: 6 });
});

describe('list_bank_reconciliations', () => {
  it('is registered as a free read tool on read:bank-tx', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toContain('list_bank_reconciliations');
    expect(CLIENT_MCP_TOOL_NAMES).toContain('list_bank_reconciliations');
    expect(listBankReconciliationsTool.write).toBe(false);
    expect(listBankReconciliationsTool.scope).toBe('read:bank-tx');
  });

  it('passes ctx.companyId and the account filter, and maps the row', async () => {
    const res = await listBankReconciliationsTool.handler(
      { bank_account_id: '33333333-3333-3333-3333-333333333333' }, ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(getReconciliations).toHaveBeenCalledWith(
      ctx.companyId, '33333333-3333-3333-3333-333333333333',
    );
    const body = JSON.parse(res.content[0]!.text) as {
      reconciliations: Array<Record<string, unknown>>; total: number;
    };
    expect(body.total).toBe(1);
    expect(body.reconciliations[0]).toMatchObject({
      id: RECON_ID, status: 'in_progress', difference: 10,
      bank_account_name: 'FNB Cheque', matched_count: 4, unmatched_count: 2,
    });
  });

  it('filters by status without asking the service again', async () => {
    const res = await listBankReconciliationsTool.handler({ status: 'completed' }, ctx);
    const body = JSON.parse(res.content[0]!.text) as { total: number };
    expect(body.total).toBe(0);
  });

  it('refuses an uncastable bank_account_id before calling the service', async () => {
    const res = await listBankReconciliationsTool.handler({ bank_account_id: 'not-a-uuid' }, ctx);
    expect(res.isError).toBe(true);
    expect(getReconciliations).not.toHaveBeenCalled();
  });
});

describe('cancel_bank_reconciliation', () => {
  it('is a write tool needing an idempotency key, with a legal savepoint name', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toContain('cancel_bank_reconciliation');
    expect(CLIENT_MCP_TOOL_NAMES).toContain('cancel_bank_reconciliation');
    expect(cancelBankReconciliationTool.write).toBe(true);
    expect(cancelBankReconciliationTool.scope).toBe('write:bank-tx');
    expect(cancelBankReconciliationTool.requiresPost).toBeUndefined();
    const schema = cancelBankReconciliationTool.inputSchema as { required: string[] };
    expect(schema.required).toContain('idempotency_key');
    // Truncation at 31 chars must not collide with the prefix of another tool.
    expect(savepointNameFor('cancel_bank_reconciliation')).toBe('mcp_cancel_bank_reconciliation');
  });

  it('cancels and reports what was released', async () => {
    const res = await cancelBankReconciliationTool.handler(
      { reconciliation_id: RECON_ID, ...KEY }, ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(cancelReconciliation).toHaveBeenCalledWith(ctx.companyId, RECON_ID, ctx.userId, {
      dryRun: false,
    });
    expect(res.wroteNothing).toBeUndefined();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({
      reconciliation_id: RECON_ID, cancelled: true, dry_run: false,
      reverted_matches: 4, released_transactions: 6,
    });
  });

  it('dry run writes nothing and does not burn the idempotency key', async () => {
    vi.mocked(cancelReconciliation).mockResolvedValue({ revertedMatches: 4, releasedTransactions: 6 });
    const res = await cancelBankReconciliationTool.handler(
      { reconciliation_id: RECON_ID, dry_run: true, ...KEY }, ctx,
    );
    expect(cancelReconciliation).toHaveBeenCalledWith(ctx.companyId, RECON_ID, ctx.userId, {
      dryRun: true,
    });
    expect(res.wroteNothing).toBe(true);
    expect(res.billable).toBe(false);
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ cancelled: false, dry_run: true });
  });

  it('returns a refusal as a tool error', async () => {
    vi.mocked(cancelReconciliation).mockRejectedValue(
      new ReconciliationNotCancellableError('Only an in-progress reconciliation can be cancelled'),
    );
    const res = await cancelBankReconciliationTool.handler(
      { reconciliation_id: RECON_ID, ...KEY }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/in-progress/);
  });

  it('rethrows any other failure so the registry savepoint rolls back', async () => {
    vi.mocked(cancelReconciliation).mockRejectedValue(new Error('deadlock detected'));
    await expect(cancelBankReconciliationTool.handler(
      { reconciliation_id: RECON_ID, ...KEY }, ctx,
    )).rejects.toThrow('deadlock detected');
  });

  it('refuses a missing or uncastable reconciliation_id before any write', async () => {
    const missing = await cancelBankReconciliationTool.handler({ ...KEY }, ctx);
    expect(missing.isError).toBe(true);
    const bad = await cancelBankReconciliationTool.handler(
      { reconciliation_id: 'not-a-uuid', ...KEY }, ctx,
    );
    expect(bad.isError).toBe(true);
    expect(cancelReconciliation).not.toHaveBeenCalled();
  });
});
