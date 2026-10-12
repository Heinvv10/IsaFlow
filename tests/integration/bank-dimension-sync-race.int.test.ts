/**
 * The bank-row sync against a concurrent writer (PR #698 round 2, breaker H2 /
 * H3): the live path locks the candidate rows between its read and its write, so
 * another request cannot slip a change in; and a row that did change is never
 * overwritten — the sync throws and nothing of the batch is left.
 *
 * `@/lib/neon`'s sql is wrapped so a hook fires straight after the candidate
 * SELECT (the window between the read and the write), passing every statement
 * through otherwise. Disposable databases only.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asToken } from './bank-controls-a.helpers';
import {
  allocate, bankDims, cleanupSync, json, lineOn, mcpAs, newKey, plantOppositeOrderLines, setBankDims, syncFixture, type SyncFixture,
} from './bank-dimension-sync.helpers';
import { applyBankSyncBatch, writeBankRows } from '../../src/modules/accounting/services/gl/dimensions/dimensionBankSync';
import { sql } from '../../src/lib/neon';

const hooks = vi.hoisted(() => ({ afterCandidateSelect: null as null | (() => Promise<void>), fired: 0 }));

vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>;
  const wrapped = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const hook = hooks.afterCandidateSelect;
    const text = strings.join('?');
    // The candidate SELECT (its ORDER BY / FOR UPDATE are spliced in, so match what stays in the template) or the batch's bank-row lock.
    const isCandidateRead = text.includes('FROM bank_transactions bt') && text.includes('jd.sets = 1');
    const isBankRowLock = text.includes('FROM bank_transactions bt') && text.includes('dimension_tag_batch_bank_rows br');
    if (!hook || !(isCandidateRead || isBankRowLock)) return realSql(strings, ...values);
    hooks.afterCandidateSelect = null;
    return (async () => {
      const rows = await realSql(strings, ...values);
      hooks.fired += 1;
      await hook();
      return rows;
    })();
  };
  return { ...real, sql: Object.assign(wrapped, realSql) };
});

assertDisposable();
// Named, so a lock-wait probe can look at THIS file's sessions only (other files share the database).
const APP = `bds-race-${process.pid}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: APP });
const other = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const companies: string[] = [];
const users: string[] = [];
const tokens: Record<string, string> = {};
const mcp = mcpAs(pool);

/** Wait (up to 5s) until some session is blocked on a lock held by `blockerPid`: the session under test, not any other file's. */
async function waitBlockedBy(blockerPid: number): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const waiting = await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1::INT = ANY(pg_blocking_pids(pid))', [blockerPid]);
    if (waiting.rowCount) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
const pidOf = async (c: { query: (t: string) => Promise<{ rows: { pid: number }[] }> }): Promise<number> =>
  (await c.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
// Sessions that cannot walk the primary key: with index and bitmap scans off, an UNORDERED locking select returns
// (and so locks) rows in physical order. Per-connection startup options, so no other session or file is touched.
const physical = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, application_name: APP, options: '-c enable_indexscan=off -c enable_bitmapscan=off -c enable_indexonlyscan=off' });
const mcpPhysical = mcpAs(physical);
afterAll(async () => { await other.end(); await physical.end(); await cleanupSync(pool, companies, users); });

const WINDOW = { date_from: '2026-01-01', date_to: '2026-12-31' };
async function fresh(): Promise<SyncFixture> {
  const f = await syncFixture(pool, tokens, companies);
  users.push(f.user);
  return f;
}
const code = (f: SyncFixture, k: string) => `${k}${f.c.slice(0, 6)}`;
const counts = async (f: SyncFixture) => (await pool.query(
  `SELECT (SELECT COUNT(*) FROM dimension_tag_batches WHERE company_id = $1)::INT AS batches,
          (SELECT COUNT(*) FROM dimension_tag_batch_bank_rows WHERE company_id = $1)::INT AS bank_rows`, [f.c])).rows[0] as
  { batches: number; bank_rows: number };

