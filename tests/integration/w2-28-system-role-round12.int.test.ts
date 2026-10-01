// W2-28 round 12 (security review of 9366d761c, breaker pass 4): an MCP batch
// stops at the first role-lock timeout; the rollback's per-account loop is
// capped; journals-scope tools that hold the role lock wait at most 5s for a
// row; a user-correctable role breach is a refusal BEFORE any write, in words
// the user can act on. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { brkFixture, within } from './w2-28-brk593.helpers';
import { drainAfterCommit } from '@/lib/afterCommit';

const h = vi.hoisted(() => ({ run: null as null | (<T>(fn: () => Promise<T>) => Promise<T>), auth: {} as Record<string, unknown> }));
// The bearer middleware's part here is the request transaction and the auth context; token checks have their own suite.
vi.mock('@/lib/auth/withBearerAuth', () => ({
  withBearerAuth: (handler: (req: unknown, res: unknown) => Promise<unknown>) => async (req: Record<string, unknown>, res: unknown) => {
    Object.assign(req, h.auth);
    return h.run!(() => handler(req, res));
  },
}));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: vi.fn(async () => true) }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true), getClientIp: vi.fn(() => '10.0.0.1') }));

import mcpRoute from '../../pages/api/mcp/index';
import migrationRollback from '../../pages/api/accounting/migration-rollback';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { setOpeningBalanceTool } from '../../src/lib/mcp/tools/writeOpeningBalance';
import { postReclassificationBatchTool } from '../../src/lib/mcp/tools/writeReclassification';
import { mergeAccounts } from '@/modules/accounting/services/gl/accountMergeService';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { MAX_ROLLBACK_LOOP_ACCOUNTS } from '@/modules/accounting/services/core/migrationRowCaps';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const fx = brkFixture('W228R12');
const { CO, USER, ins, holders } = fx;
const [BANK, AR, X, Y, EQ, SRC, KID] = Array.from({ length: 7 }, () => randomUUID());
const RETRY = 'The chart of accounts is being changed by another request — retry in a moment.';
const ctx = () => ({ userId: USER, companyId: CO, scopes: ['write:accounts', 'write:journals', 'write:post', 'read:reports'], tokenJti: 'w228r12', oauthAppId: null }) as never;

