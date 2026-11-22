/**
 * Sage migration runner and the PO budget check, against a real database (the budget fixture: travel BB-6200 is budgeted 500 a
 * month, policy block). Four POs of 200 net, poBatchSize 2: each batch is under the budget alone, together they are over it.
 *   - the DRY RUN is cumulative: its PO batches run LIVE inside its one rolled-back transaction, so batch 2 sees batch 1's approved
 *     POs as the live run will, and the dry run fails (a dry_run batch rolls itself back and would pass);
 *   - a failed dry run writes nothing, even with live asked: no PO, no audit row, no idempotency row, no number counter;
 *   - what the dry run did leaves nothing behind: the live run that follows creates every PO under keys of its own;
 *   - with skip_budget_check_for_import the run completes and the report lists the POs that would have failed.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { n } from './helpers/sageMigrationWorld';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { exitCodeFor, summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;

let base: Awaited<ReturnType<typeof left>>;
beforeAll(async () => {
  f = await seedBillFixture(pool, 'sage-budget');
  base = await left(); // the fixture's own rows (its budget version's approval is an audit row)
}, 120_000);
afterAll(async () => { try { await dropBillFixture(pool, f); } finally { await pool.end(); } }, 120_000);
const afterEachClean = async () => {
  for (const t of ['po_items', 'purchase_orders']) {
    await pool.query(t === 'po_items'
      ? 'DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)'
      : 'DELETE FROM purchase_orders WHERE company_id = $1', [f.co]);
  }
  for (const t of ['mcp_tool_calls', 'company_document_numbers', 'budget_check_events']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [f.co]);
  await pool.query("DELETE FROM audit_log WHERE company_id = $1 AND entity_type <> 'budget'", [f.co]);
};
afterEach(afterEachClean);

const po = (i: number) => ({
  ID: 800000 + i, DocumentNumber: `PO${String(9000 + i).padStart(7, '0')}`, Date: '2026-06-10', Status: 'Pending', SupplierId: 301,
  SupplierName: 'P5-2 Supplies', Exclusive: 200, Tax: 30, Total: 230,
  Lines: [{ Description: 'Travel', Quantity: 1, UnitPriceExclusive: 200, TaxTypeId: 1, Exclusive: 200, Tax: 30 }],
});
const exportFile = () => parseSageExport({ PurchaseOrders: [1, 2, 3, 4].map(po) });
const run = (over: Record<string, unknown> = {}) => runSageMigration(pool, exportFile(), {
  companyId: f.co, userId: f.owner, poBatchSize: 2, poGlAccountId: f.acc.travel, ...over,
});
const left = async () => ({
  pos: await n(pool, 'SELECT count(*) AS n FROM purchase_orders WHERE company_id = $1', [f.co]),
  calls: await n(pool, 'SELECT count(*) AS n FROM mcp_tool_calls WHERE company_id = $1', [f.co]),
  audit: await n(pool, 'SELECT count(*) AS n FROM audit_log WHERE company_id = $1', [f.co]),
  counters: await n(pool, `SELECT count(*) AS n FROM company_document_numbers WHERE company_id = $1 AND document_type = 'purchase_order'`, [f.co]),
});

describe('M1: the block policy and POs with no GL account', () => {
  const bare = () => ({ companyId: f.co, userId: f.owner, poBatchSize: 2 }); // no poGlAccountId: the lines have no account

  it('each open PO is refused per row BEFORE any batch: the dry run is clean, nothing is written, the reason names the remedies', async () => {
    await setPolicy(pool, f, 'block');
    const r = await runSageMigration(pool, exportFile(), { ...bare(), live: true });
    expect(r.status).toBe('completed');
    expect(r.refused.map((x) => [x.label, x.code])).toEqual([1, 2, 3, 4].map((i) => [`PO000900${i}`, 'accountless_under_block_policy']));
    expect(r.refused[0]!.reasons[0]).toMatch(/--skip-budget-check.*--po-gl-account/);
    expect(r.dryRun.purchaseOrders.batches).toEqual([]);
    expect(await left()).toEqual(base);
    expect(exitCodeFor(r, false)).toBe(1);
  });
  it('under warn the same POs go in without an account; with the check skipped they go in under block', async () => {
    await setPolicy(pool, f, 'warn');
    expect((await runSageMigration(pool, exportFile(), { ...bare(), live: true })).refused).toEqual([]);
    expect((await left()).pos).toBe(4);
    await afterEachClean();
    await setPolicy(pool, f, 'block');
    const r = await runSageMigration(pool, exportFile(), { ...bare(), live: true, skipBudgetCheck: true });
    expect(r.refused).toEqual([]);
    expect((await left()).pos).toBe(4);
  });
});

describe('a budget that two PO batches overrun together', () => {
  it('the dry run fails on batch 2 (it sees batch 1), so a --live run writes nothing at all', async () => {
    await setPolicy(pool, f, 'block');
    const r = await run({ live: true });
    expect(r.status).toBe('dry_run_failed');
    expect(r.live).toBeNull();
    expect(r.dryRun.purchaseOrders.batches.map((b) => b.status)).toEqual(['ok', 'failed']);
    expect(r.dryRun.purchaseOrders.batches[1]!.error).toMatch(/budget_exceeded/);
    expect(await left()).toEqual(base);
  });

  it('the same two batches under a budget they fit in: the dry run is clean and nothing of it is left', async () => {
    await setPolicy(pool, f, 'off');
    const dry = await run();
    expect(dry.status).toBe('dry_run_ok');
    expect(dry.dryRun.purchaseOrders.batches.map((b) => b.toolReported?.created)).toEqual([2, 2]);
    expect(await left()).toEqual(base);
  });

  it('a live run after a dry run creates every PO: nothing of the dry run is replayed', async () => {
    await setPolicy(pool, f, 'off');
    await run();
    const live = await run({ live: true });
    expect(live.status).toBe('completed');
    expect(live.live!.purchaseOrders.batches.map((b) => b.toolReported?.created)).toEqual([2, 2]);
    expect(live.live!.purchaseOrders.batches.every((b) => !b.key.endsWith('-dry'))).toBe(true);
    expect((await left()).pos).toBe(4);
    expect((await left()).counters).toBe(base.counters + 1);
  });

  it('with skip_budget_check_for_import the run completes and the report names the POs that would have failed', async () => {
    await setPolicy(pool, f, 'block');
    const r = await run({ live: true, skipBudgetCheck: true });
    expect(r.status).toBe('completed');
    expect((await left()).pos).toBe(4);
    expect(r.budgetWouldHaveFailed.length).toBeGreaterThan(0);
    expect(r.budgetWouldHaveFailed.every((x) => /^PO000900\d$/.test(x.poNumber) && x.reasons.length > 0)).toBe(true);
    const text = summaryLines(r).join('\n');
    expect(text).toContain('would have failed the budget check');
    expect(text).toContain(r.budgetWouldHaveFailed[0]!.poNumber);
  });

  it('without the skip, a run whose POs all fit reports no budget exception', async () => {
    await setPolicy(pool, f, 'off');
    const r = await run({ live: true });
    expect(r.budgetWouldHaveFailed).toEqual([]);
    expect(summaryLines(r).join('\n')).not.toContain('would have failed the budget check');
  });
});
