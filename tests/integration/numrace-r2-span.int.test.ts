/**
 * NUMRACE round 2 (sec-numrace S1, blind LOW2): the up-front year lock no longer scales with a run's date SPAN.
 *
 *   - A reversal's years are the originals' years, today's, and where a default is VAT-locked the roll's landing year
 *     (gl/journalReversalYears) — not every year from the earliest original to today. One bank line dated 0001-06-01
 *     (a QIF parses it) made reverse_bank_allocation_batch hold ~2027 advisory locks.
 *   - More than 20 distinct years is refused before any lock or write (YearSpanTooWideError, 400): one GL import
 *     naming thousands of years filled the cluster-wide shared lock table (53200 for every tenant).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import glImport from '../../pages/api/accounting/gl-import';
import { reverseBankAllocationBatchTool } from '@/lib/mcp/tools/writeBankReverseBatch';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { bulkAllocate, dropCrossYear, line, seedCrossYear, toolCtx, txn, type CrossYear } from './helpers/numraceCrossYear';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
let c: CrossYear;
let token = '';

describeIfDb('NUMRACE r2: the year lock is bounded by the years, not the span', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedCrossYear('NUMRACE-SP', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'numrace-sp');
  }, 60000);

  afterAll(async () => {
    await dropRouteUser(c.fx);
    await dropCrossYear(c);
    await dropFixture(c.fx);
  }, 60000);

  it('reversing one allocation dated 0001-06-01 holds a handful of advisory locks, not one per year since', async () => {
    // Legacy data: since round 3 (S4) nothing can post a journal dated 0001, so allocate it in 2025 and backdate the
    // line and its journal the way a pre-S4 import left them (triggers off for the rewrite only).
    const id = await line(c, 'a0aaaaaa', '2025-06-01', 'NRSPAN ancient');
    const alloc = await txn(c);
    const body = JSON.parse((await alloc.run(() => bulkAllocate(c, [{ id }]))).content[0]!.text) as { batch_id: string };
    const legacy = await c.fx.pool.connect();
    try {
      await legacy.query('BEGIN');
      await legacy.query('SET LOCAL session_replication_role = replica');
      const je = await legacy.query(`UPDATE gl_journal_entries SET entry_date = '0001-06-01' WHERE id = (SELECT
        jl.journal_entry_id FROM bank_transactions bt JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
        WHERE bt.id = $1)`, [id]);
      const bt = await legacy.query("UPDATE bank_transactions SET transaction_date = '0001-06-01' WHERE id = $1", [id]);
      expect([je.rowCount, bt.rowCount]).toEqual([1, 1]);
      await legacy.query('COMMIT');
    } finally { legacy.release(); }
    const t = await txn(c);
    let held = -1;
    const out = await t.run(async () => {
      const r = await reverseBankAllocationBatchTool.handler(
        { batch_id: body.batch_id, idempotency_key: `nr-span-${body.batch_id}` }, toolCtx(c));
      held = Number(((await c.fx.pool.query(
        "SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = $1", [t.pid])).rows[0]).n);
      return r;
    });
    process.stdout.write(`SPAN-rev ${JSON.stringify({ held, out: out.content[0]!.text.slice(0, 200) })}\n`);
    expect(JSON.parse(out.content[0]!.text).reversed).toBe(1);
    expect(held).toBeLessThan(20);
  }, 120000);

  it('a GL import naming 21 distinct years is refused 400 before anything is written', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => 2000 + i).flatMap((y) => [
      { date: `${y}-06-01`, reference: `NRSP-${y}`, accountCode: '6000', description: 'nr span', debit: 1, credit: 0 },
      { date: `${y}-06-01`, reference: `NRSP-${y}`, accountCode: '1000', description: 'nr span', debit: 0, credit: 1 },
    ]);
    const out = await callRoute(c.fx, token, glImport, { rows, postImmediately: false });
    const written = (await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries
      WHERE company_id = ${c.fx.companyId}::UUID AND description LIKE 'NRSP-%'`) as { n: number }[];
    process.stdout.write(`SPAN-cap ${JSON.stringify({ status: out.statusCode, body: out.body, written })}\n`);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/21 different years .*Split it/);
    expect(written[0]!.n).toBe(0);
  }, 120000);
});