describe('the candidate rows are locked from the read to the commit', () => {
  it('a writer that tries a candidate row between the SELECT and the UPDATE is made to wait, and the sync lands whole', async () => {
    const f = await fresh();
    const a = await allocate(pool, f, { cc2: code(f, 'P1') });
    let outcome = 'not run';
    hooks.fired = 0;
    hooks.afterCandidateSelect = async () => {
      const c = await other.connect();
      try {
        await c.query("SET lock_timeout = '400ms'");
        await c.query('UPDATE bank_transactions SET bu_id = $2 WHERE id = $1', [a.tx, f.bu.B2]);
        outcome = 'updated';
      } catch (err) {
        outcome = (err as { code?: string }).code ?? String(err);
      } finally {
        await c.query('RESET lock_timeout');
        c.release();
      }
    };
    const res = await mcp(f.user, f.c, 'sync_bank_dimensions', { ...WINDOW, idempotency_key: newKey('lock') });
    expect(hooks.fired).toBe(1);
    expect(outcome).toBe('55P03');
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(json<{ bank_rows_synced: number }>(res).bank_rows_synced).toBe(1);
    expect(await bankDims(pool, a.tx)).toEqual({ cc1: f.cc.F1, cc2: f.cc.P1, bu: null });
  });
});

describe('candidate rows are locked in id order, so two syncs cannot deadlock (breaker H3)', () => {
  it('a sync waiting on the LATER row already holds the EARLIER one', async () => {
    const f = await fresh();
    // Planted later-id first, so an unordered scan would reach it first.
    const later = await allocate(pool, f, { cc2: code(f, 'P1'), txId: 'ffffffff-0000-4000-8000-000000000001' });
    const earlier = await allocate(pool, f, { cc2: code(f, 'P2'), txId: '00000000-0000-4000-8000-000000000001' });
    const blocker = await other.connect();
    const probe = await other.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM bank_transactions WHERE id = $1 FOR UPDATE', [later.tx]);
      const syncing = asToken(pool, f.user, f.c, () => applyBankSyncBatch(
        f.c, { dateFrom: '2026-01-01', dateTo: '2026-12-31' }, { idempotencyKey: newKey('order'), userId: f.user }));
      await waitBlockedBy(await pidOf(blocker));
      let probed = 'acquired';
      try {
        await probe.query('SELECT 1 FROM bank_transactions WHERE id = $1 FOR UPDATE NOWAIT', [earlier.tx]);
      } catch (err) {
        probed = (err as { code?: string }).code ?? String(err);
      }
      await blocker.query('COMMIT');
      expect(probed).toBe('55P03');
      expect((await syncing).bankRowCount).toBe(2);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      probe.release();
    }
  });
});

describe('a row that changed since it was planned is never overwritten', () => {
  it('one stale row among fresh ones: typed error, no batch, no audit rows, every row as it was', async () => {
    const f = await fresh();
    const a = await allocate(pool, f, { cc2: code(f, 'P1') });
    const b = await allocate(pool, f, { cc2: code(f, 'P2') });
    // The plan (what a sync read): both rows blank. Then `a` is changed by someone else.
    const blank = { cc1Id: null, cc2Id: null, buId: null };
    const planned = (tx: string, cc1: string, cc2: string) => ({
      bankTransactionId: tx, transactionDate: '2026-09-01', amount: -1150, description: 'x',
      old: blank, next: { cc1Id: cc1, cc2Id: cc2, buId: null }, blanks: [] as never[],
    });
    await setBankDims(pool, a.tx, { bu: f.bu.B2 });

    await expect(asToken(pool, f.user, f.c, async () => {
      const [batch] = (await sql`
        INSERT INTO dimension_tag_batches (company_id, idempotency_key, line_count, sync_date_from, sync_date_to)
        VALUES (${f.c}::UUID, ${newKey('stale')}, 0, DATE '2026-01-01', DATE '2026-12-31') RETURNING id::TEXT AS id`) as { id: string }[];
      await writeBankRows(f.c, batch!.id, [planned(a.tx, f.cc.F1, f.cc.P1), planned(b.tx, f.cc.F2, f.cc.P2)]);
    })).rejects.toMatchObject({ code: 'BANK_DIMENSION_SYNC_REFUSED', message: expect.stringMatching(/1 bank transaction\(s\) were changed/) });

    expect(await counts(f)).toEqual({ batches: 0, bank_rows: 0 });
    expect(await bankDims(pool, a.tx)).toEqual({ cc1: null, cc2: null, bu: f.bu.B2 });
    expect(await bankDims(pool, b.tx)).toEqual({ cc1: null, cc2: null, bu: null });
  });
});

