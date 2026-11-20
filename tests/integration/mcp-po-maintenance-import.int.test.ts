/**
 * bulk_create_purchase_orders: the per-PO budget_check of a dry run and skip_budget_check_for_import (docs/design/mcp-po-maintenance.md,
 * decision 5), real PostgreSQL, as app_user (poImportHarness). Budget: BB-6100 opex at CC1 FT, 1 000 a month; a PO of price p has 2 x p.
 *   - dry_run: per PO budget_check {outcome ok | warn | block, reasons}, decided by the check the live call runs; a block no longer
 *     ends the preview, it makes would_succeed false and is listed; drafts / billed / cancelled have no budget_check; each PO
 *     carries its own dimension_warnings; nothing is written, no budget event, no counter move;
 *   - live without the flag: the same block refuses the batch (unchanged);
 *   - the flag: owner / admin only, refused for a manager before any read (dry run too); with it the approved PO is created, the
 *     response lists would_have_failed with the reasons (live and dry run), each PO's audit row says the check was skipped.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { asOwner, callTool, counterNext, poCount, sagePo, type Json } from './helpers/poImportHarness';
import { auditOf, budgetEvents, dropMaintExtras, glCount } from './helpers/poMaintHarness';
import { bulkCreatePurchaseOrdersTool as create } from '@/lib/mcp/tools/writeBulkPurchaseOrders';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
const MANAGER = { user: '', companyRole: 'manager' };

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-maint-import');
  MANAGER.user = f.manager;
}, 60_000);
afterEach(async () => {
  await pool.query("UPDATE purchase_orders SET status = 'cancelled' WHERE company_id = $1 AND status = 'approved'", [f.co]);
});
afterAll(async () => {
  try { await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

let n = 100;
const opexPo = (status: string, price: number, ref?: string): Json => sagePo(++n, f, { status, acct: f.acc.opex, cc1: f.cc.FT, price, ...(ref ? { ref } : {}) });
const committed = async () => (await asOwner(pool, f, () => readCommitments(f.co, [f.acc.opex], '2026-06-01', '2026-06-30', {}))).map((c) => c.lineTotal);
type Check = { outcome: string; reasons: string[]; skipped: boolean; would_have_failed: boolean; policy: string };
const checks = (r: { body: Json }) => (r.body.purchase_orders as Array<{ budget_check?: Check }>).map((p) => p.budget_check);

describe('dry_run reports the budget decision per PO', () => {
  it('under block: ok for the first, block (with reasons) for the one that tips the slice; would_succeed false; nothing written', async () => {
    await setPolicy(pool, f, 'block');
    const before = { pos: await poCount(pool, f), counter: await counterNext(pool, f), gl: await glCount(pool, f) };
    const r = await callTool(pool, f, create, { purchase_orders: [opexPo('open', 150), opexPo('open', 400), opexPo('draft', 5000)], dry_run: true });
    expect(r.isError, r.text).toBe(false);
    const [a, b, c] = checks(r);
    expect(a).toMatchObject({ outcome: 'ok', policy: 'block', reasons: [], skipped: false, would_have_failed: false });
    expect(b).toMatchObject({ outcome: 'block', would_have_failed: true, skipped: false });
    expect(b!.reasons[0]).toContain('Over budget');
    expect(c).toBeUndefined();
    expect(r.body).toMatchObject({ dry_run: true, would_succeed: false, would_create: 3 });
    expect((r.body.budget_blocked as Array<{ index: number }>).map((x) => x.index)).toEqual([1]);
    expect(r).toMatchObject({ wroteNothing: true });
    expect({ pos: await poCount(pool, f), counter: await counterNext(pool, f), gl: await glCount(pool, f) }).toEqual(before);
    expect(await committed()).toEqual([]);
  });

  it('a PO reported as block does not count as committed for the POs after it (they are judged as the live call would judge them without it)', async () => {
    await setPolicy(pool, f, 'block');
    const r = await callTool(pool, f, create, { purchase_orders: [opexPo('open', 150), opexPo('open', 700), opexPo('open', 100)], dry_run: true });
    expect(checks(r).map((c) => c!.outcome)).toEqual(['ok', 'block', 'ok']); // 300 + 200 fits; with the blocked 1 400 counted it would not
    const without = await callTool(pool, f, create, { purchase_orders: [opexPo('open', 150), opexPo('open', 100)], dry_run: true });
    expect(checks(without).map((c) => c!.outcome)).toEqual(['ok', 'ok']);
    // With the skip flag the over-budget PO IS created, so it does count for the ones after it.
    const skipped = await callTool(pool, f, create, { purchase_orders: [opexPo('open', 150), opexPo('open', 700), opexPo('open', 100)], dry_run: true, skip_budget_check_for_import: true });
    expect(checks(skipped).map((c) => c!.outcome)).toEqual(['ok', 'block', 'block']);
  });

  it('the live call without the flag refuses the same batch whole; the batch without the second PO passes and matches the dry run', async () => {
    await setPolicy(pool, f, 'block');
    const batch = [opexPo('open', 150), opexPo('open', 400)];
    const live = await callTool(pool, f, create, { purchase_orders: batch });
    expect(live.text).toMatch(/^budget_exceeded: /);
    expect(await poCount(pool, f)).toBe(0);
    const ok = [opexPo('open', 150)];
    const dry = await callTool(pool, f, create, { purchase_orders: ok, dry_run: true });
    const real = await callTool(pool, f, create, { purchase_orders: ok });
    expect(real.isError, real.text).toBe(false);
    expect(checks(dry)[0]).toEqual(checks(real)[0]);
    expect(dry.body).toMatchObject({ would_succeed: true });
  });

  it('under warn: outcome warn with the warning as its reason; would_succeed true', async () => {
    await setPolicy(pool, f, 'warn');
    const r = await callTool(pool, f, create, { purchase_orders: [opexPo('open', 700)], dry_run: true });
    expect(checks(r)[0]).toMatchObject({ outcome: 'warn', policy: 'warn', would_have_failed: false });
    expect(checks(r)[0]!.reasons[0]).toContain('Over budget');
    expect(r.body).toMatchObject({ would_succeed: true });
  });

  it('carries each PO\'s own dimension_warnings', async () => {
    await setPolicy(pool, f, 'warn');
    await pool.query("UPDATE gl_accounts SET account_subtype = 'cost_of_sales' WHERE id = $1", [f.acc.travel]);
    const cos = sagePo(++n, f, { status: 'draft', acct: f.acc.travel });
    const plain = opexPo('draft', 10);
    const r = await callTool(pool, f, create, { purchase_orders: [cos, plain], dry_run: true });
    expect(r.isError, r.text).toBe(false);
    const [a, b] = r.body.purchase_orders as Array<{ dimension_warnings?: string[] }>;
    expect(a!.dimension_warnings?.[0]).toContain('cost-of-sales line with no project');
    expect(b!.dimension_warnings).toBeUndefined();
    expect(r.body.dimension_warnings).toHaveLength(1);
    await pool.query("UPDATE gl_accounts SET account_subtype = NULL WHERE id = $1", [f.acc.travel]);
  });
});

describe('skip_budget_check_for_import', () => {
  it('a manager is refused before anything is read, in a dry run and live, even with a malformed batch', async () => {
    const base = await poCount(pool, f);
    for (const args of [{ purchase_orders: [opexPo('open', 10)] }, { purchase_orders: [opexPo('open', 10)], dry_run: true }, { purchase_orders: [] }]) {
      const r = await callTool(pool, f, create, { skip_budget_check_for_import: true, ...args }, MANAGER);
      expect(r).toMatchObject({ isError: true });
      expect(r.text).toContain('only an owner or admin may do');
    }
    expect(await poCount(pool, f)).toBe(base);
    expect((await callTool(pool, f, create, { skip_budget_check_for_import: 'yes', purchase_orders: [opexPo('open', 10)] })).text).toContain('must be true or false');
  });

  it('under block it lets the over-budget open PO through and says it would have failed, live and dry run, with an audit row each', async () => {
    await setPolicy(pool, f, 'block');
    const batch = [opexPo('open', 150, 'skip-a'), opexPo('open', 400, 'skip-b'), opexPo('draft', 50, 'skip-c')];
    const base = await poCount(pool, f);
    const dry = await callTool(pool, f, create, { purchase_orders: batch, skip_budget_check_for_import: true, dry_run: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body).toMatchObject({ would_succeed: true, skip_budget_check_for_import: true });
    expect((dry.body.would_have_failed as Array<{ index: number; reasons: string[] }>).map((x) => x.index)).toEqual([1]);
    expect(dry).toMatchObject({ wroteNothing: true });
    expect(await poCount(pool, f)).toBe(base);

    const live = await callTool(pool, f, create, { purchase_orders: batch, skip_budget_check_for_import: true });
    expect(live.isError, live.text).toBe(false);
    expect(live.body).toMatchObject({ created: 3, skip_budget_check_for_import: true });
    const failed = live.body.would_have_failed as Array<{ index: number; po_number: string; reasons: string[] }>;
    expect(failed.map((x) => x.index)).toEqual([1]);
    expect(failed[0]!.reasons[0]).toContain('Over budget');
    const pos = live.body.purchase_orders as Array<{ id: string; po_number: string; budget_check?: Check }>;
    expect(pos.map((p) => p.budget_check && [p.budget_check.skipped, p.budget_check.would_have_failed])).toEqual([[true, false], [true, true], undefined]);
    expect((await committed()).sort((a, b) => a - b)).toEqual([300, 800]);

    const [a, b, c] = await Promise.all(pos.map((p) => auditOf(pool, f, p.id)));
    expect(a![0]!.changes.metadata).toMatchObject({ budgetCheckSkipped: 'true', wouldHaveFailed: 'false' });
    expect(b![0]!.changes.metadata).toMatchObject({ budgetCheckSkipped: 'true', wouldHaveFailed: 'true' });
    expect(b![0]!.changes.metadata!.budgetReasons).toContain('Over budget');
    expect(c![0]!.changes.metadata).not.toHaveProperty('budgetCheckSkipped');
    expect(b).toHaveLength(1);
    expect(await budgetEvents(pool, pos[1]!.id)).toEqual([]);
  });

  it('without a block to skip it changes nothing: would_have_failed is empty, the audit row still says the check was skipped', async () => {
    await setPolicy(pool, f, 'block');
    const r = await callTool(pool, f, create, { purchase_orders: [opexPo('open', 100)], skip_budget_check_for_import: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.would_have_failed).toEqual([]);
    const id = (r.body.purchase_orders as Array<{ id: string }>)[0]!.id;
    expect((await auditOf(pool, f, id))[0]!.changes.metadata).toMatchObject({ budgetCheckSkipped: 'true', wouldHaveFailed: 'false' });
  });
});
