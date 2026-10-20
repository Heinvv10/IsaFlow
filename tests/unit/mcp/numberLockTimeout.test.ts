/**
 * DOCNUM (brk-docnum R2-F1): a number lock held past its 5 s bound is a RETRYABLE event for the MCP tools.
 *
 * Since migration 858 every journal and every credit note / receipt / supplier payment is numbered under the
 * company+year number lock, bounded at 5 s inside the numbering trigger. When a peer holds it longer the insert
 * fails with a raw 55P03. The bulk posters must skip that element as "locked by another request — retry" (its
 * savepoint has rolled back) instead of unwinding the whole batch as `database error 55P03` naming the agent's line,
 * and a single tool must answer with retry wording instead of GENERIC_FAILURE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const savepointMock = vi.hoisted(() => vi.fn(async (_name: string, cb: () => unknown) => cb()));
vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    withSavepoint: savepointMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/mcp/tools/allocationLine', () => ({ postAllocationLine: vi.fn() }));
vi.mock('@/lib/mcp/tools/allocationVatGuard', async (orig) => ({
  ...(await orig<object>()), prefetchAllocationVatFacts: vi.fn(async () => new Map()),
}));

import { postAllocationLine } from '@/lib/mcp/tools/allocationLine';
import { postPreparedLines } from '@/lib/mcp/tools/bulkAllocationPost';
import { postPartitionedDocuments } from '@/lib/mcp/tools/bulkApprovePost';
import { McpRegistry } from '@/lib/mcp/registry';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';
import { resetSqlMock } from '../auth/helpers';

const numberLockTimeout = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
const ctx: McpToolContext = {
  userId: 'user-1', companyId: '22222222-2222-2222-2222-222222222222', companyRole: 'owner', scopes: ['write:bank-tx'],
  tokenJti: 'pat-33333333', oauthAppId: null,
};
const RETRY = 'locked by another request — retry';

beforeEach(() => { vi.clearAllMocks(); resetSqlMock(); });

describe('bulk_allocate_bank_transactions (postPreparedLines)', () => {
  it('skips a line whose number lock timed out (raw 55P03) as retryable and posts the rest', async () => {
    vi.mocked(postAllocationLine).mockImplementation((async (_c: unknown, txId: string) => {
      if (txId === 'tx-2') throw numberLockTimeout();
      return { transactionId: txId, journalEntryId: `je-${txId}` };
    }) as never);
    const ordered = [1, 2, 3].map((i) => ({ index: i - 1, txId: `tx-${i}`, line: { contraAccountId: 'acc' } }));
    const out = await postPreparedLines(ctx, ordered as never, 'bulk_allocate_bank_transactions');
    expect(out.lines.map((l) => l.transaction_id)).toEqual(['tx-1', 'tx-3']);
    expect(out.raced).toEqual([{ index: 1, transaction_id: 'tx-2', reason: RETRY }]);
  });
});

describe('bulk approve / finalize (postPartitionedDocuments)', () => {
  it('skips a document whose number lock timed out (raw 55P03) as retryable and posts the rest', async () => {
    const adapter = {
      savepointPrefix: 'bulk_t_',
      postOne: vi.fn(async (_c: McpToolContext, id: string) => {
        if (id === 'd2') throw numberLockTimeout();
        return { id };
      }),
    };
    const { posted, raced } = await postPartitionedDocuments(
      ctx, [{ index: 0, id: 'd1' }, { index: 1, id: 'd2' }, { index: 2, id: 'd3' }], adapter as never, () => null,
    );
    expect(posted).toEqual([{ id: 'd1' }, { id: 'd3' }]);
    expect(raced).toEqual([{ index: 1, document_id: 'd2', reason: RETRY }]);
  });
});

describe('any single write tool (registry)', () => {
  it('answers a raw 55P03 with retry wording, not GENERIC_FAILURE and not the driver text', async () => {
    const registry = new McpRegistry();
    const tool: McpTool = {
      name: 'create_credit_note', description: 'test', scope: 'write:bank-tx', write: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: vi.fn(async () => { throw numberLockTimeout(); }),
    };
    registry.register(tool);
    const r = await registry.call('create_credit_note', { idempotency_key: 'k1' }, ctx);
    expect(r.isError).toBe(true);
    const text = r.content[0]!.text;
    expect(text).toContain('create_credit_note');
    expect(text).toContain('nothing was written; retry in a moment');
    expect(text).not.toMatch(/55P03|lock timeout|The operation failed/);
  });
});
