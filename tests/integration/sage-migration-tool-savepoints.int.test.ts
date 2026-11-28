/**
 * Round-12 review R6: "failed, nothing written" for a batch the tool REFUSED rests on the tool undoing its own partial write. The registry
 * rolls its savepoint back only on a throw; a refusal is a returned isError, and the request then COMMITs (the refusal's audit row is
 * written). So each migration tool that can refuse AFTER it has written must undo that write itself. Pinned here, through the migration's
 * own tool session, a request that COMMITs:
 *   - bulk_create_purchase_orders: PO 1 is created, PO 2 is over budget under `block`: the tool refuses, PO 1 is not in the books;
 *   - bulk_upsert_items: row 1 is written, row 2's code is taken by another writer while the batch runs (a unique violation): the tool
 *     refuses, row 1 is not in the books.
 * (upsert_item_category refuses only before it writes; a throw after is the registry's savepoint.)
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { cleanupWorld } from './helpers/itemsWorld';
import { cleanupSageWorld, n, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';
import { planMigration } from '@/modules/accounting/services/sage-migration/sageMigrationPlan';
import { readSnapshot } from '@/modules/accounting/services/sage-migration/sageSnapshot';
import { resolveSuppliers } from '@/modules/accounting/services/sage-migration/sageSuppliers';
import { withToolSession } from '@/modules/accounting/services/sage-migration/sageToolSession';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let f: BillFixture;
let s: SageWorld;
beforeAll(async () => { f = await seedBillFixture(pool, 'sage-r6'); await setPolicy(pool, f, 'block'); s = await sageWorld(pool); }, 120_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)', [f.co]);
    for (const t of ['purchase_orders', 'mcp_tool_calls', 'company_document_numbers', 'budget_check_events', 'budget_control_settings']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [f.co]);
    await pool.query("DELETE FROM audit_log WHERE company_id = $1 AND entity_type <> 'budget'", [f.co]);
    await dropBillFixture(pool, f);
    await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w);
  } finally { await pool.end(); }
}, 120_000);

const rejected = (co: string, tool: string) => n(pool, `SELECT count(*) AS n FROM mcp_tool_calls WHERE company_id = $1 AND tool = $2 AND status = 'rejected'`, [co, tool]);

describe('bulk_create_purchase_orders refuses after it wrote PO 1', () => {
  it('the request COMMITs (its refusal is audited), and PO 1 is not in the books', async () => {
    // Travel is budgeted 500 a month under block: PO 1 (200) fits, PO 2 (400) then does not.
    const po = (i: number, net: number, tax: number) => ({ ID: 810000 + i, DocumentNumber: `PO-R6-${i}`, Date: '2026-06-10', Status: 'Pending', SupplierId: 301, SupplierName: 'P5-2 Supplies',
      Exclusive: net, Tax: tax, Total: net + tax, Lines: [{ Description: 'Travel', Quantity: 1, UnitPriceExclusive: net, TaxTypeId: 1, Exclusive: net, Tax: tax }] });
    const parsed = parseSageExport({ PurchaseOrders: [po(1, 200, 30), po(2, 400, 60)] });
    const answer = await withToolSession(pool, f.co, f.owner, true, async (session) => {
      const snapshot = await readSnapshot(f.co);
      const plan = planMigration(parsed, await resolveSuppliers(session, parsed.purchaseOrders, snapshot.supplierSageRefs), snapshot, { poGlAccountId: f.acc.travel });
      expect(plan.refusals).toEqual([]);
      expect(plan.purchaseOrders).toHaveLength(2);
      return session.call('bulk_create_purchase_orders', { purchase_orders: plan.purchaseOrders.map((p) => p.element), idempotency_key: 'r6-po-partial' });
    });
    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/budget_exceeded: .*Nothing was created/);
    // The refusal needs PO 1 IN the books: PO 2 alone (400) fits the 500 budget. So PO 1 was written in the tool's savepoint first.
    const alone = await withToolSession(pool, f.co, f.owner, false, async (session) => {
      const snapshot = await readSnapshot(f.co);
      const one = parseSageExport({ PurchaseOrders: [po(2, 400, 60)] });
      const plan = planMigration(one, await resolveSuppliers(session, one.purchaseOrders, snapshot.supplierSageRefs), snapshot, { poGlAccountId: f.acc.travel });
      return session.call('bulk_create_purchase_orders', { purchase_orders: plan.purchaseOrders.map((p) => p.element), idempotency_key: 'r6-po-alone' });
    });
    expect(alone.isError).toBe(false);
    expect(await rejected(f.co, 'bulk_create_purchase_orders')).toBe(1); // the request committed
    expect(await n(pool, `SELECT count(*) AS n FROM purchase_orders WHERE company_id = $1`, [f.co])).toBe(0);
  });
});

describe('bulk_upsert_items refuses after it wrote row 1', () => {
  it('the request COMMITs (its refusal is audited), and row 1 is not in the books', async () => {
    const rows = [1, 2].map((i) => ({ code: `R6-ITEM-${i}`, description: `R6 item ${i}`, item_type: 'service', inventory_tracked: false, is_active: true, external_system: 'sage', external_ref: String(820000 + i) }));
    // Another writer holds an uncommitted item with row 2's code: the batch writes row 1, then waits on row 2's unique index.
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query(`INSERT INTO items (company_id, code, description, item_type) VALUES ($1, 'R6-ITEM-2', 'the other writer', 'service')`, [s.companyId]);
      const call = withToolSession(pool, s.companyId, s.userId, true, (session) => session.call('bulk_upsert_items', { items: rows, idempotency_key: 'r6-items-partial' }));
      const waiting = async () => n(pool, `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO items%' AND pid <> $1`, [(await other.query('SELECT pg_backend_pid() AS p')).rows[0].p]);
      for (let i = 0; i < 100 && (await waiting()) === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(await waiting()).toBe(1); // row 1 is written and row 2's insert waits on the other writer
      await other.query('COMMIT');
      const answer = await call;
      expect(answer.isError).toBe(true);
      expect(answer.text).toMatch(/code_in_use/);
    } finally { other.release(); }
    expect(await rejected(s.companyId, 'bulk_upsert_items')).toBe(1); // the request committed
    expect(await n(pool, `SELECT count(*) AS n FROM items WHERE company_id = $1 AND code = 'R6-ITEM-1'`, [s.companyId])).toBe(0);
  });
});
