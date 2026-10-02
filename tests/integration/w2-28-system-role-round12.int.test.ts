// W2-28 round 12 (security review of 9366d761c, breaker pass 4): an MCP batch
// stops at the first role-lock timeout; the rollback's per-account loop is
// capped; journals-scope tools that hold the role lock wait at most 5s for a
// row; a user-correctable role breach is a refusal BEFORE any write, in words
// the user can act on. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { brkFixture, sleep, within } from './w2-28-brk593.helpers';
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
import migrationExecute from '../../pages/api/accounting/migration-execute';
import coa from '../../pages/api/accounting/chart-of-accounts';
import { updateGlAccountTool } from '../../src/lib/mcp/tools/writeGlAccounts';
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

  it('item 2: a 5-call MCP batch under a held role lock answers in about ONE wait: the first call gets the retry refusal, the rest are skipped, audited and say why — other methods and a malformed call still answer as before', async () => {
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
        body: [call(1, 'a'), call(2, 'b'), call(3, 'c'), { jsonrpc: '2.0', id: 4, method: 'ping' }, call(5, 'd'), call(6, 'e'),
          { jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} }] } as never, res as never));
      const ms = Date.now() - t0;
      await tx.commit();                                   // as the bearer middleware does: the audit rows are the request's
      const body = out.body as { id: number; error?: { message: string }; result?: { isError?: boolean; content?: { text: string }[] } }[];
      const text = (id: number) => { const r = body.find((b) => b.id === id)?.result; return `${r?.isError}:${r?.content?.[0]?.text}`; };
      expect({ aboutOneWait: ms >= 4500 && ms < 9000, ids: body.map((r) => r.id), first: text(1), ping: body.find((r) => r.id === 4)?.result,
        skipped: [...new Set([2, 3, 5, 6].map(text))], malformed: body.find((r) => r.id === 7)?.error?.message })
        .toEqual({ aboutOneWait: true, ids: [1, 2, 3, 4, 5, 6, 7], first: `true:${RETRY}`, ping: {}, malformed: 'tool name required',
          skipped: [expect.stringMatching(/^true:Not run: an earlier call in this batch found the chart of accounts being changed by another request.*Nothing was written or charged.*retry/)] });
    } finally { await tx.rollback(); await release(); }
    expect((await fx.query('SELECT account_name FROM gl_accounts WHERE id = $1', [X])).rows[0].account_name).toBe('W228R12 1115');
    // Every call is on the audit trail: the one that waited as an error, the four that were not run as rejected —
    // none holding its idempotency key (the retry must run), and nothing debited.
    const audit = (await fx.query(`SELECT status, count(*)::int AS n, count(idempotency_key)::int AS keys FROM mcp_tool_calls
      WHERE company_id = $1 AND tool = 'update_gl_account' GROUP BY status ORDER BY status`, [CO])).rows;
    const debits = (await fx.query('SELECT count(*)::int AS n FROM flow_ledger WHERE company_id = $1', [CO])).rows[0].n;
    expect({ audit, debits }).toEqual({ audit: [{ status: 'error', n: 1, keys: 0 }, { status: 'rejected', n: 4, keys: 0 }], debits: 0 });
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

  describe('item 8: a balance-sheet holder that is ALREADY a header gains no further sub-account, by any path', () => {
    beforeEach(() => ins(KID, '1111', 'asset', 'bank', false, { parent: BANK, level: 4 }));   // the legacy child
    const childrenOfBank = async () => (await fx.query('SELECT account_code FROM gl_accounts WHERE parent_account_id = $1 ORDER BY 1', [BANK])).rows.map((r) => r.account_code);
    const importRows = async (accounts: Record<string, unknown>[]) => {
      const session = await createSession(CO, 'sage', USER);
      const r = await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id, accounts, systemAccountMap: {} });
      const data = r.body.data as { imported: number; errors: { message: string }[] };
      return { imported: data.imported, errors: data.errors.map((e) => e.message) };
    };

    it('the CoA import refuses a NEW row under it, naming the row; re-importing the child it already has is not a new sub-account', async () => {
      const added = await importRows([{ accountCode: '1113', accountName: 'Call account', accountType: 'asset', normalBalance: 'debit', parentCode: '1110' }]);
      const restated = await importRows([{ accountCode: '1111', accountName: 'Savings (renamed)', accountType: 'asset', accountSubtype: 'bank', normalBalance: 'debit', parentCode: '1110' }]);
      expect({ added, restated, children: await childrenOfBank(), bank: await holders('bank') }).toEqual({
        added: { imported: 0, errors: [expect.stringMatching(/^Account 1113 cannot go under 1110: Account 1110 holds the bank role/)] },
        restated: { imported: 1, errors: [] }, children: ['1111'], bank: ['1110'] });
    });

    it('a merge whose source has a sub-account is refused into it, before anything moves', async () => {
      await ins(SRC, '1120X', 'asset', 'bank', false);
      const moved = randomUUID(); await ins(moved, '1121', 'asset', 'bank', false, { parent: SRC, level: 4 });
      const before = await fx.hash();
      const tx = await fx.openTx(drainAfterCommit);
      const outcome = await tx.run(() => mergeAccounts(CO, SRC, BANK, USER)).then(() => 'merged', (e: Error & { code?: string }) => `${e.code}: ${e.message}`);
      await tx.commit();
      expect({ outcome, unchanged: (await fx.hash()) === before, children: await childrenOfBank() }).toEqual({ unchanged: true, children: ['1111'],
        outcome: expect.stringMatching(/^target_becomes_header: 1120X has sub-accounts, which this merge would move under 1110\./) });
    });
  });

  it('item 12: a lock timeout in the migration execute\'s later steps is the retryable 503 with NOTHING written — not a 200 carrying it as a row error', async () => {
    const holder: PoolClient = await fx.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE customers IN SHARE ROW EXCLUSIVE MODE');   // the customers step cannot insert until this ends
      const t0 = Date.now();
      const r = await within(12_000, fx.call(migrationExecute, 'POST', '/api/accounting/migration-execute', { source: 'xero', suppliers: [],
        accounts: [{ sourceCode: 'E100', sourceName: 'Executed', sourceType: 'BANK', openingBalance: 0, mappedType: 'asset', mappedNormalBalance: 'debit', mappedSubtype: 'other' }],
        customers: [{ name: 'W228R12 customer' }] }));
      const state = typeof r === 'string' ? { status: r, text: '' } : { status: r.statusCode, text: JSON.stringify(r.body) };
      expect({ status: state.status, retry: /retry in a moment|SERVICE_UNAVAILABLE/i.test(state.text), boundedNear5s: Date.now() - t0 >= 4500,
        accountWritten: (await fx.query("SELECT count(*)::int AS n FROM gl_accounts WHERE company_id = $1 AND account_code = 'E100'", [CO])).rows[0].n })
        .toEqual({ status: 503, retry: true, boundedNear5s: true, accountWritten: 0 });
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  }, 30_000);

  describe('item 10: a REAL deadlock (Postgres picks the role writer as the victim: 40P01) is the retryable answer', () => {
    const deadlocks = async () => (await fx.query('SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()')).rows[0].n as number;
    const lockWaiters = async () => (await fx.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()")).rows[0].n as number;
    /**
     * The other transaction holds X's row FOR SHARE (a document-line guard) and, once the writer — holding the
     * role lock — is waiting for that row, asks for the role lock itself: a cycle. The writer has waited longer,
     * so its deadlock check runs first and it is the victim.
     */
    async function deadlockAgainst<T>(write: () => Promise<T>) {
      const other: PoolClient = await fx.connect();
      const d0 = await deadlocks();
      try {
        await other.query('BEGIN');
        await other.query('SELECT 1 FROM gl_accounts WHERE id = $1 FOR SHARE', [X]);
        const writing = write();
        let waiting = false;
        for (let i = 0; i < 160 && !waiting; i++) { waiting = (await lockWaiters()) > 0; if (!waiting) await sleep(25); }
        const t0 = Date.now();
        const otherGot = other.query('SELECT pg_advisory_xact_lock(hashtextextended($1::TEXT, 0))', [`default-accounts:${CO}`])
          .then(() => 'got the role lock', (e: { code?: string }) => `victim ${e.code}`);
        const out = await within(8000, writing);
        const ms = Date.now() - t0;
        const otherOutcome = await within(8000, otherGot);
        // A backend reports its counters when its transaction ends, so the count is read by the caller, after that.
        const deadlocksDetected = async () => {
          let n = 0;
          for (let i = 0; i < 40 && n === 0; i++) { await sleep(150); n = (await deadlocks()) - d0; }
          return n;
        };
        return { result: { out, waiting, otherOutcome, answeredBeforeTheTimeout: ms < 3500 }, deadlocksDetected };
      } finally { await other.query('ROLLBACK').catch(() => undefined); other.release(); }
    }

    it('a route: 503 with the retry wording, nothing written', async () => {
      const before = await fx.hash();
      const { result: r, deadlocksDetected } = await deadlockAgainst(() => fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: X, accountName: 'renamed' }));
      const out = r.out as { statusCode: number; body: Record<string, unknown> };
      expect({ ...r, deadlocksDetected: await deadlocksDetected(), out: { status: out.statusCode, retry: /retry in a moment/.test(JSON.stringify(out.body)) }, unchanged: (await fx.hash()) === before })
        .toEqual({ out: { status: 503, retry: true }, waiting: true, otherOutcome: 'got the role lock', answeredBeforeTheTimeout: true, deadlocksDetected: 1, unchanged: true });
    }, 30_000);

    it('an MCP tool in a batch: the retry refusal, nothing written, and the batch transaction is still usable', async () => {
      const registry = new McpRegistry(); registry.register(updateGlAccountTool);
      const rename = (id: string, name: string) => registry.call('update_gl_account', { account_id: id, account_name: name, idempotency_key: randomUUID() }, ctx())
        .then((x) => `${x.isError ? 'refused' : 'ok'}: ${x.content[0]?.text.slice(0, 90)}`, (e: Error) => `thrown ${e.message}`);
      const tx = await fx.openTx(drainAfterCommit);
      try {
        const { result: r, deadlocksDetected } = await deadlockAgainst(() => tx.run(() => rename(X, 'renamed by the victim')));
        const next = await tx.run(() => rename(Y, 'batch still usable'));
        await tx.commit();
        const names = (await fx.query('SELECT account_code, account_name FROM gl_accounts WHERE id = ANY($1::uuid[]) ORDER BY 1', [[X, Y]])).rows.map((n) => `${n.account_code}=${n.account_name}`);
        expect({ ...r, deadlocksDetected: await deadlocksDetected(), next: next.slice(0, 3), names }).toEqual({ out: `refused: ${RETRY}`, waiting: true, otherOutcome: 'got the role lock',
          answeredBeforeTheTimeout: true, deadlocksDetected: 1, next: 'ok:', names: ['1115=W228R12 1115', '1116=batch still usable'] });
      } finally { await tx.rollback(); }
    }, 30_000);
  });

  describe('item 7: what a user can cause is refused before any write, in words the user can act on', () => {
    it('round 13: a row parented under an account the SAME import\'s role map makes a balance-sheet holder is named too — not left to the post-condition', async () => {
      const session = await createSession(CO, 'sage', USER);
      const r = await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id, systemAccountMap: { payable: 'P200' },
        accounts: [{ accountCode: 'P200', accountName: 'Creditors', accountType: 'liability', normalBalance: 'credit' },
          { accountCode: 'P201', accountName: 'Creditors - foreign', accountType: 'liability', normalBalance: 'credit', parentCode: 'P200' }] });
      const data = r.body.data as { imported: number; errors: { message: string; field: string }[] };
      const texts = data.errors.map((e) => `${e.field}: ${e.message}`);
      expect({ imported: data.imported, row: texts.filter((t) => t.startsWith('parentCode:')), vague: texts.filter((t) => /without exactly one usable/.test(t)) })
        .toEqual({ imported: 0, vague: [], row: [expect.stringMatching(/^parentCode: Account P201 cannot go under P200: Account P200 holds the payable role/)] });
    });

    it('a CoA import row parented under a balance-sheet role holder names the row and the holder — not "would leave bank without exactly one usable account"', async () => {
      const session = await createSession(CO, 'sage', USER);
      const r = await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id, systemAccountMap: {},
        accounts: [{ accountCode: '1119', accountName: 'Call account', accountType: 'asset', normalBalance: 'debit', parentCode: '1110' }] });
      const data = r.body.data as { imported: number; errors: { message: string; field: string }[] };
      expect({ status: r.statusCode, imported: data.imported, errors: data.errors.map((e) => `${e.field}: ${e.message}`), bank: await holders('bank') })
        .toEqual({ status: 200, imported: 0, bank: ['1110'],
          errors: [expect.stringMatching(/^parentCode: Account 1119 cannot go under 1110: Account 1110 holds the bank role, and a balance-sheet account/)] });
    });

    describe('round 14: the same-import holder-as-parent rule, the cases left untested', () => {
      const importing = async (accounts: Record<string, unknown>[], systemAccountMap: Record<string, string>) => {
        const before = await fx.hash();
        const session = await createSession(CO, 'sage', USER);
        const r = await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id, accounts, systemAccountMap });
        const data = r.body.data as { imported: number; errors: { message: string; field: string }[] };
        const chartUnchanged = (await fx.query('SELECT count(*)::int AS n FROM gl_accounts WHERE company_id = $1', [CO])).rows[0].n;
        return { imported: data.imported, errors: data.errors.map((e) => `${e.field}: ${e.message}`), unchanged: (await fx.hash()) === before, accounts: chartUnchanged };
      };
      const row = (accountCode: string, accountType: string, extra: Record<string, unknown> = {}) =>
        ({ accountCode, accountName: `Imported ${accountCode}`, accountType, normalBalance: ['asset', 'expense'].includes(accountType) ? 'debit' : 'credit', ...extra });

      it('the map gives an EXISTING balance-sheet system header a role while a row of the file is parented under it: refused before any write, the row named', async () => {
        await ins(SRC, '1000', 'asset', null, true, { level: 1 });
        const out = await importing([row('1000', 'asset'), row('1001', 'asset', { parentCode: '1000' })], { bank: '1000' });
        expect(out).toEqual({ imported: 0, unchanged: true, accounts: 6, errors: expect.arrayContaining([
          expect.stringMatching(/^parentCode: Account 1001 cannot go under 1000: Account 1000 holds the bank role, and a balance-sheet account/)]) });
        expect(out.errors.join(' ')).not.toMatch(/without exactly one usable/);
        expect(await holders('bank')).toEqual(['1110']);
      });

      it('the same for an EXISTING income-statement system header: neither the parent rule nor the assignment rule bars it — imported, the role on it', async () => {
        await ins(SRC, '4000', 'revenue', null, true, { level: 1 });
        const out = await importing([row('4000', 'revenue'), row('4001', 'revenue', { parentCode: '4000', accountSubtype: 'revenue' })], { default_revenue: '4000' });
        // No "cannot go under" row error: an income-statement holder may have sub-accounts.
        expect(out.errors.filter((e) => e.startsWith('parentCode:'))).toEqual([]);
        // Nor is the role ASSIGNMENT (D5, Hein 2026-10-02): an income-statement role may go to an account that has,
        // or is given, sub-accounts — only a balance-sheet one may not.
        expect({ imported: out.imported, refusals: out.errors.filter((e) => /is a header|without exactly one/.test(e)), holder: await holders('default_revenue') })
          .toEqual({ imported: 2, refusals: [], holder: ['4000'] });
      });

      it('a revenue holder as the parent of a row in the same import, re-stated in the map: allowed, the role stays with it', async () => {
        await ins(SRC, '4100', 'revenue', 'default_revenue', true);
        const out = await importing([row('4100', 'revenue'), row('4101', 'revenue', { parentCode: '4100', accountSubtype: 'revenue' })], { default_revenue: '4100' });
        const parent = (await fx.query(`SELECT p.account_code FROM gl_accounts c JOIN gl_accounts p ON p.id = c.parent_account_id
          WHERE c.company_id = $1 AND c.account_code = '4101'`, [CO])).rows[0]?.account_code;
        expect({ imported: out.imported, refusals: out.errors.filter((e) => /cannot go under|is a header|without exactly one/.test(e)), parent, holder: await holders('default_revenue') })
          .toEqual({ imported: 2, refusals: [], parent: '4100', holder: ['4100'] });
      });
    });

    it('item 14: an import role map onto an account carrying its type\'s default classification says where to change it and that the import can be re-run', async () => {
      await ins(SRC, '4200', 'revenue', 'revenue', false);
      const session = await createSession(CO, 'sage', USER);
      const r = await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id, systemAccountMap: { default_revenue: '4200' },
        accounts: [{ accountCode: '4200', accountName: 'Sales', accountType: 'revenue', normalBalance: 'credit' }] });
      const data = r.body.data as { imported: number; errors: { message: string }[] };
      expect({ imported: data.imported, text: data.errors[0]?.message }).toEqual({ imported: 0,
        text: expect.stringMatching(/^Account 4200 has the subtype 'revenue'.*Chart of Accounts: edit account 4200, set its subtype to 'other' and save — then run this import again\.$/) });
      expect(data.errors[0]?.message).not.toMatch(/classif/i);
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
