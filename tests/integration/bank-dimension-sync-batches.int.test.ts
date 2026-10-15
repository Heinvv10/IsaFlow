/**
 * The batches behind the bank-row sync (PR #698 round 2), against a real
 * database: reverse_dimension_tag_batch counting and restoring bank rows as well
 * as lines, the idempotency key refusing a batch of another kind or window, the
 * row cap, and the tenant fence.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asToken } from './bank-controls-a.helpers';
import { sql } from '../../src/lib/neon';
import {
  allocate, bankDims, cleanupSync, json, lineOn, mcpAs, newKey, setBankDims, syncFixture, type SyncFixture,
} from './bank-dimension-sync.helpers';
import { syncBankDimensionsTool } from '../../src/lib/mcp/tools/writeBankDimensionSync';
import { planTagBatchReversal } from '../../src/modules/accounting/services/gl/dimensions/dimensionTagApply';
import { previewBankSync } from '../../src/modules/accounting/services/gl/dimensions/dimensionBankSync';
import { withBoundedStatements } from '../../src/modules/accounting/services/gl/dimensions/boundedStatements';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
const tokens: Record<string, string> = {};
const mcp = mcpAs(pool);
// The row-cap test plants 2001 journals; tearing them down takes longer than the default hook budget under load.
afterAll(() => cleanupSync(pool, companies, users), 60_000);

const WINDOW = { date_from: '2026-01-01', date_to: '2026-12-31' };
async function fresh(): Promise<SyncFixture> {
  const f = await syncFixture(pool, tokens, companies);
  users.push(f.user);
  return f;
}
const code = (f: SyncFixture, k: string) => `${k}${f.c.slice(0, 6)}`;
const sync = (f: SyncFixture, dry: boolean, extra: Record<string, unknown> = {}) =>
  mcp(f.user, f.c, 'sync_bank_dimensions', { ...WINDOW, dry_run: dry, idempotency_key: newKey('sync'), ...extra });
const tag = (f: SyncFixture, lines: Record<string, unknown>[], key = newKey('tag')) =>
  mcp(f.user, f.c, 'tag_journal_lines', { lines, idempotency_key: key });
const reverse = (f: SyncFixture, batch: string, dry: boolean) =>
  mcp(f.user, f.c, 'reverse_dimension_tag_batch', { batch_id: batch, dry_run: dry, idempotency_key: newKey('rev') });
const callHandler = (f: SyncFixture, args: Record<string, unknown>) => asToken(pool, f.user, f.c, () => syncBankDimensionsTool.handler(
  args, { userId: f.user, companyId: f.c, scopes: ['write:journals'], tokenJti: 'bds', oauthAppId: null }));

describe('reverse_dimension_tag_batch counts and restores the bank rows (blind MEDIUM 3)', () => {
  it('a tag batch: lines and bank rows, dry run and live', async () => {
    const f = await fresh();
    const a = await allocate(pool, f, {});
    const b = await allocate(pool, f, {});
    const done = json<{ batch_id: string; bank_rows_synced: number }>(await tag(f, [
      { journal_line_id: (await lineOn(pool, a.journal, f.expA)).id, cc2: code(f, 'P1') },
      { journal_line_id: (await lineOn(pool, b.journal, f.expA)).id, cc2: code(f, 'P2'), bu: code(f, 'B1') }]));
    expect(done.bank_rows_synced).toBe(2);

    const dry = json<Record<string, unknown>>(await reverse(f, done.batch_id, true));
    expect(dry).toMatchObject({ would_restore: 2, would_restore_bank_rows: 2 });
    expect(await bankDims(pool, a.tx)).toEqual({ cc1: f.cc.F1, cc2: f.cc.P1, bu: null });

    const live = json<Record<string, unknown>>(await reverse(f, done.batch_id, false));
    expect(live).toMatchObject({ restored: 2, bank_rows_restored: 2 });
    expect(await bankDims(pool, a.tx)).toEqual({ cc1: null, cc2: null, bu: null });
    expect(await bankDims(pool, b.tx)).toEqual({ cc1: null, cc2: null, bu: null });
    expect((await lineOn(pool, a.journal, f.expA)).cc2).toBeNull();
  });

  it('a sync batch has no lines: restored 0 lines, and the bank rows it changed', async () => {
    const f = await fresh();
    const a = await allocate(pool, f, { cc2: code(f, 'P1') });
    const b = await allocate(pool, f, { cc2: code(f, 'P2') });
    const done = json<{ batch_id: string }>(await sync(f, false));
    expect(json<Record<string, unknown>>(await reverse(f, done.batch_id, true)))
      .toMatchObject({ would_restore: 0, would_restore_bank_rows: 2 });
    expect(json<Record<string, unknown>>(await reverse(f, done.batch_id, false)))
      .toMatchObject({ restored: 0, bank_rows_restored: 2 });
    expect(await bankDims(pool, a.tx)).toEqual({ cc1: null, cc2: null, bu: null });
    expect(await bankDims(pool, b.tx)).toEqual({ cc1: null, cc2: null, bu: null });
  });

  it('is refused when a bank row of the batch was changed since, and writes nothing', async () => {
    const f = await fresh();
    const a = await allocate(pool, f, { cc2: code(f, 'P1') });
    const done = json<{ batch_id: string }>(await sync(f, false));
    await setBankDims(pool, a.tx, { cc1: f.cc.F2, cc2: f.cc.P2 });
    const refused = await reverse(f, done.batch_id, false);
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/1 bank transaction\(s\) .* re-tagged after it/);
    expect(await bankDims(pool, a.tx)).toEqual({ cc1: f.cc.F2, cc2: f.cc.P2, bu: null });
  });
});

describe('the idempotency key names one batch of one kind and window (blind LOW)', () => {
  it('sync_bank_dimensions with the key of a tag_journal_lines batch is refused, and writes nothing', async () => {
    const f = await fresh();
    const a = await allocate(pool, f, {});
    const b = await allocate(pool, f, { cc2: code(f, 'P2') });
    const key = newKey('shared');
    await tag(f, [{ journal_line_id: (await lineOn(pool, a.journal, f.expA)).id, cc2: code(f, 'P1') }], key);
    const refused = await mcp(f.user, f.c, 'sync_bank_dimensions', { ...WINDOW, idempotency_key: key });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/idempotency_key .* tag_journal_lines batch/);
    expect(await bankDims(pool, b.tx)).toEqual({ cc1: null, cc2: null, bu: null });
  });

  it('tag_journal_lines with the key of a sync batch is refused', async () => {
    const f = await fresh();
    const a = await allocate(pool, f, { cc2: code(f, 'P1') });
    const b = await allocate(pool, f, {});
    const key = newKey('shared');
    await mcp(f.user, f.c, 'sync_bank_dimensions', { ...WINDOW, idempotency_key: key });
    const refused = await tag(f, [{ journal_line_id: (await lineOn(pool, b.journal, f.expA)).id, cc2: code(f, 'P2') }], key);
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/idempotency_key .* sync_bank_dimensions batch/);
    expect(await bankDims(pool, a.tx)).toEqual({ cc1: f.cc.F1, cc2: f.cc.P1, bu: null });
    expect((await lineOn(pool, b.journal, f.expA)).cc2).toBeNull();
  });

  it('the same sync window under the same key replays; another window under it is refused', async () => {
    const f = await fresh();
    await allocate(pool, f, { cc2: code(f, 'P1') });
    const key = newKey('win');
    const first = json<{ batch_id: string }>(await mcp(f.user, f.c, 'sync_bank_dimensions', { ...WINDOW, idempotency_key: key }));
    const replay = json<{ batch_id: string; replayed?: boolean }>(await callHandler(f, { ...WINDOW, idempotency_key: key }));
    expect(replay).toEqual({ batch_id: first.batch_id, replayed: true });
    await expect(callHandler(f, { date_from: '2026-03-01', date_to: '2026-03-31', idempotency_key: key }))
      .rejects.toMatchObject({ code: 'BANK_DIMENSION_SYNC_REFUSED' });
  });
});

describe('the row cap (blind LOW)', () => {
  const ROWS = 2001;
  async function plantRows(f: SyncFixture): Promise<void> {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SET LOCAL session_replication_role = replica');
      await db.query(`CREATE TEMP TABLE cap ON COMMIT DROP AS SELECT i, gen_random_uuid() je, gen_random_uuid() l_exp,
                        gen_random_uuid() l_bank, gen_random_uuid() bt FROM generate_series(1, $1::INT) i`, [ROWS]);
      await db.query(`INSERT INTO gl_journal_entries(id, company_id, entry_number, entry_date, description, source, status, created_by)
                      SELECT je, $1, 'CAP-' || i, DATE '2026-11-01', 'cap', 'manual', 'posted', $2 FROM cap`, [f.c, f.user]);
      await db.query(`INSERT INTO gl_journal_lines(id, journal_entry_id, company_id, gl_account_id, debit, credit, cc1_id, cc2_id)
                      SELECT l_exp, je, $1::UUID, $2::UUID, 10, 0, $4::UUID, $5::UUID FROM cap
                      UNION ALL SELECT l_bank, je, $1::UUID, $3::UUID, 0, 10, NULL::UUID, NULL::UUID FROM cap`, [f.c, f.expA, f.bank, f.cc.F1, f.cc.P1]);
      await db.query(`INSERT INTO bank_transactions(id, company_id, bank_account_id, transaction_date, amount, description, status, matched_journal_line_id)
                      SELECT bt, $1, $2, DATE '2026-11-01', -10, 'cap', 'allocated', l_bank FROM cap`, [f.c, f.bank]);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    } finally { db.release(); }
    // Plan against the rows just planted, not whatever an earlier suite left: an ANALYZE (autovacuum's, or a
    // suite's) of these tables while they were nearly empty but many pages long records about zero rows per page,
    // the planner then takes these 2001 rows for one or two, and probes each bank row's journal through the
    // company index, 2001 x 2001 (20 s in the integration gate; red on a second run of this file alone).
    await pool.query('ANALYZE gl_journal_entries, gl_journal_lines, bank_transactions');
  }

  it('the dry run reports the total and the cap; the live call refuses and writes nothing', async () => {
    const f = await fresh();
    await plantRows(f);
    const window = { date_from: '2026-11-01', date_to: '2026-11-01' };
    const started = Date.now();
    const dry = json<{ would_sync: number; max_rows: number; over_max_rows: boolean; sample: unknown[] }>(
      await mcp(f.user, f.c, 'sync_bank_dimensions', { ...window, dry_run: true, idempotency_key: newKey('cap') }));
    // A plan that goes quadratic on the shared journal rule must go red here, not hang a gate: the whole call, every statement of it.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(dry).toMatchObject({ would_sync: ROWS, max_rows: 2000, over_max_rows: true });
    expect(dry.sample.length).toBeLessThanOrEqual(25);

    const live = await mcp(f.user, f.c, 'sync_bank_dimensions', { ...window, idempotency_key: newKey('cap') });
    expect(live.isError).toBe(true);
    expect(live.content[0]!.text).toMatch(/more than 2000 bank transactions: narrow date_from \/ date_to/);
    const [r] = (await pool.query(
      `SELECT (SELECT COUNT(*) FROM bank_transactions WHERE company_id = $1 AND cc1_id IS NOT NULL)::INT AS tagged,
              (SELECT COUNT(*) FROM dimension_tag_batches WHERE company_id = $1)::INT AS batches`, [f.c])).rows;
    expect(r).toEqual({ tagged: 0, batches: 0 });
  });
});

describe('the dry-run sample is the EARLIEST rows of the window, whatever their ids (blind LOW)', () => {
  it('ids sort against the dates: the cut and the sample still take the earliest dates', async () => {
    const f = await fresh();
    // id order is the reverse of date order.
    const rows = [
      { id: 'ffffffff-0000-4000-8000-0000000000a1', date: '2026-02-01' },
      { id: 'cccccccc-0000-4000-8000-0000000000a1', date: '2026-04-01' },
      { id: '99999999-0000-4000-8000-0000000000a1', date: '2026-06-01' },
      { id: '00000000-0000-4000-8000-0000000000a1', date: '2026-08-01' },
    ];
    for (const r of rows) await allocate(pool, f, { cc2: code(f, 'P1'), txId: r.id, date: r.date });
    const p = await previewBankSync(f.c, { dateFrom: '2026-01-01', dateTo: '2026-12-31' }, { sample: 2, maxRows: 3 });
    expect(p).toMatchObject({ count: 4, overMaxRows: true, maxRows: 3 });
    expect(p.sample.map((r) => r.transactionDate)).toEqual(['2026-02-01', '2026-04-01']);
    expect(p.blanking).toEqual([]);
    const tool = json<{ sample: { date: string }[] }>(await sync(f, true));
    expect(tool.sample.map((r) => r.date)).toEqual(['2026-02-01', '2026-04-01', '2026-06-01', '2026-08-01']);
  });
});

describe('the reversal\'s lock wait is bounded like the forward path (blind LOW)', () => {
  it('a bank row held by another session makes the reversal plan fail as the typed refusal, not hang or leak a raw cancel', async () => {
    const f = await fresh();
    const a = await allocate(pool, f, { cc2: code(f, 'P1') });
    const batch = json<{ batch_id: string }>(await sync(f, false)).batch_id;
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM bank_transactions WHERE id = $1 FOR UPDATE', [a.tx]);
      const started = Date.now();
      await expect(asToken(pool, f.user, f.c, async () => {
        await sql`SET LOCAL statement_timeout = '500ms'`;
        return planTagBatchReversal(f.c, batch);
      })).rejects.toMatchObject({ code: 'BANK_DIMENSION_SYNC_REFUSED', message: expect.stringMatching(/reversal lock wait ran longer than 0\.5s and was cancelled: another request/) });
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});

describe('the server-side bound on the candidate read', () => {
  it('cancels a read that outruns it as the typed refusal, and puts the caller\'s own settings back', async () => {
    const f = await fresh();
    const seen = await asToken(pool, f.user, f.c, async () => {
      const setting = async () => (await sql`SELECT current_setting('statement_timeout') AS t, current_setting('jit') AS j`)[0] as { t: string; j: string };
      const before = await setting();
      let inside = { t: '', j: '' };
      const refusal = await withBoundedStatements(async () => {
        inside = await setting();
        await sql`SELECT pg_sleep(3)`;
      }, 300).then(() => null, (err: unknown) => err);
      return { before, inside, refusal, after: refusal instanceof Error ? null : await setting() };
    });
    expect(seen.inside).toEqual({ t: '300ms', j: 'off' });
    expect(seen.refusal).toMatchObject({ code: 'BANK_DIMENSION_SYNC_REFUSED', message: expect.stringMatching(/longer than 0.3s and was cancelled: narrow date_from/) });
    expect(seen.before.t).not.toBe('300ms');
  });

  it('a normal read leaves the settings as it found them', async () => {
    const f = await fresh();
    const seen = await asToken(pool, f.user, f.c, async () => {
      const setting = async () => (await sql`SELECT current_setting('statement_timeout') AS t, current_setting('jit') AS j`)[0] as { t: string; j: string };
      const before = await setting();
      await withBoundedStatements(async () => (await sql`SELECT 1`).length);
      return { before, after: await setting() };
    });
    expect(seen.after).toEqual(seen.before);
  });

  it('a tighter caller budget is kept', async () => {
    const f = await fresh();
    const seen = await asToken(pool, f.user, f.c, async () => {
      await sql`SET LOCAL statement_timeout = '200ms'`;
      const inner = await withBoundedStatements(async () => (await sql`SELECT current_setting('statement_timeout') AS t`)[0] as { t: string });
      const after = (await sql`SELECT current_setting('statement_timeout') AS t`)[0] as { t: string };
      return { inner, after };
    });
    expect(seen.inner.t).toBe('200ms');
    expect(seen.after.t).toBe('200ms');
  });
});

describe('the tenant fence', () => {
  it('another company cannot see or reverse a batch, and its sync touches none of the first company\'s rows', async () => {
    const f1 = await fresh();
    const f2 = await fresh();
    const a = await allocate(pool, f1, {});
    const done = json<{ batch_id: string }>(await tag(f1, [
      { journal_line_id: (await lineOn(pool, a.journal, f1.expA)).id, cc2: code(f1, 'P1') }]));
    const other = await reverse(f2, done.batch_id, false);
    expect(other.isError).toBe(true);
    expect(other.content[0]!.text).toMatch(/not found/i);
    expect(await bankDims(pool, a.tx)).toEqual({ cc1: f1.cc.F1, cc2: f1.cc.P1, bu: null });

    const b = await allocate(pool, f1, { cc2: code(f1, 'P2') });
    expect(json<{ would_sync: number }>(await sync(f2, true)).would_sync).toBe(0);
    expect(json<{ bank_rows_synced: number }>(await sync(f2, false)).bank_rows_synced).toBe(0);
    expect(await bankDims(pool, b.tx)).toEqual({ cc1: null, cc2: null, bu: null });
  });

  it('the query itself scopes by company, not only the row-level security the tool runs under', async () => {
    const f1 = await fresh();
    const f2 = await fresh();
    await allocate(pool, f1, { cc2: code(f1, 'P1') });
    const window = { dateFrom: '2026-01-01', dateTo: '2026-12-31' };
    // Outside a request transaction the service runs as the fixture's superuser: RLS does not apply.
    expect((await previewBankSync(f1.c, window)).count).toBe(1);
    expect((await previewBankSync(f2.c, window)).count).toBe(0);
    const batch = json<{ batch_id: string }>(await sync(f1, false)).batch_id;
    expect((await planTagBatchReversal(f1.c, batch)).bankRowCount).toBe(1);
    await expect(planTagBatchReversal(f2.c, batch)).rejects.toThrow('Not found');
  });
});