describe('tag and reverse take their locks in one order: lines, then bank rows (breaker REPRO 2)', () => {
  it('a tag of the same line, begun while the reversal holds the bank rows, does not deadlock with it (40P01)', async () => {
    const f = await fresh();
    const a = await allocate(pool, f, { cc2: code(f, 'P1') });
    const line = (await lineOn(pool, a.journal, f.expA)).id;
    const first = json<{ batch_id: string }>(await mcp(f.user, f.c, 'tag_journal_lines', {
      lines: [{ journal_line_id: line, cc2: code(f, 'P2') }], idempotency_key: newKey('dl1') }));
    let tagging: Promise<{ isError?: boolean; content: { text: string }[] }> | null = null;
    hooks.fired = 0;
    // The reversal has just locked the batch's bank rows (and, fixed, its lines before them). A second tag of the
    // same line now starts: it locks the line, then wants the bank row. Wait until it is blocked on someone.
    hooks.afterCandidateSelect = async () => {
      tagging = mcp(f.user, f.c, 'tag_journal_lines', {
        lines: [{ journal_line_id: line, bu: code(f, 'B1') }], idempotency_key: newKey('dl2') });
      for (let i = 0; i < 100; i += 1) {
        const waiting = await other.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND application_name = $1", [APP]);
        if (waiting.rowCount) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const reversed = await mcp(f.user, f.c, 'reverse_dimension_tag_batch', { batch_id: first.batch_id, idempotency_key: newKey('dlr') });
    const tagged = await tagging!;
    expect(reversed.isError, reversed.content[0]!.text).toBeFalsy();
    expect(hooks.fired).toBe(1);
    expect(tagged.isError, tagged.content[0]!.text).toBeFalsy();
    expect(await bankDims(pool, a.tx)).toEqual({ cc1: f.cc.F1, cc2: f.cc.P1, bu: f.bu.B1 });
  });
});

describe('tag takes its line locks in id order (round 3, REPRO 5)', () => {
  const tagLines = (f: SyncFixture, ids: string[], dim: Record<string, string>, run = mcpPhysical) =>
    run(f.user, f.c, 'tag_journal_lines', { lines: ids.map((journal_line_id) => ({ journal_line_id, ...dim })), idempotency_key: newKey('ord') });

  /** The rows an UNORDERED locking select returns in a `physical` session, in the order it locks them. */
  async function unorderedLockOrder(text: string, values: unknown[]): Promise<string[]> {
    const c = await physical.connect();
    try {
      await c.query('BEGIN');
      const res = await c.query(text, values);
      return res.rows.map((r: { id: string }) => r.id);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  it('a tag whose lines sit in the opposite physical order holds the LOWER id while it waits on it', async () => {
    const f = await fresh();
    const { hi, lo } = await plantOppositeOrderLines(pool, f);
    // PREMISE: without an ORDER BY the plan's locking select, in this session, locks `hi` BEFORE `lo`.
    expect(await unorderedLockOrder(
      `SELECT jl.id::TEXT AS id FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
       JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
       LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id AND fp.company_id = je.company_id
       WHERE jl.company_id = $1::UUID AND jl.id = ANY($2::UUID[]) FOR UPDATE OF jl`, [f.c, [lo, hi]])).toEqual([hi, lo]);
    const blocker = await other.connect();
    const probe = await other.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM gl_journal_lines WHERE id = $1 FOR UPDATE', [lo]);
      const tagging = tagLines(f, [hi, lo], { cc2: code(f, 'P1') });
      await waitBlockedBy(await pidOf(blocker));
      // In id order the tag took `lo` first and is blocked on it, so `hi` is still free; in physical order it holds `hi`.
      let probed = 'acquired';
      try {
        await probe.query('SELECT 1 FROM gl_journal_lines WHERE id = $1 FOR UPDATE NOWAIT', [hi]);
      } catch (err) {
        probed = (err as { code?: string }).code ?? String(err);
      }
      await blocker.query('COMMIT');
      expect(probed).toBe('acquired');
      const res = await tagging;
      expect(res.isError, res.content[0]!.text).toBeFalsy();
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      probe.release();
    }
  });

  it('the reversal of such a batch takes its lines in id order too', async () => {
    const f = await fresh();
    const { hi, lo } = await plantOppositeOrderLines(pool, f);
    const batch = json<{ batch_id: string }>(await tagLines(f, [hi, lo], { cc2: code(f, 'P1') })).batch_id;
    // PREMISE: without an ORDER BY the reversal's line lock, in this session, locks `hi` BEFORE `lo`.
    expect(await unorderedLockOrder(
      `SELECT jl.id::TEXT AS id FROM gl_journal_lines jl
       WHERE jl.company_id = $1::UUID
         AND jl.id IN (SELECT bl.journal_line_id FROM dimension_tag_batch_lines bl WHERE bl.batch_id = $2::UUID AND bl.company_id = $1::UUID)
       FOR UPDATE OF jl`, [f.c, batch])).toEqual([hi, lo]);
    const blocker = await other.connect();
    const probe = await other.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM gl_journal_lines WHERE id = $1 FOR UPDATE', [lo]);
      const reversing = mcpPhysical(f.user, f.c, 'reverse_dimension_tag_batch', { batch_id: batch, idempotency_key: newKey('ordr') });
      await waitBlockedBy(await pidOf(blocker));
      let probed = 'acquired';
      try {
        await probe.query('SELECT 1 FROM gl_journal_lines WHERE id = $1 FOR UPDATE NOWAIT', [hi]);
      } catch (err) {
        probed = (err as { code?: string }).code ?? String(err);
      }
      await blocker.query('COMMIT');
      expect(probed).toBe('acquired');
      const res = await reversing;
      expect(res.isError, res.content[0]!.text).toBeFalsy();
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      probe.release();
    }
  });

  it('two overlapping tag batches whose lines arrive in opposite order both land (no 40P01)', async () => {
    const f = await fresh();
    const { hi, lo } = await plantOppositeOrderLines(pool, f);
    const [a, b] = await Promise.all([
      tagLines(f, [hi, lo], { cc2: code(f, 'P1') }),
      tagLines(f, [lo, hi], { cc2: code(f, 'P2') }),
    ]);
    expect(a.isError, a.content[0]!.text).toBeFalsy();
    expect(b.isError, b.content[0]!.text).toBeFalsy();
  });
});

describe('reversal locks the batch\'s bank rows before it checks them (follow-up)', () => {
  const reverse = (f: SyncFixture, batch: string) =>
    mcp(f.user, f.c, 'reverse_dimension_tag_batch', { batch_id: batch, idempotency_key: newKey('rev') });

  it('a writer that tries a bank row between the drift check and the restore is made to wait; the reversal lands whole', async () => {
    const f = await fresh();
    const a = await allocate(pool, f, { cc2: code(f, 'P1') });
    const batch = json<{ batch_id: string }>(await mcp(f.user, f.c, 'sync_bank_dimensions', { ...WINDOW, idempotency_key: newKey('s') })).batch_id;
    let outcome = 'not run';
    hooks.fired = 0;
    hooks.afterCandidateSelect = async () => {
      const c = await other.connect();
      try {
        await c.query("SET lock_timeout = '400ms'");
        await c.query('UPDATE bank_transactions SET bu_id = $2 WHERE id = $1', [a.tx, f.bu.B2]);
        outcome = 'updated';
      } catch (err) {
        outcome = (err as { code?: string }).code ?? String(err);
      } finally {
        await c.query('RESET lock_timeout');
        c.release();
      }
    };
    const res = await reverse(f, batch);
    expect(hooks.fired).toBe(1);
    expect(outcome).toBe('55P03');
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(await bankDims(pool, a.tx)).toEqual({ cc1: null, cc2: null, bu: null });
  });

  it('locks in id order: a reversal waiting on the LATER row already holds the EARLIER one', async () => {
    const f = await fresh();
    const later = await allocate(pool, f, { cc2: code(f, 'P1'), txId: 'ffffffff-0000-4000-8000-000000000002' });
    const earlier = await allocate(pool, f, { cc2: code(f, 'P2'), txId: '00000000-0000-4000-8000-000000000002' });
    const batch = json<{ batch_id: string }>(await mcp(f.user, f.c, 'sync_bank_dimensions', { ...WINDOW, idempotency_key: newKey('s') })).batch_id;
    const blocker = await other.connect();
    const probe = await other.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM bank_transactions WHERE id = $1 FOR UPDATE', [later.tx]);
      const reversing = reverse(f, batch);
      await waitBlockedBy(await pidOf(blocker));
      let probed = 'acquired';
      try {
        await probe.query('SELECT 1 FROM bank_transactions WHERE id = $1 FOR UPDATE NOWAIT', [earlier.tx]);
      } catch (err) {
        probed = (err as { code?: string }).code ?? String(err);
      }
      await blocker.query('COMMIT');
      expect(probed).toBe('55P03');
      const res = await reversing;
      expect(res.isError, res.content[0]!.text).toBeFalsy();
      expect(json<{ bank_rows_restored: number }>(res).bank_rows_restored).toBe(2);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      probe.release();
    }
  });
});
