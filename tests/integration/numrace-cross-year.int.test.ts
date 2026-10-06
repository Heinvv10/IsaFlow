/**
 * NUMRACE (DOCNUM follow-up (c), brk-docnum F3): multi-journal runs that cross a year end no longer deadlock.
 *
 * Every journal number takes the company+year key of migration 857 and holds it to commit. A run that posts a
 * 2026 journal and then a 2025 one, against a run that posts 2025 and then 2026, deadlocks (40P01) — the bulk
 * posters walk their lines in id order, so the year order follows the uuids. Now a run whose lines span two or
 * more years takes every year's key, ascending, before its first journal (core/numberYearLocks.ts); a
 * single-year run takes nothing extra.
 *
 * Driven through the real posting code: bulk_allocate_bank_transactions' handler and applyRules (the bank-rules
 * apply routes and bulk-commit). The interleaving is fixed with the numrace gate on gl_journal_entries
 * (helpers/numraceGate.ts); pg_stat_database.deadlocks is read before and after (database-wide: run this file
 * with --no-file-parallelism on a fixture no other suite is using).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { postPartitionedDocuments } from '@/lib/mcp/tools/bulkApproveRunner';
import { dropFixture } from './helpers/l1FifoFixture';
import {
  dropGate, holdGate, holdKey, installGate, settle, waitBlocked, waitBlockedBy, type Settled,
} from './helpers/numraceGate';
import {
  ascendingPeerVs, bulkAllocate, deadlocks, dropCrossYear, line, postedCount, rules, seedCrossYear, toolCtx, txn,
  type CrossYear,
} from './helpers/numraceCrossYear';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const made: CrossYear[] = [];

async function fixture(): Promise<CrossYear> {
  const c = await seedCrossYear('NUMRACE-X', DATABASE_URL!);
  made.push(c);
  return c;
}

const bodyOf = (r: { content: { text: string }[]; isError?: boolean }) =>
  JSON.parse(r.content[0]!.text) as { posted: number; skipped: unknown[] };

describeIfDb('NUMRACE: cross-year multi-journal runs', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    const c = await fixture();
    await installGate(c.fx.pool, 'gl_journal_entries', 'description');
  }, 60000);

  afterAll(async () => {
    await dropGate(made[0]!.fx.pool, 'gl_journal_entries').catch(() => undefined);
    for (const c of made) { await dropCrossYear(c); await dropFixture(c.fx); }
  }, 60000);

  it('bulk allocate (2026 then 2025) vs applyRules (2025 then 2026), interleaved: both post, no deadlock', async () => {
    const c = made[0]!;
    const x26 = await line(c, '11111111', '2026-01-06', 'NRBULK x26');
    const x25 = await line(c, '22222222', '2025-12-29', 'NRBULK x25');
    const y25 = await line(c, '33333333', '2025-12-28', 'NRRULE ngate:2 y25');
    const y26 = await line(c, '44444444', '2026-01-07', 'NRRULE y26');
    const before = await deadlocks(c);
    const g1 = await holdGate(c.fx.pool, 1);
    const g2 = await holdGate(c.fx.pool, 2);
    const t1 = await txn(c), t2 = await txn(c);
    let r1!: Settled<Awaited<ReturnType<typeof bulkAllocate>>>;
    let r2!: Settled<Awaited<ReturnType<typeof rules>>>;
    try {
      // t1 posts x26 (its id sorts first) and stops at gate 1 holding that journal's key.
      const p1 = settle(t1.run(() => bulkAllocate(c, [{ id: x26, description: 'ngate:1 x26' }, { id: x25 }])));
      await waitBlockedBy(c.fx.pool, g1.pid);
      // t2 posts y25 and stops at gate 2 (before the fix), or waits for t1's up-front year keys (after).
      const p2 = settle(t2.run(() => rules(c)));
      await waitBlocked(c.fx.pool, t2.pid);
      await g1.open();
      await g2.open();
      [r1, r2] = [await p1, await p2];
    } finally {
      await g1.open();
      await g2.open();
      await t1.abandon();
      await t2.abandon();
    }
    await new Promise((r) => setTimeout(r, 1200));
    const after = await deadlocks(c);
    process.stdout.write(`A3 ${JSON.stringify({ r1, r2, deadlocks: { before, after } })}\n`);
    expect(r1.ok && !r1.value.isError ? bodyOf(r1.value).posted : r1).toBe(2);
    expect(r2.ok ? r2.value.applied : r2).toBe(2);
    expect(r2.ok ? r2.value.autoPostSkippedLocked : null).toBe(0);
    expect(await postedCount([x26, x25, y25, y26])).toBe(4);
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);

  it('an ascending two-year poster (2025, then 2026) vs bulk allocate walking 2026 first: both commit', async () => {
    const c = await fixture();
    const x26 = await line(c, '11111111', '2026-02-06', 'NRBULK p26');
    const x25 = await line(c, '22222222', '2025-11-29', 'NRBULK p25');
    const { rp, rr, before, after } = await ascendingPeerVs(c, () => bulkAllocate(c, [{ id: x26 }, { id: x25 }]));
    process.stdout.write(`ASC ${JSON.stringify({ rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after } })}\n`);
    expect(rp.ok, JSON.stringify(rp)).toBe(true);
    expect(rr.ok ? bodyOf(rr.value as never).posted : rr).toBe(2);
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);

  it('the same peer vs the bulk-approve runner given its 2026 element first: both commit (the years are sorted)', async () => {
    const c = await fixture();
    const e26 = await line(c, '11111111', '2026-02-07', 'NRDOC p26');
    const e25 = await line(c, '22222222', '2025-11-28', 'NRDOC p25');
    const adapter = {
      toolName: 'numrace_bulk', savepointPrefix: 'nr_el_', approvableStatuses: [],
      postOne: (_ctx: unknown, id: string) => allocateTransaction(c.fx.companyId, id, c.expense, c.fx.userId,
        undefined, 'account', undefined, undefined),
    };
    const { rp, rr, before, after } = await ascendingPeerVs(c, () => postPartitionedDocuments(toolCtx(c),
      [{ index: 0, id: e26, entryDate: '2026-02-07' }, { index: 1, id: e25, entryDate: '2025-11-28' }],
      adapter as never, () => null));
    process.stdout.write(`ASC-runner ${JSON.stringify({ rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after } })}\n`);
    expect(rp.ok, JSON.stringify(rp)).toBe(true);
    expect(rr.ok ? (rr.value as { posted: unknown[] }).posted.length : rr).toBe(2);
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);

  it('a single-year run takes no other year: with 2025 held, a 2026-only bulk allocate posts at once', async () => {
    const c = await fixture();
    const a = await line(c, '11111111', '2026-03-01', 'NRBULK s1');
    const b = await line(c, '22222222', '2026-03-02', 'NRBULK s2');
    const held = await holdKey(c.fx.pool, `${c.fx.companyId}:2025`, 857);
    try {
      const t0 = Date.now();
      const t = await txn(c);
      const r = await t.run(() => bulkAllocate(c, [{ id: a }, { id: b }]));
      expect(bodyOf(r).posted).toBe(2);
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      await held.open();
    }
  }, 60000);
});
