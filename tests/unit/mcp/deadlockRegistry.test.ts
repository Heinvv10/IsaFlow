/**
 * A tool whose handler THROWS a raw 40P01 (Postgres chose its transaction as a deadlock victim) is answered by the
 * REGISTRY with the retryable deadlock refusal, for every tool: not GENERIC_FAILURE, no driver text, and the
 * driver error is logged once by the registry's catch, with the tool name. (thrownToolErrorText itself is pinned in
 * payrollPostLock.test.ts; this goes through McpRegistry.call and its savepoint.)
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

import { McpRegistry } from '@/lib/mcp/registry';
import { GENERIC_FAILURE } from '@/lib/mcp/thrownToolErrorText';
import { log } from '@/lib/logger';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';
import { resetSqlMock } from '../auth/helpers';

const ctx: McpToolContext = {
  userId: 'user-1', companyId: '22222222-2222-2222-2222-222222222222', companyRole: 'owner', scopes: ['write:payroll'],
  tokenJti: 'pat-33333333', oauthAppId: null,
};
const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });
const toolThrowing = (name: string, err: () => unknown): McpTool => ({
  name, description: 'test', scope: 'write:payroll', write: true,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: vi.fn(async () => { throw err(); }),
});

beforeEach(() => { vi.clearAllMocks(); resetSqlMock(); });

describe('a thrown 40P01 through McpRegistry.call', () => {
  it.each(['post_payroll_journal', 'approve_pay_run'])('%s: retryable deadlock refusal, not GENERIC_FAILURE, no driver text', async (name) => {
    const registry = new McpRegistry();
    registry.register(toolThrowing(name, deadlock));
    const r = await registry.call(name, { idempotency_key: 'k1' }, ctx);
    expect(r.isError).toBe(true);
    const text = r.content[0]!.text;
    expect(text).not.toBe(GENERIC_FAILURE);
    expect(text).toContain(`${name}: another request holds locks this one needs (deadlock)`);
    expect(text).toContain('nothing was written; retry in a moment');
    expect(text).not.toMatch(/40P01|deadlock detected|The operation failed/);
  });

  it('runs the call in its savepoint and logs the driver error once, with the tool name', async () => {
    const registry = new McpRegistry();
    registry.register(toolThrowing('post_payroll_journal', deadlock));
    await registry.call('post_payroll_journal', { idempotency_key: 'k1' }, ctx);
    expect(savepointMock).toHaveBeenCalledWith(expect.stringContaining('post_payroll_journal'), expect.any(Function));
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      'MCP tool handler failed', expect.objectContaining({ tool: 'post_payroll_journal', err: 'deadlock detected' }), 'mcp');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('answers any other thrown error with GENERIC_FAILURE (the mapping is specific to 40P01)', async () => {
    const registry = new McpRegistry();
    registry.register(toolThrowing('post_payroll_journal', () => new Error('boom')));
    const r = await registry.call('post_payroll_journal', { idempotency_key: 'k1' }, ctx);
    expect(r.content[0]!.text).toBe(GENERIC_FAILURE);
  });
});
