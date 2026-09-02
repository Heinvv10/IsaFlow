/**
 * MCP read tool `list_import_batches`.
 *
 * Load-bearing: the service receives ctx.companyId and nothing from args
 * that could widen the tenant; an uncastable bank_account_id is refused
 * BEFORE the service call (a read tool has no savepoint — a 22P02 aborts the
 * whole request transaction).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankImportBatchQueryService', () => ({
  listImportBatches: vi.fn(),
}));

import { listImportBatches } from '@/modules/accounting/services/bank/bankImportBatchQueryService';
import { listImportBatchesTool } from '@/lib/mcp/tools/importBatches';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import type { McpToolContext } from '@/lib/mcp/types';

const ctx: McpToolContext = {
  userId: 'u', companyId: '22222222-2222-2222-2222-222222222222',
  scopes: ['read:bank-tx'], tokenJti: 'j', oauthAppId: null,
};

const batch = {
  id: 'b1', bankAccountId: 'acc', statementDate: '2026-08-31', bankFormat: 'fnb',
  openingBalance: 100, closingBalance: 50, transactionCount: 3, transactionsRemaining: 2,
  transactionsAllocated: 1, sourceFilename: 'aug.ofx', importedBy: null, bulkImportId: null,
  createdAt: '2026-09-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listImportBatches).mockResolvedValue([batch]);
});

describe('list_import_batches', () => {
  it('is registered as a free read tool on read:bank-tx', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toContain('list_import_batches');
    expect(CLIENT_MCP_TOOL_NAMES).toContain('list_import_batches');
    expect(listImportBatchesTool.write).toBe(false);
    expect(listImportBatchesTool.scope).toBe('read:bank-tx');
  });

  it('calls the service with ctx.companyId, the account filter and a clamped limit', async () => {
    const res = await listImportBatchesTool.handler(
      { bank_account_id: '33333333-3333-3333-3333-333333333333', limit: 999 }, ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(listImportBatches).toHaveBeenCalledWith(ctx.companyId, {
      bankAccountId: '33333333-3333-3333-3333-333333333333', limit: 100,
    });
    const body = JSON.parse(res.content[0]!.text) as { batches: Array<Record<string, unknown>>; count: number };
    expect(body.count).toBe(1);
    expect(body.batches[0]).toMatchObject({
      id: 'b1', transactions_remaining: 2, transactions_allocated: 1, source_filename: 'aug.ofx',
    });
  });

  it('defaults to 20 rows with no account filter', async () => {
    await listImportBatchesTool.handler({}, ctx);
    expect(listImportBatches).toHaveBeenCalledWith(ctx.companyId, { bankAccountId: undefined, limit: 20 });
  });

  it('refuses an uncastable bank_account_id before touching the service', async () => {
    const res = await listImportBatchesTool.handler({ bank_account_id: 'not-a-uuid' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('invalid bank_account_id');
    expect(listImportBatches).not.toHaveBeenCalled();
  });
});
