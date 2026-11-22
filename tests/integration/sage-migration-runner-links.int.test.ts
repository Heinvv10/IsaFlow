/**
 * PO lines and their items (#1740: item_code on a line of bulk_create_purchase_orders), on a real database: a line whose item is
 * inactive or refused goes without item_code, keeps the suffix, is counted, and cannot cost its batch; a re-run names new links as
 * differences. Linked lines having po_items.item_id set is in sage-migration-runner.int.test.ts.
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
  runSageMigration(p, parsedExport(file), { companyId: s.companyId, userId: s.userId, live: true, allowRefusals: true, allowDifferences: true, ...over });
type Row = Record<string, unknown>;
const rowsOf = (file: Record<string, unknown>) => (file.Items as { $resources: Row[] }).$resources;
const posOf = (file: Record<string, unknown>) => file.PurchaseOrders as Row[];

describe('item links (#1740): a line the plan is not sure of goes without item_code and cannot cost its batch', () => {
  const lineRows = async (po: string) => (await pool.query(
    `SELECT p.description, i.code AS item_code FROM po_items p JOIN purchase_orders o ON o.id = p.purchase_order_id LEFT JOIN items i ON i.id = p.item_id
      WHERE o.company_id = $1 AND o.po_number = $2 ORDER BY p.sort_order`, [s.companyId, po])).rows as Array<{ description: string; item_code: string | null }>;

  it('an inactive item and a refused item on lines of a 10-PO batch: every PO is booked, those lines unlinked with the suffix, the others linked', async () => {
    const file = exportFile();
    rowsOf(file)[0] = { ...rowsOf(file)[0], Active: false }; // 50001 imports inactive
    rowsOf(file)[4] = { ...rowsOf(file)[4], TaxTypeIdSales: 9 }; // 50005 is refused
    const po3 = posOf(file)[2]!; // PO0000199: its first line names an ACTIVE item (50002), in the same batch as the unlinked ones
    posOf(file)[2] = { ...po3, Lines: [{ ...(po3.Lines as Row[])[0], ItemId: 50002 }, ...(po3.Lines as Row[]).slice(1)] };
    const r = await run({ poBatchSize: 100 }, file);
    expect(r.status).toBe('completed');
    expect(await booked(pool, s.companyId)).toMatchObject({ pos: 10 });
    expect(r.live!.purchaseOrders.batches).toHaveLength(1);
    expect(r.live!.purchaseOrders.batches[0]!.status).toBe('ok');
    expect(await lineRows('PO0000197')).toEqual([
      { description: 'Fibre cable drum (PO 197) [item FIB-0001]', item_code: null }, // inactive
      { description: 'Delivery charge', item_code: null },
      { description: 'Installation visit [item SVC-005]', item_code: null }, // refused
    ]);
    expect((await lineRows('PO0000199'))[0]).toEqual({ description: 'Fibre cable drum (PO 199)', item_code: 'FIB-0002' }); // linked, same batch
    expect(r.lineLinks.linked).toBe(1);
    expect(r.lineLinks.notLinked.map((x) => [x.poNumber, x.itemCode, x.reason]).sort()).toEqual([
      ['PO0000197', 'FIB-0001', 'inactive'], ['PO0000197', 'SVC-005', 'refused'], ['PO0000201', 'SVC-005', 'refused'],
      ['PO0000202', 'FIB-0001', 'inactive'], ['PO0000205', 'SVC-005', 'refused'],
    ]);
    expect(summaryLines(r).join('\n')).toMatch(/line not linked: item inactive: PO0000197 line 1 \(FIB-0001\)/);
  });

  it('a re-run once the item is active names the new links as differences (lines[0].item_id), changes nothing, and blocks live unless allowed', async () => {
    const inactive = exportFile();
    rowsOf(inactive)[0] = { ...rowsOf(inactive)[0], Active: false };
    await run({}, inactive);
    expect((await lineRows('PO0000197'))[0]!.item_code).toBeNull();
    const r = await run({ allowDifferences: false }, exportFile());
    expect(r.status).toBe('live_blocked');
    const d = r.differences.purchaseOrders.find((x) => x.poNumber === 'PO0000197')!;
    expect(d.differences).toEqual([expect.objectContaining({ field: 'lines[0].item_id', existing: null })]);
    expect((await lineRows('PO0000197'))[0]!.item_code).toBeNull(); // a PO found already there is never changed
    expect(r.differences.items).toEqual([{ code: 'FIB-0001', changed: ['is_active'] }]);
  });
});
