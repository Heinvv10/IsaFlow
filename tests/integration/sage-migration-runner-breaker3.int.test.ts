/**
 * Breaker round 3, ported (b1-whitespace-code, b3-replay), on a real database:
 *   - B1a/B1b: an owned item that is not sent this run is linked on a PO line BY ITEM ID, never by its stored code: the code can carry
 *     whitespace the PO tool trims, and the trimmed code can belong to a foreign (non-Sage) item, or to nothing (which would fail the
 *     WHOLE PO batch);
 *   - B3: after the person changed an owned item in IsaFlow, a re-run does what its dry run said: the item batch is not replayed from
 *     the first run's stored answer (its key follows the state of the owned rows it touches), the item is put back, the lines link;
 *   - B4: the linked-lines count is the books', not the plan's.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { booked, cleanupSageWorld, exportFile, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

type Row = Record<string, unknown>;
const run = (over: Record<string, unknown> = {}, file = exportFile()) =>
  runSageMigration(pool, parsedExport(file), { companyId: s.companyId, userId: s.userId, live: true, allowRefusals: true, allowDifferences: true, ...over });
const rowsOf = (file: Record<string, unknown>) => (file.Items as { $resources: Row[] }).$resources;
const posOf = (file: Record<string, unknown>) => file.PurchaseOrders as Row[];
const lines = async (po: string) => (await pool.query(
  `SELECT p.description, p.item_id::TEXT AS item_id FROM po_items p JOIN purchase_orders o ON o.id = p.purchase_order_id
    WHERE o.company_id = $1 AND o.po_number = $2 ORDER BY p.sort_order`, [s.companyId, po])).rows as Array<{ description: string; item_id: string | null }>;

/** Items only imported; then the owned FIB-0001 gets the trailing space PUT /api/accounting/items stores (the app does not trim on update). */
async function importItemsThenPad(): Promise<string> {
  const f = exportFile();
  f.PurchaseOrders = [];
  expect((await run({}, f)).status).toBe('completed');
  const owned = String((await pool.query(`SELECT id FROM items WHERE company_id = $1 AND external_system = 'sage' AND external_ref = '50001'`, [s.companyId])).rows[0].id);
  await pool.query(`UPDATE items SET code = 'FIB-0001 ' WHERE id = $1`, [owned]);
  return owned;
}

describe('B1: an owned item stored with whitespace in its code', () => {
  it('B1a: with a FOREIGN item holding the trimmed code, the lines link to the owned item by id, never to the foreign one', async () => {
    const owned = await importItemsThenPad();
    const foreign = String((await pool.query(
      `INSERT INTO items (company_id, code, description, item_type, is_active) VALUES ($1, 'FIB-0001', 'Someone elses item', 'service', true) RETURNING id`, [s.companyId])).rows[0].id);
    const r = await run();
    expect(r.refused.find((x) => x.sageId === '50001')).toMatchObject({ code: 'ref_code_conflict' }); // the Sage row cannot be sent
    for (const po of ['PO0000197', 'PO0000202']) {
      const first = (await lines(po))[0]!;
      expect(first.item_id, po).toBe(owned);
      expect(first.item_id, po).not.toBe(foreign);
    }
    expect(r.status).toBe('completed');
    expect(r.lineLinks).toMatchObject({ basis: 'booked' });
    expect((await pool.query('SELECT count(*)::INT AS n FROM po_items WHERE item_id = $1', [foreign])).rows[0].n).toBe(0);
  });

  it('B1b: with no foreign item and 50001 refused this run, the PO phase is NOT lost: every PO is booked and the owned item is linked by id', async () => {
    const owned = await importItemsThenPad();
    const f = exportFile();
    rowsOf(f)[0] = { ...rowsOf(f)[0], TaxTypeIdSales: 9 }; // 50001 is refused this run
    const r = await run({}, f);
    expect(r.dryRun.clean).toBe(true);
    expect(r.status).toBe('completed');
    expect(await booked(pool, s.companyId)).toMatchObject({ pos: 10 });
    expect((await lines('PO0000197'))[0]!.item_id).toBe(owned);
  });
});

describe('B3: a re-run does what its dry run said after an owned item was changed in IsaFlow', () => {
  const firstRunWithoutPo206 = async () => {
    const first = exportFile();
    first.PurchaseOrders = posOf(first).filter((p) => p.DocumentNumber !== 'PO0000206'); // PO 206 arrives in a later export
    expect((await run({}, first)).status).toBe('completed');
  };
  const deactivate = () => pool.query(`UPDATE items SET is_active = false WHERE company_id = $1 AND external_system = 'sage' AND external_ref = '50001'`, [s.companyId]);

  it('the item is put back, PO0000206 is booked with its lines linked, the run completes, and the change is in differences.items', async () => {
    await firstRunWithoutPo206();
    await deactivate();
    const r = await run();
    expect(r.dryRun.clean).toBe(true);
    expect(r.status).toBe('completed');
    expect(r.live!.items.batches.every((b) => b.status === 'ok')).toBe(true);
    expect((await pool.query(`SELECT is_active FROM items WHERE company_id = $1 AND external_ref = '50001'`, [s.companyId])).rows[0].is_active).toBe(true);
    expect((await lines('PO0000206')).length).toBeGreaterThan(0);
    expect(r.differences.items).toEqual([{ code: 'FIB-0001', changed: ['is_active'] }]); // not a silent []
  });

  it('without --allow-differences the dry run names the item change and live is blocked, nothing written', async () => {
    await firstRunWithoutPo206();
    await deactivate();
    const r = await run({ allowDifferences: false, allowRefusals: false });
    expect(r.status).toBe('live_blocked');
    expect(r.differences.items).toEqual([{ code: 'FIB-0001', changed: ['is_active'] }]);
    expect((await pool.query(`SELECT is_active FROM items WHERE company_id = $1 AND external_ref = '50001'`, [s.companyId])).rows[0].is_active).toBe(false);
    expect((await lines('PO0000206')).length).toBe(0);
  });

  it('a re-run when nothing changed in IsaFlow is still a no-op that touches no row', async () => {
    await run();
    const stamp = async () => (await pool.query(`SELECT string_agg(id::TEXT || xmin::TEXT, ',' ORDER BY id) AS s FROM items WHERE company_id = $1`, [s.companyId])).rows[0].s;
    const before = await stamp();
    const r = await run();
    expect(r.status).toBe('completed');
    expect(r.differences.items).toEqual([]);
    expect(await stamp()).toBe(before);
  });
});

describe('B4: the linked-lines count is the books\', not the plan\'s', () => {
  it('a PO already there (never changed) is not counted: linked equals the linked lines of the POs THIS run created, here none', async () => {
    const inactive = exportFile();
    rowsOf(inactive)[0] = { ...rowsOf(inactive)[0], Active: false };
    await run({}, inactive);
    const r = await run();
    const created = Number((await pool.query(
      `SELECT count(*)::INT AS n FROM po_items p JOIN purchase_orders o ON o.id = p.purchase_order_id
        WHERE o.company_id = $1 AND p.item_id IS NOT NULL AND o.po_number <> ALL($2::TEXT[])`, [s.companyId, r.lineLinks.alreadyThere])).rows[0].n);
    expect(created).toBe(0);
    expect(r.lineLinks).toMatchObject({ linked: created, basis: 'booked' });
    expect(r.lineLinks.alreadyThere).toHaveLength(10); // the 3 lines run 1 linked are theirs, not this run's
  });
});
