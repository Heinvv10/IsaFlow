/**
 * Round-8 breaker findings on a real database (the breaker's repros b8-a/b/c/f, ported):
 *   - A: a Sage item CODE rename does not report a moved item link on the POs naming it (the stored link is looked up by Sage reference);
 *   - B: coding a PO line in IsaFlow (account, cost centre) does not block the re-run;
 *   - C: a stop after an item batch that overwrote an IsaFlow edit does not say "nothing new written";
 *   - F: a line of LineType 1 (an account line) whose SelectionId equals an item id is refused, never linked to that item; LineType is optional.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { afterCommitOf, cleanupSageWorld, exportFile, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { exitCodeFor } from '@/modules/accounting/services/sage-migration/sageReportSummary';
import { stopMessage } from '@/modules/accounting/services/sage-migration/sageStopMessage';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => {
  await cleanupSageWorld(pool, s);
  await pool.query('DELETE FROM cost_centres WHERE company_id = $1', [s.companyId]);
  await pool.query(`DELETE FROM gl_accounts WHERE company_id = $1 AND account_code LIKE 'B8%'`, [s.companyId]);
  await cleanupWorld(pool, s.w);
}, 120_000);

type Row = Record<string, unknown>;
const items = (f: Row) => (f.Items as { $resources: Row[] }).$resources;
const opts = (over: Record<string, unknown> = {}) => ({ companyId: s.companyId, userId: s.userId, live: true, allowRefusals: true, allowDifferences: true, expect: {}, ...over });
const run = (f: Row = exportFile(), over: Record<string, unknown> = {}, p: Pool = pool) => runSageMigration(p, parsedExport(f), opts(over));

describe('B8-A: an item code renamed in Sage', () => {
  it('the links in the books are unchanged and no link difference is reported on the POs naming it', async () => {
    expect((await run()).status).toBe('completed');
    const links = async () => (await pool.query(`SELECT o.po_number, p.sort_order, p.item_id::TEXT FROM po_items p JOIN purchase_orders o ON o.id = p.purchase_order_id
      WHERE o.company_id = $1 AND p.item_id = (SELECT id FROM items WHERE company_id = $1 AND external_ref = '50001') ORDER BY 1, 2`, [s.companyId])).rows;
    const before = await links();
    const f = exportFile();
    for (const i of items(f)) if (i.ID === 50001) i.Code = 'FIB-0001X';
    const r = await run(f);
    expect(await links()).toEqual(before);
    expect(r.differences.purchaseOrders.flatMap((p) => p.differences.filter((d) => /item_id/.test(d.field)))).toEqual([]);
  });
});

describe('B8-B: a PO line coded in IsaFlow', () => {
  it('account and cost centre set on a booked line, the Sage file unchanged: the re-run is not blocked, exit 0', async () => {
    expect((await run(exportFile(), { allowDifferences: false, expect: { items: 20, purchaseOrders: 10 } })).status).toBe('completed');
    const gl = String((await pool.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance) VALUES ($1, 'B8-5000', 'Materials', 'expense', 'debit') RETURNING id`, [s.companyId])).rows[0].id);
    const cc = String((await pool.query(`INSERT INTO cost_centres (company_id, code, name, cc_type) VALUES ($1, 'B8-CC', 'Project X', 'cc1') RETURNING id`, [s.companyId])).rows[0].id);
    await pool.query(`UPDATE po_items SET gl_account_id = $2, cc1_id = $3 WHERE purchase_order_id = (SELECT id FROM purchase_orders WHERE company_id = $1 AND external_ref = '900198')`, [s.companyId, gl, cc]);
    const r = await run(exportFile(), { allowDifferences: false, allowRefusals: false, expect: { items: 20, purchaseOrders: 10 } });
    expect(r.differences.purchaseOrders).toEqual([]);
    expect(r.status).toBe('completed');
    expect(exitCodeFor(r, false, false)).toBe(0);
  });
});

describe('B8-C: a stop after an item batch that overwrote an IsaFlow edit', () => {
  it('does not say the batch wrote nothing', async () => {
    expect((await run()).status).toBe('completed');
    await pool.query(`UPDATE items SET description = 'Edited in IsaFlow by a person', updated_at = now() WHERE company_id = $1 AND external_ref = '50001'`, [s.companyId]);
    const flaky = afterCommitOf(pool, 'bulk_upsert_items', { failNextConnect: true });
    const err = await run(exportFile(), {}, flaky).then(() => null, (e: unknown) => e);
    expect((await pool.query(`SELECT description FROM items WHERE company_id = $1 AND external_ref = '50001'`, [s.companyId])).rows[0].description).not.toBe('Edited in IsaFlow by a person'); // it DID write
    const itemLine = stopMessage(err).split('\n').find((l) => /item batch 1/.test(l)) ?? '';
    expect(itemLine).toMatch(/^committed: item batch 1/);
  });
});

describe('B8-F: LineType', () => {
  const accountLine = (lineType: unknown): Row => ({
    Items: items(exportFile()),
    PurchaseOrders: [{
      ID: 960001, DocumentNumber: 'PO-ACC-1', Date: '2026-02-01', Status: 'Pending', SupplierId: 302, SupplierName: 'Bravo Poles CC', Exclusive: 500, Tax: 75, Total: 575,
      Lines: [{ Description: 'Courier costs (expense account 50002)', ...(lineType === undefined ? {} : { LineType: lineType }), SelectionId: 50002, Quantity: 1, UnitPriceExclusive: 500, TaxTypeId: 1, Exclusive: 500, Tax: 75 }],
    }],
  });
  const linked = async () => (await pool.query(`SELECT p.item_id FROM po_items p JOIN purchase_orders o ON o.id = p.purchase_order_id WHERE o.company_id = $1 AND o.po_number = 'PO-ACC-1'`, [s.companyId])).rows;
  it('an account line (LineType 1) whose SelectionId equals an item id is refused, nothing booked, nothing linked', async () => {
    const r = await run(accountLine(1));
    expect(r.refused.filter((x) => x.entity === 'purchase_order').map((x) => [x.label, x.code])).toEqual([['PO-ACC-1', 'po_account_line_unsupported']]);
    expect(r.refused[0]!.reasons.join(' ')).toMatch(/account 50002/);
    expect(await linked()).toEqual([]);
  });
  it('an unknown LineType is refused (po_line_type_unknown)', async () => {
    expect((await run(accountLine(5))).refused.map((x) => x.code)).toEqual(['po_line_type_unknown']);
  });
  it('LineType 0 and no LineType are item lines: linked, as before', async () => {
    for (const t of [0, undefined]) {
      const r = await run(accountLine(t), { live: false });
      expect(r.refused, String(t)).toEqual([]);
      expect(r.lineLinks.linked, String(t)).toBe(1);
    }
  });
});
