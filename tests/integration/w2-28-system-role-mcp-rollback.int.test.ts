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
  };
});
import { McpRegistry } from '../../src/lib/mcp/registry';
import { deactivateGlAccountTool } from '../../src/lib/mcp/tools/writeGlAccounts';

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
});
