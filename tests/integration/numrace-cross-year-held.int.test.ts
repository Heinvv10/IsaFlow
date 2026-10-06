/**
 * NUMRACE: with one year's key held by a peer past 5 s, a cross-year run answers that year's elements one by one,
 * exactly as base does — ordered lazy (core/numberYearLocks.ts, Hein's ruling 2026-10-06) takes a single-year
 * element's key in its own posting, after its row, so a held year fails only its own elements (retryable, rolled back
 * in their savepoints) and the other year posts. (Rounds 1-2 took every key up front and failed the whole run.)
 * One case per poster: bulk_allocate, applyRules (route), the bulk-approve runner, the auto-post sweep.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import bankRulesAction from '../../pages/api/accounting/bank-rules-action';
import { postPartitionedDocuments } from '@/lib/mcp/tools/bulkApproveRunner';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { sweep } from '@/modules/accounting/services/bank/autoPostGateService';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { holdKey, settle } from './helpers/numraceGate';
import {
  bulkAllocate, dropCrossYear, line, postedCount, seedCrossYear, toolCtx, txn, type CrossYear,
} from './helpers/numraceCrossYear';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const made: CrossYear[] = [];
let routeFx: CrossYear | null = null;

async function fixture(): Promise<CrossYear> {
  const c = await seedCrossYear('NUMRACE-H', DATABASE_URL!);
  made.push(c);
  return c;
}

/** Runs `fn` on its own transaction while a peer holds this company's 2025 journal key. */
async function with2025Held<T>(c: CrossYear, fn: () => Promise<T>) {
  const held = await holdKey(c.fx.pool, `${c.fx.companyId}:2025`, 857);
  try {
    const t = await txn(c);
    return await settle(t.run(fn));
  } finally {
    await held.open();
  }
}

describeIfDb('NUMRACE: a cross-year run whose year keys are held is retryable as a whole', () => {
  beforeAll(() => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
  });

  afterAll(async () => {
    if (routeFx) await dropRouteUser(routeFx.fx);
    for (const c of made) { await dropCrossYear(c); await dropFixture(c.fx); }
  }, 60000);

  it('bulk_allocate: the 2025 line is skipped "retry", the 2026 line posts', async () => {
    const c = await fixture();
    const a = await line(c, '11111111', '2025-12-30', 'NRBULK h25');
    const b = await line(c, '22222222', '2026-01-02', 'NRBULK h26');
    const r = await with2025Held(c, () => bulkAllocate(c, [{ id: a }, { id: b }]));
    process.stdout.write(`H-bulk ${JSON.stringify(r)}\n`);
    const body = r.ok ? JSON.parse((r.value as { content: { text: string }[] }).content[0]!.text) : r;
    expect(body.posted).toBe(1);
    expect(body.skipped).toEqual([{ index: 0, transaction_id: a, reason: 'locked by another request — retry' }]);
    expect(await postedCount([b])).toBe(1);
  }, 60000);

  it('applyRules through POST bank-rules-action apply: 200, the 2025 line counted held, the 2026 line posted', async () => {
    const c = routeFx = await fixture();
    const token = await seedRouteUser(c.fx, 'numrace-h');
    const a = await line(c, '11111111', '2025-12-30', 'NRRULE h25');
    const b = await line(c, '22222222', '2026-01-02', 'NRRULE h26');
    const held = await holdKey(c.fx.pool, `${c.fx.companyId}:2025`, 857);
    let out: Awaited<ReturnType<typeof callRoute>> & { getHeader?: (n: string) => unknown };
    try {
      out = await callRoute(c.fx, token, bankRulesAction, { action: 'apply', bankAccountId: c.fx.bankAccountId });
    } finally {
      await held.open();
    }
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect((out.body as { data: Record<string, unknown> }).data).toMatchObject({ applied: 1, autoPostSkippedLocked: 1 });
    expect(await postedCount([b])).toBe(1);
  }, 60000);

  it('postPartitionedDocuments (bulk approve runner): the 2025 element skipped "retry", the 2026 one posts', async () => {
    const c = await fixture();
    const a = await line(c, '11111111', '2025-11-03', 'NRDOC h25');
    const b = await line(c, '22222222', '2026-08-03', 'NRDOC h26');
    const adapter = {
      toolName: 'numrace_bulk', savepointPrefix: 'nr_el_', approvableStatuses: [],
      postOne: (_ctx: unknown, id: string) => allocateTransaction(c.fx.companyId, id, c.expense, c.fx.userId,
        undefined, 'account', undefined, undefined),
    };
    const r = await with2025Held(c, () => postPartitionedDocuments(toolCtx(c),
      [{ index: 0, id: a, entryDate: '2025-11-03' }, { index: 1, id: b, entryDate: '2026-08-03' }],
      adapter as never, () => null));
    process.stdout.write(`H-runner ${JSON.stringify(r)}\n`);
    const o = r.ok ? r.value as { posted: unknown[]; raced: unknown[] } : null;
    expect(o?.posted.length).toBe(1);
    expect(o?.raced).toEqual([{ index: 0, document_id: a, reason: 'locked by another request — retry' }]);
    expect(await postedCount([b])).toBe(1);
  }, 60000);

  it('auto-post sweep: the 2025 line skipped, the 2026 line posted', async () => {
    const c = await fixture();
    await sql`INSERT INTO bank_auto_post_settings (company_id, enabled, min_confidence, amount_cap)
      VALUES (${c.fx.companyId}::UUID, true, 0.5, 0)`;
    const a = await line(c, '11111111', '2025-12-30', 'NRSWEEP h25');
    const b = await line(c, '22222222', '2026-01-02', 'NRSWEEP h26');
    await sql`UPDATE bank_transactions SET suggested_gl_account_id = ${c.expense}::UUID, suggested_confidence = 0.99
      WHERE id IN (${a}::UUID, ${b}::UUID)`;
    const r = await with2025Held(c, () => sweep(c.fx.companyId, [a, b], 'categorization', c.fx.userId));
    process.stdout.write(`H-sweep ${JSON.stringify(r)}\n`);
    expect(r.ok ? { posted: r.value.posted, skipped: r.value.skipped.map((x: { txId: string }) => x.txId) } : r)
      .toEqual({ posted: 1, skipped: [a] });
    expect(await postedCount([b])).toBe(1);
  }, 60000);
});
