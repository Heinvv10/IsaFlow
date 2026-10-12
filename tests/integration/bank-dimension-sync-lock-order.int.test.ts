/**
 * Tag and reversal take their journal-line locks in id order (PR #698 round 3, REPRO 5), against a real database.
 *
 * The sessions under test cannot walk the primary key (physicalPool), so without an ORDER BY an unordered locking
 * select locks rows in physical order; each test plants lines whose physical order is the reverse of their id
 * order and first asserts that premise. A wait that never sees the session block THROWS (waitBlockedBy), so the
 * assertion after it cannot pass unexercised. Disposable databases only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  cleanupSync, json, mcpAs, newKey, physicalPool, pidOf, plantOppositeOrderLines, syncFixture, unorderedLockOrder, waitBlockedBy,
  type SyncFixture,
} from './bank-dimension-sync.helpers';

assertDisposable();
const APP = `bds-lockorder-${process.pid}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: APP });
const other = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const physical = physicalPool(APP);
const mcpPhysical = mcpAs(physical);
const companies: string[] = [];
const users: string[] = [];
const tokens: Record<string, string> = {};
afterAll(async () => { await other.end(); await physical.end(); await cleanupSync(pool, companies, users); });

async function fresh(): Promise<SyncFixture> {
  const f = await syncFixture(pool, tokens, companies);
  users.push(f.user);
  return f;
}
const code = (f: SyncFixture, k: string) => `${k}${f.c.slice(0, 6)}`;

describe('tag takes its line locks in id order (round 3, REPRO 5)', () => {
  const tagLines = (f: SyncFixture, ids: string[], dim: Record<string, string>, run = mcpPhysical) =>
    run(f.user, f.c, 'tag_journal_lines', { lines: ids.map((journal_line_id) => ({ journal_line_id, ...dim })), idempotency_key: newKey('ord') });


  it('a tag whose lines sit in the opposite physical order holds the LOWER id while it waits on it', async () => {
    const f = await fresh();
    const { hi, lo } = await plantOppositeOrderLines(pool, f);
    // PREMISE: without an ORDER BY the plan's locking select, in this session, locks `hi` BEFORE `lo`.
    expect(await unorderedLockOrder(physical,
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
      await waitBlockedBy(pool, await pidOf(blocker));
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
    expect(await unorderedLockOrder(physical,
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
      await waitBlockedBy(pool, await pidOf(blocker));
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