/** Holds the company's role lock on its own connection until released. */
async function holdRoleLock() {
  const c: PoolClient = await fx.connect();
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1::TEXT, 0))', [`default-accounts:${CO}`]);
  return async () => { try { await c.query('ROLLBACK'); } finally { c.release(); } };
}
/** Holds FOR UPDATE on one account row until released. */
async function holdRow(id: string) {
  const c: PoolClient = await fx.connect();
  await c.query('BEGIN');
  await c.query('SELECT 1 FROM gl_accounts WHERE id = $1 FOR UPDATE', [id]);
  return async () => { try { await c.query('ROLLBACK'); } finally { c.release(); } };
}
const period = () => fx.query(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
  VALUES ($1, 'FY26 r12', 1, 2026, '2026-01-01', '2026-12-31', 'open')`, [CO]);

describeIfDb('W2-28 round 12', () => {
  beforeAll(fx.setup);
  beforeEach(async () => {
    await fx.wipe(); await fx.query('DELETE FROM fiscal_periods WHERE company_id = $1', [CO]); clearSystemAccountCache(CO);
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(AR, '1120', 'asset', 'receivable', true);
    await ins(X, '1115', 'asset', null, false);
    await ins(Y, '1116', 'asset', null, false);
    await ins(EQ, '3900', 'equity', null, false);
  });
  afterAll(async () => { await fx.wipe(); await fx.query('DELETE FROM fiscal_periods WHERE company_id = $1', [CO]); await fx.teardown(); });

  it('item 2: a 5-call MCP batch under a held role lock answers in about ONE wait, each call with the retry refusal — and other methods still answer', async () => {
    const release = await holdRoleLock();
    const tx = await fx.openTx(drainAfterCommit);
    h.run = tx.run; h.auth = { user: { id: USER }, companyId: CO, scopes: ['write:accounts'], patId: 'w228r12', authMethod: 'pat' };
    const out = { statusCode: 0, body: undefined as unknown };
    const res = { setHeader: () => res, status: (c: number) => { out.statusCode = c; return res; }, json: (b: unknown) => { out.body = b; return res; }, end: () => res };
    const call = (id: number, name: string) => ({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'update_gl_account', arguments: { account_id: X, account_name: name, idempotency_key: randomUUID() } } });
    try {
      const t0 = Date.now();
      await within(40_000, (mcpRoute as (a: never, b: never) => Promise<unknown>)({ method: 'POST', url: '/api/mcp', headers: { authorization: 'Bearer pat_x' },
        body: [call(1, 'a'), call(2, 'b'), call(3, 'c'), { jsonrpc: '2.0', id: 4, method: 'ping' }, call(5, 'd'), call(6, 'e')] } as never, res as never));
      const ms = Date.now() - t0;
      const body = out.body as { id: number; result?: { isError?: boolean; content?: { text: string }[] } }[];
      expect({ aboutOneWait: ms >= 4500 && ms < 9000, ids: body.map((r) => r.id),
        texts: [...new Set(body.filter((r) => r.id !== 4).map((r) => `${r.result?.isError}:${r.result?.content?.[0]?.text}`))], ping: body.find((r) => r.id === 4)?.result })
        .toEqual({ aboutOneWait: true, ids: [1, 2, 3, 4, 5, 6], texts: [`true:${RETRY}`], ping: {} });
    } finally { await tx.rollback(); await release(); }
    expect((await fx.query('SELECT account_name FROM gl_accounts WHERE id = $1', [X])).rows[0].account_name).toBe('W228R12 1115');
  }, 60_000);

  it('item 4: a rollback that falls to its per-account loop works through at most the cap, leaves the rest tagged, and says how many remain', async () => {
    const n = MAX_ROLLBACK_LOOP_ACCOUNTS + 5;
    await fx.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active, is_system_account, level, imported_from)
      SELECT $1, 'R' || lpad(g::text, 6, '0'), 'imported', 'asset', 'debit', true, false, 3, 'xero' FROM generate_series(1, $2::int) g`, [CO, n]);
    // One imported account has a child of the company's own: the bulk delete is refused (FK) and the loop runs.
    const parent = (await fx.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = 'R000003'", [CO])).rows[0].id;
    await ins(KID, '1900', 'asset', null, false, { parent });
    const call = async () => {
      const t0 = Date.now();
      const r = await fx.call(migrationRollback, 'POST', '/api/accounting/migration-rollback', { source: 'xero' });
      return { status: r.statusCode, ...(r.body.data as { deleted: number; retained: number; retainedCodes: string[]; remaining?: number }), ms: Date.now() - t0 };
    };
    const tagged = async () => (await fx.query("SELECT count(*)::int AS n FROM gl_accounts WHERE company_id = $1 AND imported_from = 'xero'", [CO])).rows[0].n;
    const first = await call(); const left = await tagged();
    const second = await call();
    process.stdout.write(`\nW228R12 rollback loop: ${JSON.stringify({ first, second })}\n`);
    expect({ first: { ...first, ms: first.ms < 5000 }, left, second: { ...second, ms: second.ms < 5000 }, leftAfter: await tagged() }).toEqual({
      first: { status: 200, deleted: MAX_ROLLBACK_LOOP_ACCOUNTS - 1, retained: 1, retainedCodes: ['R000003'], remaining: 5, ms: true }, left: 5,
      // A rollback that finishes has today's shape exactly: no `remaining` key.
      second: { status: 200, deleted: 5, retained: 0, retainedCodes: [], ms: true }, leftAfter: 0 });
  }, 120_000);

  describe('item 5: journals-scope tools that hold the role lock wait at most 5s for a row', () => {
    it('set_opening_balance: its posting finds the contra account held → the retry refusal at about 5s, nothing posted', async () => {
      await period();
      const registry = new McpRegistry(); registry.register(setOpeningBalanceTool);
      const release = await holdRow(EQ);
      const tx = await fx.openTx(drainAfterCommit);
      try {
        const t0 = Date.now();
        const outcome = await within(9000, tx.run(() => registry.call('set_opening_balance',
          { bank_account_id: BANK, contra_account_id: EQ, as_at: '2026-03-01', amount: 100, idempotency_key: randomUUID() }, ctx()))
          .then((r) => r.content[0]?.text, (e: Error) => `thrown ${e.message}`));
        expect({ outcome, boundedNear5s: Date.now() - t0 >= 4500 }).toEqual({ outcome: RETRY, boundedNear5s: true });
      } finally { await release(); await tx.rollback(); }
      expect((await fx.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1', [CO])).rows[0].n).toBe(0);
    }, 30_000);

    it('post_reclassification_batch into a level-2 balance-sheet target: its posting finds the source account held → the retry refusal at about 5s', async () => {
      await period();
      await ins(SRC, '1950', 'asset', null, false);
      await ins(KID, '1900', 'asset', null, false, { level: 2 });
      const je = (await fx.query(`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by, posted_at)
        VALUES ($1, 'W228R12-1', '2026-03-15', 'seed', 'manual', 'posted', $2, NOW()) RETURNING id`, [CO, USER])).rows[0].id;
      for (const [account, debit, credit] of [[SRC, 400, 0], [EQ, 0, 400]] as const) {
        await fx.query('INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, $3, $4, $5)', [je, account, debit, credit, CO]);
      }
      const registry = new McpRegistry(); registry.register(postReclassificationBatchTool);
      const release = await holdRow(SRC);
      const tx = await fx.openTx(drainAfterCommit);
      try {
        const t0 = Date.now();
        const outcome = await within(9000, tx.run(() => registry.call('post_reclassification_batch',
          { source_account_id: SRC, target_account_id: KID, idempotency_key: randomUUID() }, ctx()))
          .then((r) => r.content[0]?.text, (e: Error) => `thrown ${e.message}`));
        expect({ outcome, boundedNear5s: Date.now() - t0 >= 4500 }).toEqual({ outcome: RETRY, boundedNear5s: true });
      } finally { await release(); await tx.rollback(); }
      expect((await fx.query('SELECT count(*)::int AS n FROM gl_journal_lines WHERE company_id = $1 AND gl_account_id = $2', [CO, KID])).rows[0].n).toBe(0);
    }, 30_000);
  });

  describe('item 7: what a user can cause is refused before any write, in words the user can act on', () => {
    it('a CoA import row parented under a balance-sheet role holder names the row and the holder — not "would leave bank without exactly one usable account"', async () => {
      const session = await createSession(CO, 'sage', USER);
      const r = await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id, systemAccountMap: {},
        accounts: [{ accountCode: '1119', accountName: 'Call account', accountType: 'asset', normalBalance: 'debit', parentCode: '1110' }] });
      const data = r.body.data as { imported: number; errors: { message: string; field: string }[] };
      expect({ status: r.statusCode, imported: data.imported, errors: data.errors.map((e) => `${e.field}: ${e.message}`), bank: await holders('bank') })
        .toEqual({ status: 200, imported: 0, bank: ['1110'],
          errors: [expect.stringMatching(/^parentCode: Account 1119 cannot go under 1110: Account 1110 holds the bank role, and a balance-sheet account/)] });
    });

    it('a merge whose source has sub-accounts, into a balance-sheet role holder, is a merge refusal naming both accounts — before anything moves', async () => {
      await ins(SRC, '1125', 'asset', 'receivable', false);
      await ins(KID, '1126', 'asset', 'receivable', false, { parent: SRC });
      const before = await fx.hash();
      const tx = await fx.openTx(drainAfterCommit);
      const outcome = await tx.run(() => mergeAccounts(CO, SRC, AR, USER)).then(() => 'merged', (e: Error & { code?: string }) => `${e.name} ${e.code}: ${e.message}`);
      await tx.commit();
      expect({ outcome, unchanged: (await fx.hash()) === before }).toEqual({ unchanged: true,
        outcome: expect.stringMatching(/^AccountMergeError target_becomes_header: 1125 has sub-accounts, which this merge would move under 1120\. Account 1120 holds the receivable role/) });
    });
  });
});
