/**
 * Round-7 breaker findings on a real database (the breaker's repros b7-a/b/d/e/f, ported):
 *   - A: "already booked" is decided by the Sage REFERENCE, as the tool replays: a booked PO renumbered in Sage, or two whose numbers were
 *     swapped, are not refused (po_number_taken / supplier / policy), the number is a difference, and the allowance and allSentBooked agree;
 *   - B / F: a VAT swap between lines, or a line whose item link moved or was dropped, is listed (the compare covers every column the tool writes);
 *   - D: one Sage supplier id under two names that match two IsaFlow suppliers is refused, whatever the order of the rows;
 *   - E: a stop does not call a replayed batch whose rows are gone "committed".
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { booked, cleanupSageWorld, exportFile, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { exitCodeFor } from '@/modules/accounting/services/sage-migration/sageReportSummary';
import { stopMessage } from '@/modules/accounting/services/sage-migration/sageStopMessage';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

type Row = Record<string, unknown>;
const pos = (f: Row) => (Array.isArray(f.PurchaseOrders) ? f.PurchaseOrders : (f.PurchaseOrders as { $resources: Row[] }).$resources) as Row[];
const run = (f: Row = exportFile(), over: Record<string, unknown> = {}, p: Pool = pool) =>
  runSageMigration(p, parsedExport(f), { companyId: s.companyId, userId: s.userId, live: true, allowRefusals: true, allowDifferences: true, expect: {}, ...over });

describe('B7-A: a booked PO renumbered in Sage', () => {
  const renumbered = (): Row => { const f = exportFile(); for (const p of pos(f)) if (p.ID === 900198) p.DocumentNumber = 'PO0000198-R'; return f; };
  it('with its supplier deactivated since: not refused, its number is listed once, under the number the books hold', async () => {
    expect((await run()).status).toBe('completed');
    await pool.query('UPDATE suppliers SET is_active = false WHERE id = $1', [s.suppliers.bravo]);
    const r = await run(renumbered(), { live: false, allowDifferences: false });
    expect(r.refused.filter((x) => x.sageId === '900198')).toEqual([]);
    const listed = r.differences.purchaseOrders.filter((p) => /PO0000198/.test(p.poNumber));
    expect(listed.map((p) => p.poNumber)).toEqual(['PO0000198']);
    expect(listed[0]!.differences.map((d) => d.field)).toEqual(['po_number', 'external_document_number']); // the number and the document number the tool stores with it
  });
  it('under --allow-differences the run goes live, books nothing new, and is "all sent booked": exit 0', async () => {
    expect((await run()).status).toBe('completed');
    const r = await run(renumbered(), { expect: { items: 20, purchaseOrders: 10 } });
    expect(r.status).toBe('completed');
    expect(r.reconciliation.allSentBooked).toBe(true);
    expect(exitCodeFor(r, false, true)).toBe(0);
    expect((await booked(pool, s.companyId)).pos).toBe(10);
    expect((await pool.query(`SELECT po_number FROM purchase_orders WHERE company_id = $1 AND external_ref = '900198'`, [s.companyId])).rows).toEqual([{ po_number: 'PO0000198' }]);
  });
  it('renumbered AND its total changed (a line added in Sage): the allowance covers it by reference, the run is complete and exits 0', async () => {
    expect((await run()).status).toBe('completed');
    const f = renumbered();
    const p = pos(f).find((x) => x.ID === 900198)!;
    Object.assign(p, { Exclusive: (p.Exclusive as number) + 100, Tax: (p.Tax as number) + 15, Total: (p.Total as number) + 115,
      Lines: [...(p.Lines as Row[]), { Description: 'Extra', Quantity: 1, UnitPriceExclusive: 100, TaxTypeId: 1, TaxPercentage: 15, Exclusive: 100, Tax: 15 }] });
    const r = await run(f, { expect: { items: 20, purchaseOrders: 10 } });
    expect(r.status).toBe('completed');
    expect(r.differences.purchaseOrders.map((x) => x.poNumber)).toEqual(['PO0000198']);
    expect(r.reconciliation.purchaseOrders.differenceCents).toBe(11500);
    expect(r.reconciliation.allSentBooked).toBe(true);
    expect(exitCodeFor(r, false, true)).toBe(0);
  });
  it('two booked POs whose numbers Sage swapped are not po_number_taken; each is listed under the number the books hold', async () => {
    expect((await run()).status).toBe('completed');
    const f = exportFile();
    for (const p of pos(f)) { if (p.ID === 900198) p.DocumentNumber = 'PO0000201'; else if (p.ID === 900201) p.DocumentNumber = 'PO0000198'; }
    const r = await run(f, { live: false });
    expect(r.refused.filter((x) => x.sageId === '900198' || x.sageId === '900201')).toEqual([]);
    expect(r.differences.purchaseOrders.map((p) => p.poNumber).sort()).toEqual(['PO0000198', 'PO0000201']);
  });
});

describe('B7-B / B7-F: every column the tool writes is compared', () => {
  const vat = (firstStandard: boolean): Row => ({
    PurchaseOrders: [{
      ID: 990001, DocumentNumber: 'PO-B7-1', Date: '2026-02-01', Status: 'Pending', SupplierId: 302, SupplierName: 'Bravo Poles CC', Exclusive: 200, Tax: 15, Total: 215,
      Lines: [
        { Description: 'Pole cap', Quantity: 1, UnitPriceExclusive: 100, Exclusive: 100, ...(firstStandard ? { TaxTypeId: 1, TaxPercentage: 15, Tax: 15 } : { TaxTypeId: 2, TaxPercentage: 0, Tax: 0 }) },
        { Description: 'Pole bracket', Quantity: 1, UnitPriceExclusive: 100, Exclusive: 100, ...(firstStandard ? { TaxTypeId: 2, TaxPercentage: 0, Tax: 0 } : { TaxTypeId: 1, TaxPercentage: 15, Tax: 15 }) },
      ],
    }],
  });
  it('B: VAT moved between two lines in Sage at the same totals is listed', async () => {
    expect((await run(vat(true), { allowDifferences: false })).status).toBe('completed');
    const r = await run(vat(false), { live: false, allowDifferences: false });
    expect(r.differences.purchaseOrders.map((p) => [p.poNumber, p.differences.map((d) => d.field)])).toEqual([['PO-B7-1', ['line 1 tax_rate', 'line 1 tax_amount', 'line 2 tax_rate', 'line 2 tax_amount']]]);
  });
  const moved = (to: number | null): Row => {
    const f = exportFile();
    const line = ((pos(f).find((p) => p.ID === 900197)!.Lines) as Row[])[0]!;
    if (to === null) delete line.ItemId; else line.ItemId = to;
    return f;
  };
  for (const to of [50007, null] as const) {
    it(`F: Sage moves PO0000197 line 1 from FIB-0001 to ${to === null ? 'no item' : 'FIB-0007 (inactive)'}: the books keep the old link and the PO is listed`, async () => {
      expect((await run()).status).toBe('completed');
      const r = await run(moved(to), { live: false, allowDifferences: false });
      const d = r.differences.purchaseOrders.filter((p) => p.poNumber === 'PO0000197');
      expect(d).toHaveLength(1);
      expect(d[0]!.differences.map((x) => x.field)).toContain('line 1 item_id');
    });
  }
  it('an unchanged re-run lists nothing (no false alarm from the wider compare), the notes the importer writes included', async () => {
    expect((await run()).status).toBe('completed');
    const r = await run(exportFile(), { allowDifferences: false, allowRefusals: false });
    expect(r.differences).toEqual({ purchaseOrders: [], items: [], categories: [] });
    expect(exitCodeFor(r, false, false)).toBe(0);
  });
});

describe('B7-D: one Sage supplier id under two names', () => {
  const po = (id: number, num: string, name: string): Row => ({
    ID: id, DocumentNumber: num, Date: '2026-02-01', Status: 'Pending', SupplierId: 302, SupplierName: name, Exclusive: 100, Tax: 15, Total: 115,
    Lines: [{ Description: 'Bracket', Quantity: 1, UnitPriceExclusive: 100, TaxTypeId: 1, Exclusive: 100, Tax: 15 }],
  });
  for (const order of [['Bravo Poles CC', 'Delta Hardware'], ['Delta Hardware', 'Bravo Poles CC']] as const) {
    it(`each name matches a different IsaFlow supplier (${order.join(' first, then ')}): both POs refused supplier_ambiguous, none booked`, async () => {
      await pool.query(`INSERT INTO suppliers (company_id, name) VALUES ($1, 'Delta Hardware')`, [s.companyId]);
      const r = await run({ PurchaseOrders: [po(990011, 'PO-B7-D1', order[0]), po(990012, 'PO-B7-D2', order[1])] });
      expect(r.refused.map((x) => `${x.label}:${x.code}`).sort()).toEqual(['PO-B7-D1:supplier_ambiguous', 'PO-B7-D2:supplier_ambiguous']);
      expect((await booked(pool, s.companyId)).pos).toBe(0);
    });
  }
});

describe('B7-E: a stop after a replayed batch whose rows are gone', () => {
  it('the stop message does not call it committed, and names the remedy', async () => {
    const f = exportFile();
    delete (f as Row).PurchaseOrders;
    expect((await run(f)).status).toBe('completed');
    await pool.query('DELETE FROM items WHERE company_id = $1', [s.companyId]);
    let commits = 0;
    const killing = {
      options: pool.options,
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, prop) {
            if (prop === 'query') {
              return async (...args: unknown[]) => {
                const out = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
                if (args[0] === 'COMMIT' && ++commits === 5) { // 4 category commits, then the (replayed) item batch
                  await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
                  await new Promise((r) => setTimeout(r, 150));
                }
                return out;
              };
            }
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      },
    } as unknown as Pool;
    const err = await run(f, {}, killing).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = stopMessage(err);
    expect((await pool.query('SELECT count(*)::INT AS n FROM items WHERE company_id = $1', [s.companyId])).rows[0].n).toBe(0);
    expect(msg).not.toMatch(/committed: item batch/);
    expect(msg).toMatch(/replayed: rows absent.*--run-tag.*item batch 1/s);
  });
});
