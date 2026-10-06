/**
 * NUMRACE: a cross-year run whose up-front year keys cannot be had within 5 s is retryable AS A WHOLE.
 *
 * Each multi-journal poster now takes every year's journal key (857) ascending before its first journal when its
 * lines span two or more years (core/numberYearLocks.ts). A peer holding one of those keys past the 5 s bound fails
 * that up-front lock with 55P03, outside any per-line savepoint, so the run posts nothing and the caller answers
 * retry: MCP (registry lockWaitErrorText), the bank-rules apply route 503 + Retry-After, the auto-post sweep's
 * callers (smart-categorize 503; import keeps the import and reports the auto-post failure). Before the fix the
 * held year's line alone was skipped and the rest posted, after deadlock-prone interleaving.
 *
 * One case per call site, so removing any one call turns its case RED: bulk_allocate (bulkAllocationPost),
 * applyRules, the MCP bulk-approve runner (postPartitionedDocuments), the auto-post sweep.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import bankRulesAction from '../../pages/api/accounting/bank-rules-action';
import { lockWaitErrorText } from '@/lib/mcp/lockWaitError';
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

  it('bulk_allocate: 55P03 for the whole call (MCP says retry), nothing posted', async () => {
    const c = await fixture();
    const a = await line(c, '11111111', '2025-12-30', 'NRBULK h25');
    const b = await line(c, '22222222', '2026-01-02', 'NRBULK h26');
    const r = await with2025Held(c, () => bulkAllocate(c, [{ id: a }, { id: b }]));
    process.stdout.write(`H-bulk ${JSON.stringify(r)}\n`);
    expect(r.ok ? 'ok' : r.code).toBe('55P03');
    expect(r.ok ? null : lockWaitErrorText('bulk_allocate_bank_transactions', { code: r.code })).toMatch(/retry/i);
    expect(await postedCount([a, b])).toBe(0);
  }, 60000);

  it('applyRules through POST bank-rules-action apply: 503 + Retry-After, nothing posted', async () => {
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
    expect(out.statusCode, JSON.stringify(out.body)).toBe(503);
    expect(out.getHeader?.('retry-after')).toBe('2');
    expect(await postedCount([a, b])).toBe(0);
  }, 60000);

  it('postPartitionedDocuments (bulk approve runner): 55P03 for the whole run, nothing posted', async () => {
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
    expect(r.ok ? 'ok' : r.code).toBe('55P03');
    expect(await postedCount([a, b])).toBe(0);
  }, 60000);

  it('auto-post sweep: 55P03 for the whole sweep (smart-categorize answers 503), nothing posted', async () => {
    const c = await fixture();
    await sql`INSERT INTO bank_auto_post_settings (company_id, enabled, min_confidence, amount_cap)
      VALUES (${c.fx.companyId}::UUID, true, 0.5, 0)`;
    const a = await line(c, '11111111', '2025-12-30', 'NRSWEEP h25');
    const b = await line(c, '22222222', '2026-01-02', 'NRSWEEP h26');
    await sql`UPDATE bank_transactions SET suggested_gl_account_id = ${c.expense}::UUID, suggested_confidence = 0.99
      WHERE id IN (${a}::UUID, ${b}::UUID)`;
    const r = await with2025Held(c, () => sweep(c.fx.companyId, [a, b], 'categorization', c.fx.userId));
    process.stdout.write(`H-sweep ${JSON.stringify(r)}\n`);
    expect(r.ok ? 'ok' : r.code).toBe('55P03');
    expect(await postedCount([a, b])).toBe(0);
  }, 60000);
});
