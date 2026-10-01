// W2-28 round 9: deactivate_gl_account when the role post-condition fails AFTER
// its UPDATE — the tool must throw so the registry rolls the write back. The
// service is replaced (only the post-condition failure is forced; the UPDATE is
// real), because no real account state reaches it today. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { drainAfterCommit } from '@/lib/afterCommit';
import { brkFixture } from './w2-28-brk593.helpers';

vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', async (orig) => {
  const actual = await orig<typeof import('../../src/modules/accounting/services/gl/chartOfAccountsService')>();
  const { SystemRoleInvariantError } = await import('../../src/modules/accounting/services/gl/systemRoleInvariant');
  return {
    ...actual,
    deleteAccount: async (companyId: string, id: string) => {
      await sql`UPDATE gl_accounts SET is_active = false WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;
      throw new SystemRoleInvariantError(['bank']);
    },
    // A driver failure AFTER a write: node-postgres raises a plain Error with no code for a dropped connection.
    updateAccount: async (companyId: string, id: string, input: { accountName?: string }) => {
      if (input.accountName !== 'driver failure') return actual.updateAccount(companyId, id, input);
      await sql`UPDATE gl_accounts SET account_name = 'half written' WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;
      throw new Error('Connection terminated unexpectedly');
    },
  };
});
import { McpRegistry } from '../../src/lib/mcp/registry';
import chartOfAccounts from '../../pages/api/accounting/chart-of-accounts';
import chartOfAccountsDetail from '../../pages/api/accounting/chart-of-accounts-detail';
import { createGlAccountTool, deactivateGlAccountTool } from '../../src/lib/mcp/tools/writeGlAccounts';
import { mergeGlAccountsTool } from '../../src/lib/mcp/tools/writeMergeGlAccounts';
import { lockSystemRoleWrites } from '../../src/modules/accounting/services/gl/systemRoleWriteLock';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const fx = brkFixture('W228R9M');
const A = randomUUID();

describeIfDb('W2-28 deactivate_gl_account and the role post-condition', () => {
  beforeAll(async () => { await fx.setup(); await fx.ins(A, '1190', 'asset', null, false); });
  afterAll(fx.teardown);

  it('a post-condition failure after the UPDATE is thrown, so the registry rolls the deactivation back', async () => {
    const registry = new McpRegistry();
    registry.register(deactivateGlAccountTool);
    const tx = await fx.openTx(drainAfterCommit);
    const out = await tx.run(() => registry.call('deactivate_gl_account', { account_id: A, idempotency_key: randomUUID() },
      { userId: fx.USER, companyId: fx.CO, scopes: ['write:accounts'], tokenJti: 'w228r9m', oauthAppId: null } as never));
    await tx.commit();
    const active = (await fx.query('SELECT is_active FROM gl_accounts WHERE id = $1', [A])).rows[0].is_active;
    expect({ isError: (out as { isError?: boolean }).isError, text: JSON.stringify(out), active })
      .toEqual({ isError: true, text: expect.stringContaining('without exactly one usable account'), active: true });
  });

  it.each([
    ['create_gl_account under a parent', (parent: string) => ({ tool: 'create_gl_account',
      args: { account_code: '1191', account_name: 'Sub', account_type: 'asset', parent_account_id: parent } })],
    ['merge_gl_accounts', (parent: string) => ({ tool: 'merge_gl_accounts', args: { source_account_id: A, target_account_id: parent } })],
  ])('%s that cannot get the role lock tells the agent to retry, and the batch transaction stays usable', async (_name, build) => {
    const P = randomUUID();
    await fx.ins(P, `P${P.slice(0, 4)}`, 'asset', null, false);
    const registry = new McpRegistry();
    for (const t of [createGlAccountTool, mergeGlAccountsTool]) registry.register(t);
    const holder = await fx.openTx(drainAfterCommit);
    const batch = await fx.openTx(drainAfterCommit);
    try {
      await holder.run(() => lockSystemRoleWrites(fx.CO));
      const { tool, args } = build(P);
      const out = await batch.run(() => registry.call(tool, { ...args, idempotency_key: randomUUID() },
        { userId: fx.USER, companyId: fx.CO, scopes: ['write:accounts', 'write:post', 'write:journals', 'read:accounts'], tokenJti: 'w228r9m', oauthAppId: null } as never)
        .then((r) => JSON.stringify(r), (e: Error) => `thrown: ${e.message}`));
      // The registry rolled its savepoint back: the next statement of the same transaction works.
      if (!/retry/.test(out)) process.stdout.write(`\nW228R9M ${tool}: ${out}\n`);
      const usable = await batch.run(async () => ((await sql`SELECT 1 AS one`) as { one: number }[])[0]!.one).catch((e: Error) => e.message);
      expect({ retry: /retry in a moment/.test(out), isError: /"isError":true/.test(out), usable }).toEqual({ retry: true, isError: true, usable: 1 });
    } finally { await batch.rollback(); await holder.rollback(); }
  }, 30_000);

  it('a driver error with no code is a 500 that rolls the write back, not a 400 that commits it (both chart PUTs)', async () => {
    const answers = [
      await fx.call(chartOfAccountsDetail, 'PUT', '/api/accounting/chart-of-accounts-detail', { id: A, accountName: 'driver failure' }),
      await fx.call(chartOfAccounts, 'PUT', '/api/accounting/chart-of-accounts', { id: A, accountName: 'driver failure' }),
    ];
    const name = (await fx.query('SELECT account_name FROM gl_accounts WHERE id = $1', [A])).rows[0].account_name;
    expect({ statuses: answers.map((a) => a.statusCode), leaked: JSON.stringify(answers.map((a) => a.body)).includes('Connection terminated'), name })
      .toEqual({ statuses: [500, 500], leaked: process.env.NODE_ENV !== 'production', name: 'W228R9M 1190' });
    // A refusal is still a 400.
    expect((await fx.call(chartOfAccountsDetail, 'PUT', '/api/accounting/chart-of-accounts-detail', { id: randomUUID(), accountName: 'x' })).statusCode).toBe(400);
  });
});
