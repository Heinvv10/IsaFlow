/**
 * MCP audit module — MCP Phase 2 (blind-review fix: the documented
 * "audit failure must not mask the tool result" invariant was untested).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { log } from '@/lib/logger';
import { hashArgs, recordToolCall, findIdempotentReplay } from '@/lib/mcp/audit';
import type { McpToolContext } from '@/lib/mcp/types';
import { sqlMock, resetSqlMock, mockSqlOnce, sqlCallText, sqlCallValues } from '../auth/helpers';

const COMPANY_ID = '22222222-2222-2222-2222-222222222222';

function ctx(): McpToolContext {
  return { userId: 'user-1', companyId: COMPANY_ID, scopes: [], tokenJti: 'jti-1', oauthAppId: null };
}

beforeEach(() => {
  resetSqlMock();
  vi.mocked(log.error).mockClear();
});

describe('recordToolCall', () => {
  it('inserts a tenant-scoped audit row with the token jti', async () => {
    await recordToolCall({
      ctx: ctx(), tool: 't', argsHash: 'h1', idempotencyKey: null,
      status: 'ok', result: null, durationMs: 5,
    });
    expect(sqlCallText(0)).toContain('INSERT INTO mcp_tool_calls');
    expect(sqlCallValues(0)).toEqual(
      expect.arrayContaining([COMPANY_ID, 'user-1', 'jti-1', 't', 'h1', 'ok', 5]),
    );
  });

  it('SWALLOWS a DB failure (logs, does not throw) — audit must never mask the tool result', async () => {
    sqlMock.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value violates unique constraint "mcp_tool_calls_idem_uq"'), {
        code: '23505',
      }),
    );
    // The whole point: this resolves, it does not reject.
    await expect(
      recordToolCall({
        ctx: ctx(), tool: 't', argsHash: 'h1', idempotencyKey: 'k1',
        status: 'ok', result: { content: [] }, durationMs: 5,
      }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('recordToolCall failed'),
      expect.objectContaining({ tool: 't' }),
      'mcp',
    );
  });
});

describe('findIdempotentReplay', () => {
  it('returns the stored result for a matching ok row, scoped by tenant+tool+key', async () => {
    const stored = { content: [{ type: 'text', text: '"done"' }] };
    mockSqlOnce([{ result: stored }]);
    await expect(findIdempotentReplay(COMPANY_ID, 't', 'k1')).resolves.toEqual(stored);
    expect(sqlCallText(0)).toContain("status = 'ok'");
    expect(sqlCallValues(0)).toEqual(expect.arrayContaining([COMPANY_ID, 't', 'k1']));
  });

  it('returns null when there is no prior successful call', async () => {
    mockSqlOnce([]);
    await expect(findIdempotentReplay(COMPANY_ID, 't', 'k1')).resolves.toBeNull();
  });
});

describe('hashArgs', () => {
  it('is stable, key-order insensitive, and value sensitive', () => {
    expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ b: 2, a: 1 }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
    expect(hashArgs({})).toMatch(/^[a-f0-9]{64}$/);
  });
});
