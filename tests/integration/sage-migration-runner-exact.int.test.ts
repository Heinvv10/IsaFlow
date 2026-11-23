/**
 * What the item and category tools compare exactly, and what an owned item with stock may not become, on a real database:
 *   - #10: external_system is compared exactly (case-sensitive "sage") for items and categories;
 *   - #11: an owned item with stock movements keeps its type and tracking.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { booked, cleanupSageWorld, exportFile, failingCommitPool, parsedExport, sageWorld, stamps, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { exitCodeFor, summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let s: SageWorld;

beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

const run = (over: Record<string, unknown> = {}, file = exportFile(), p: Pool = pool) =>
  runSageMigration(p, parsedExport(file), { companyId: s.companyId, userId: s.userId, live: true, liveWithoutCounts: true, allowRefusals: true, allowDifferences: true, ...over });
type Row = Record<string, unknown>;
const rowsOf = (file: Record<string, unknown>) => (file.Items as { $resources: Row[] }).$resources;
const posOf = (file: Record<string, unknown>) => file.PurchaseOrders as Row[];

describe('#10: external_system is compared exactly as the item and category tools do (case-sensitive "sage")', () => {
  it('B1d: an item stored with external_system "Sage" is not owned: its row is refused per row, the dry run stays clean', async () => {
    await pool.query(`INSERT INTO items (company_id, code, description, item_type, external_system, external_ref) VALUES ($1, 'FIB-0001', 'x', 'physical', 'Sage', '50001')`, [s.companyId]);
    const dry = await run({ live: false });
    expect(dry.status).toBe('dry_run_ok');
    const r = await run();
    expect(r.status).toBe('completed');
    expect(r.refused.filter((x) => x.entity === 'item').map((x) => [x.label, x.code])).toEqual([['FIB-0001', 'code_held_by_existing_item']]);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 10 }); // 19 + the one that was there; the POs naming FIB-0001 go with that line unlinked
  });
  it('B1c: a category stored with external_system "Sage" is not owned: refused category_name_in_use, its items category_refused, dry run clean', async () => {
    await pool.query(`INSERT INTO item_categories (company_id, name, external_system, external_ref) VALUES ($1, 'Optics', 'Sage', '10')`, [s.companyId]);
    const dry = await run({ live: false });
    expect(dry.status).toBe('dry_run_ok');
    const r = await run();
    expect(r.refused.find((x) => x.entity === 'category')).toMatchObject({ label: 'Optics', code: 'category_name_in_use' });
    expect(r.refused.filter((x) => x.entity === 'item').every((x) => x.code === 'category_refused')).toBe(true);
  });
  it('an item stored with exactly "sage" is the migration\'s own (updated, not refused)', async () => {
    await pool.query(`INSERT INTO items (company_id, code, description, item_type, external_system, external_ref) VALUES ($1, 'FIB-0001', 'x', 'physical', 'sage', '50001')`, [s.companyId]);
    const r = await run();
    expect(r.refused).toEqual([]);
  });
});

describe('#11: an owned item with stock movements keeps its type and tracking', () => {
  it('a tracked owned item with movements: the Sage row is refused per row, nothing is changed', async () => {
    const item = String((await pool.query(
      `INSERT INTO items (company_id, code, description, item_type, inventory_tracked, external_system, external_ref)
       VALUES ($1, 'FIB-0001', 'x', 'physical', true, 'sage', '50001') RETURNING id`, [s.companyId])).rows[0].id);
    const product = String((await pool.query(`INSERT INTO products (company_id, code, name) VALUES ($1, 'P-1', 'P') RETURNING id`, [s.companyId])).rows[0].id);
    await pool.query(`INSERT INTO stock_movements (company_id, product_id, item_id, movement_type, quantity) VALUES ($1, $2, $3, 'purchase', 5)`, [s.companyId, product, item]);
    const dry = await run({ live: false });
    expect(dry.status).toBe('dry_run_ok');
    const r = await run();
    expect(r.refused.filter((x) => x.entity === 'item')).toEqual([expect.objectContaining({ label: 'FIB-0001', code: 'item_has_stock_movements' })]);
    expect((await pool.query('SELECT inventory_tracked, item_type FROM items WHERE id = $1', [item])).rows[0]).toEqual({ inventory_tracked: true, item_type: 'physical' });
    await pool.query('DELETE FROM stock_movements WHERE company_id = $1', [s.companyId]);
    await pool.query('DELETE FROM products WHERE company_id = $1', [s.companyId]);
  });
});
