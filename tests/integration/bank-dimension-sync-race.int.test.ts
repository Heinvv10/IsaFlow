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
  allocate, bankDims, cleanupSync, json, lineOn, mcpAs, newKey, pidOf, setBankDims, syncFixture, waitBlockedBy, waitForLockWaitBy, type SyncFixture,
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

afterAll(async () => { await other.end(); await cleanupSync(pool, companies, users); });

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
      await waitBlockedBy(pool, await pidOf(blocker));
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
      await waitForLockWaitBy(other, APP);
    };
    const reversed = await mcp(f.user, f.c, 'reverse_dimension_tag_batch', { batch_id: first.batch_id, idempotency_key: newKey('dlr') });
    const tagged = await tagging!;
    expect(reversed.isError, reversed.content[0]!.text).toBeFalsy();
    expect(hooks.fired).toBe(1);
    expect(tagged.isError, tagged.content[0]!.text).toBeFalsy();
    expect(await bankDims(pool, a.tx)).toEqual({ cc1: f.cc.F1, cc2: f.cc.P1, bu: f.bu.B1 });
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
      await waitBlockedBy(pool, await pidOf(blocker));
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
