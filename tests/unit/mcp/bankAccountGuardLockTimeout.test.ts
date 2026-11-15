/**
 * WP2-1 round 4 — pins the agent-facing TEXT mapping only (the 5 s bound itself is integration-tested in
 * bank-account-guard-routes.int.test.ts): an MCP WRITE tool whose bank-account check (bankGlAccountBelongsToCompany → bank/bankAccountGuard)
 * waits out its 5 s bound gets the guard's RowLockTimeoutError — code ROW_LOCK_TIMEOUT, not a raw 55P03, so
 * `lockWaitErrorText` does not see it. The agent must still read the retry wording, not GENERIC_FAILURE: that holds
 * because ROW_LOCK_TIMEOUT is on REFUSAL_CODES. Driven through McpRegistry.call, with the REAL guard converting the
 * 55P03 its FOR SHARE read raised inside a request transaction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    withSavepoint: vi.fn(async (_name: string, cb: () => unknown) => cb()),
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { als } from '@/lib/als';
import { McpRegistry } from '@/lib/mcp/registry';
import { GENERIC_FAILURE } from '@/lib/mcp/thrownToolErrorText';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';
import { bankGlAccountBelongsToCompany } from '@/modules/accounting/services/bank/bankStatementImportService';
import { resetSqlMock, sqlMock } from '../auth/helpers';

const COMPANY = '22222222-2222-2222-2222-222222222222';
const BANK = '33333333-3333-4333-8333-333333333333';
const ctx: McpToolContext = {
  userId: 'user-1', companyId: COMPANY, companyRole: 'owner', scopes: ['write:bank-tx'], tokenJti: 'pat-1', oauthAppId: null,
};
const writeTool: McpTool = {
  name: 'perform_bank_reconciliation', description: 'test', scope: 'write:bank-tx', write: true,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    await bankGlAccountBelongsToCompany(COMPANY, BANK);
    throw new Error('unreachable: the account read was held');
  },
};
/** The request transaction's client: the guard reads and sets lock_timeout on it. */
const client = { query: vi.fn(async () => ({ rows: [{ prev: '0' }] })) };

beforeEach(() => {
  vi.clearAllMocks();
  resetSqlMock();
  // Only the guard's FOR SHARE read is held; the registry's own statements answer normally.
  sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
    if (strings.join('?').includes('FOR SHARE')) {
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    }
    return [];
  });
});

describe('agent-facing TEXT for the guard\'s RowLockTimeoutError (the text mapping, not the 5 s bound — that is pinned in bank-account-guard-routes.int)', () => {
  it('an MCP write tool whose guard read timed out replies with the retry wording (ROW_LOCK_TIMEOUT on REFUSAL_CODES), not GENERIC_FAILURE', async () => {
    const registry = new McpRegistry();
    registry.register(writeTool);
    const r = await als.run({ client, userId: 'user-1', companyId: COMPANY, claims: {} } as never,
      () => registry.call('perform_bank_reconciliation', { idempotency_key: 'k1' }, ctx));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('This bank account is being changed by another request — retry in a moment.');
    expect(r.content[0]!.text).not.toBe(GENERIC_FAILURE);
  });
});
