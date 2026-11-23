/**
 * Round-8 review findings on a real database:
 *   - L3: the snapshot's supplier look-ups are company-scoped (read as the superuser, a PO naming another company's supplier shows no name);
 *   - L4: an owned item renamed in IsaFlow does not make every line naming it a difference;
 *   - L5: an item deactivated in IsaFlow but still active in Sage is re-activated by the items phase: its lines are planned linked, no difference;
 *     inactive in Sage too, the lines go unlinked and the difference stands.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { cleanupSageWorld, exportFile, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { readSnapshot } from '@/modules/accounting/services/sage-migration/sageSnapshot';
import { exitCodeFor } from '@/modules/accounting/services/sage-migration/sageReportSummary';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

type Row = Record<string, unknown>;
const items = (f: Row) => (f.Items as { $resources: Row[] }).$resources;
const run = (f: Row = exportFile(), over: Record<string, unknown> = {}) =>
  runSageMigration(pool, parsedExport(f), { companyId: s.companyId, userId: s.userId, live: true, allowRefusals: false, allowDifferences: false, ...over });

describe('L3: the supplier look-ups of the snapshot are company-scoped', () => {
  it('a PO of this company naming another company\'s supplier shows no supplier name or deletion', async () => {
    expect((await run()).status).toBe('completed');
    const foreign = String((await pool.query(`INSERT INTO suppliers (company_id, name, deleted_at) VALUES ($1, 'ANOTHER COMPANY SUPPLIER', now()) RETURNING id`, [s.otherCompanyId])).rows[0].id);
    await pool.query(`UPDATE purchase_orders SET supplier_id = $2 WHERE company_id = $1 AND external_ref = '900197'`, [s.companyId, foreign]);
    const snap = await readSnapshot(s.companyId); // as the superuser: only the query's own scoping can hide it
    const content = snap.poContent.get('900197')!;
    expect(content.supplierName ?? null).toBeNull();
    expect(content.supplierDeleted).toBe(false);
  });
});

describe('L4: an owned item renamed in IsaFlow', () => {
  it('its lines are no difference on a re-run (the stored link is looked up by the item\'s Sage reference, not its code)', async () => {
    expect((await run()).status).toBe('completed');
    await pool.query(`UPDATE items SET code = 'FIB-RENAMED' WHERE company_id = $1 AND external_ref = '50001'`, [s.companyId]);
    const r = await run(exportFile(), { allowDifferences: true, live: false });
    expect(r.differences.purchaseOrders.flatMap((p) => p.differences.map((d) => `${p.poNumber} ${d.field}`)).filter((x) => /item_id/.test(x))).toEqual([]);
  });
});

describe('L5: an item deactivated in IsaFlow', () => {
  const deactivate = () => pool.query(`UPDATE items SET is_active = false WHERE company_id = $1 AND external_ref = '50001'`, [s.companyId]);
  it('still active in Sage: the items phase sets it active again, so its lines are planned linked: no difference, exit 0', async () => {
    expect((await run()).status).toBe('completed');
    await deactivate();
    const r = await run(exportFile(), { allowDifferences: true });
    expect(r.differences.purchaseOrders).toEqual([]);
    expect(r.lineLinks.notLinked).toEqual([]);
    expect(r.status).toBe('completed');
    expect(r.differences.items.map((x) => x.code)).toEqual(['FIB-0001']); // the item itself is put back: that difference is the item's own
    expect(exitCodeFor(r, false, true)).toBe(0);
  });
  it('inactive in Sage too: its lines go unlinked and the difference stands', async () => {
    expect((await run()).status).toBe('completed');
    await deactivate();
    const f = exportFile();
    items(f)[0] = { ...items(f)[0], Active: false };
    const r = await run(f, { allowDifferences: true, live: false });
    expect(r.differences.purchaseOrders.map((p) => [p.poNumber, p.differences.map((d) => d.field)])).toEqual([['PO0000197', ['line 1 item_id']], ['PO0000202', ['line 1 item_id']]]);
  });
});
