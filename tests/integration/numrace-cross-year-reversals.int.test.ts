/**
 * NUMRACE: the reversal posters — reverse_bank_allocation_batch, reverse_allocations and the auto-post undo — take
 * every year their contra journals can be dated in, ascending, before the first (core/numberYearLocks.ts
 * `reversalYears`: a named date's year, else the earliest original's year through the later of the latest
 * original's and this year — a contra is dated on its original when that period is open, else today).
 *
 * Each walks its lines in id order, so its years follow the uuids: reversing a 2026 line and then a 2025 one,
 * against a peer holding 2025 that then wants 2026 (helpers/numraceCrossYear.ascendingPeerVs), was a 40P01 — the
 * MCP tools failed whole, the undo swallowed it as a "contended" skip. Now the run waits for the peer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { reverseBankAllocationBatchTool } from '@/lib/mcp/tools/writeBankReverseBatch';
import { reverseAllocationsTool } from '@/lib/mcp/tools/writeBankReverseRange';
import { sweep } from '@/modules/accounting/services/bank/autoPostGateService';
import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture } from './helpers/l1FifoFixture';
import {
  ascendingPeerVs, bulkAllocate, dropCrossYear, line, seedCrossYear, toolCtx, txn, type CrossYear,
} from './helpers/numraceCrossYear';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const made: CrossYear[] = [];

/** A company with a 2026 line (id sorts first) and a 2025 line, both allocated and committed. */
async function allocatedPair(prefix: string): Promise<{ c: CrossYear; batchId: string; ids: string[] }> {
  const c = await seedCrossYear('NUMRACE-V', DATABASE_URL!);
  made.push(c);
  const a = await line(c, '11111111', '2026-01-20', `${prefix} r26`);
  const b = await line(c, '22222222', '2025-12-20', `${prefix} r25`);
  const t = await txn(c);
  const r = await t.run(() => bulkAllocate(c, [{ id: a }, { id: b }]));
  return { c, batchId: (JSON.parse(r.content[0]!.text) as { batch_id: string }).batch_id, ids: [a, b] };
}

const textOf = (v: unknown) => (v as { content: { text: string }[]; isError?: boolean });

describeIfDb('NUMRACE: cross-year reversal runs', () => {
  beforeAll(() => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
  });

  afterAll(async () => {
    for (const c of made) { await dropCrossYear(c); await dropFixture(c.fx); }
  }, 60000);

  it('reverse_bank_allocation_batch (2026 line first) vs an ascending two-year poster: both commit', async () => {
    const { c, batchId } = await allocatedPair('NRREVB');
    const { rp, rr, before, after } = await ascendingPeerVs(c, () =>
      reverseBankAllocationBatchTool.handler({ batch_id: batchId, idempotency_key: `nr-${batchId}` }, toolCtx(c)));
    process.stdout.write(`V-batch ${JSON.stringify({ rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after } })}\n`);
    expect(rp.ok, JSON.stringify(rp)).toBe(true);
    expect(rr.ok && !textOf(rr.value).isError ? JSON.parse(textOf(rr.value).content[0]!.text).reversed : rr).toBe(2);
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);

  it('reverse_allocations over Dec 2025..Jan 2026 (2026 line first) vs the same peer: both commit', async () => {
    const { c } = await allocatedPair('NRREVR');
    const { rp, rr, before, after } = await ascendingPeerVs(c, () => reverseAllocationsTool.handler({
      bank_account_id: c.fx.bankAccountId, from_date: '2025-12-01', to_date: '2026-01-31',
      idempotency_key: `nr-range-${c.fx.companyId}`,
    }, toolCtx(c)));
    process.stdout.write(`V-range ${JSON.stringify({ rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after } })}\n`);
    expect(rp.ok, JSON.stringify(rp)).toBe(true);
    expect(rr.ok && !textOf(rr.value).isError ? JSON.parse(textOf(rr.value).content[0]!.text).reversed : rr).toBe(2);
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);

  it('auto-post undo of a run with a 2026 and a 2025 line vs the same peer: both reversed, nothing skipped', async () => {
    const c = await seedCrossYear('NUMRACE-V', DATABASE_URL!);
    made.push(c);
    await sql`INSERT INTO bank_auto_post_settings (company_id, enabled, min_confidence, amount_cap)
      VALUES (${c.fx.companyId}::UUID, true, 0.5, 0)`;
    const a = await line(c, '11111111', '2026-01-20', 'NRUNDO r26');
    const b = await line(c, '22222222', '2025-12-20', 'NRUNDO r25');
    await sql`UPDATE bank_transactions SET suggested_gl_account_id = ${c.expense}::UUID, suggested_confidence = 0.99
      WHERE id IN (${a}::UUID, ${b}::UUID)`;
    const t = await txn(c);
    const run = await t.run(() => sweep(c.fx.companyId, [a, b], 'categorization', c.fx.userId));
    expect(run.posted).toBe(2);
    const { rp, rr, before, after } = await ascendingPeerVs(c, () => undoRun(c.fx.companyId, run.runId!, c.fx.userId));
    process.stdout.write(`V-undo ${JSON.stringify({ rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after } })}\n`);
    expect(rp.ok, JSON.stringify(rp)).toBe(true);
    expect(rr.ok ? (rr.value as { reversed: number; skipped: number }) : rr)
      .toMatchObject({ reversed: 2, skipped: 0 });
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);
});
