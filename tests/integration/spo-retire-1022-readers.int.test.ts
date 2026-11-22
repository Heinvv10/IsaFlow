/**
 * Migration 1022: the readers and writers repointed from supplier_purchase_orders to purchase_orders, real PostgreSQL 16.
 * Legacy POs are seeded and copied by the migration file; then:
 *   - reports-supplier-pos gives the figures the legacy table held (per order and per supplier), with the canonical statuses;
 *   - the purchase order PDF is built from the copy (number, line);
 *   - supplier merge (the route) and the duplicate merge (mergeEntities) leave the copied orders with the source supplier (#1697's
 *     invariant, PR #1703 merge review HIGH 1: a merge never moves purchase_orders), and both refuse (400, nothing moved) a supplier
 *     whose purchase order has a bill tied to it;
 *   - the bill PDF's "PO #" names a copied order its header names, and never another company's;
 *   - the Demo reseed's wipe steps, in their own order, delete every legacy row past the retirement trigger: copied ones, one
 *     whose copy's lines the PO PUT replaced (new po_items ids), and a skipped one.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { linkRows, seedRawBill, seedSupplier } from './helpers/poBillLinkHarness';
import { asBeforeRetirement, dropCanonical, dropLegacy, runMigration, seedSpo, type SeededSpo } from './spo-retire-1022.helpers';
import reportRoute from '../../pages/api/accounting/reports-supplier-pos';
import supplierMergeRoute from '../../pages/api/accounting/supplier-merge';
import duplicatesMergeRoute from '../../pages/api/accounting/duplicates-merge';
import purchaseOrderDetailRoute from '../../pages/api/accounting/purchase-orders/[id]';
import { generateSupplierInvoicePdf } from '@/modules/accounting/services/ap/supplierInvoicePdfBuilder';
import { generatePurchaseOrderPdf } from '@/modules/accounting/services/ap/purchaseOrderPdfBuilder';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { WIPE_STEPS } from '../../scripts/lib/demoReseed/wipePlan';
import { deleteSql } from '../../scripts/lib/demoReseed/wipeSql';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;
let pdfBill = '';
let foreignPdfBill = '';
let sup2 = '';
let sup3 = '';
let sup4 = '';
let sup5 = '';
let linkedBill = '';
let sup5Payment = '';
const S: Record<string, SeededSpo> = {};

interface ReportPo { id: string; orderNumber: string; orderDate: string; deliveryDate: string | null; reference: string | null;
  status: string; totalAmount: number; taxAmount: number; subtotal: number }
interface Report { suppliers: Array<{ supplierId: string; poCount: number; totalValue: number; pos: ReportPo[] }>; grandTotal: number; grandPoCount: number }

const report = async (status?: string): Promise<Report> => {
  const route = (req: { query: Record<string, string> }, res: unknown) => {
    if (status) req.query = { ...req.query, status };
    return (reportRoute as unknown as (q: unknown, s: unknown) => unknown)(req, res);
  };
  const out = await callRoute(route as never, f, f.owner, '/api/accounting/reports-supplier-pos', undefined, { method: 'GET' });
  expect(out.statusCode).toBe(200);
  return out.body.data as Report;
};
const poSupplier = async (id: string) => String((await pool.query('SELECT supplier_id FROM purchase_orders WHERE id = $1', [id])).rows[0].supplier_id);

beforeAll(async () => {
  f = await seedBillFixture(pool, 'spo-retire-readers');
  other = await seedBillFixture(pool, 'spo-retire-readers-other');
  sup2 = await seedSupplier(pool, f, 'Readers second supplier');
  sup3 = await seedSupplier(pool, f, 'Readers merged by route');
  sup4 = await seedSupplier(pool, f, 'Readers merged by service');
  sup5 = await seedSupplier(pool, f, 'Readers linked supplier');
  const base = { co: f.co, supplier: f.supplier };
  await asBeforeRetirement(pool, async (c) => {
    S.a = await seedSpo(c, { ...base, number: 'RD-1', status: 'sent', deliveryDate: '2026-07-15',
      lines: [{ qty: 3, price: 100, discount: 10, description: 'Fibre splice kit' }, { qty: 2, price: 12.35 }] });
    S.b = await seedSpo(c, { ...base, number: 'RD-2', status: 'invoiced', orderDate: '2026-04-20', lines: [{ qty: 1, price: 999.99, received: 1 }] });
    S.c = await seedSpo(c, { ...base, supplier: sup2, number: 'RD-3', status: 'draft', lines: [{ qty: 4, price: 2.5 }] });
    S.d = await seedSpo(c, { ...base, supplier: sup3, number: 'RD-4', status: 'received', lines: [{ qty: 1, price: 10, received: 1 }] });
    S.e = await seedSpo(c, { ...base, supplier: sup4, number: 'RD-5', status: 'draft', lines: [{ qty: 1, price: 20 }] });
    S.linked = await seedSpo(c, { ...base, supplier: sup5, number: 'RD-6', status: 'sent', lines: [{ qty: 1, price: 40 }] });
    S.pdf = await seedSpo(c, { ...base, number: 'RD-PDF', status: 'draft', lines: [{ qty: 1, price: 5 }] });
    S.skipped = await seedSpo(c, { ...base, number: 'RD-NEG', status: 'draft', lines: [{ qty: 1, price: 0, lineTotal: -1 }] });
    S.theirs = await seedSpo(c, { co: other.co, supplier: other.supplier, number: 'THEIR-PDF', status: 'draft', lines: [{ qty: 1, price: 5 }] });
  });
  pdfBill = (await seedRawBill(pool, f, { items: [{ total: 5 }], subtotal: 5, total: 5.75, header: S.pdf!.id, status: 'draft' })).id;
  foreignPdfBill = (await seedRawBill(pool, f, { items: [{ total: 5 }], subtotal: 5, total: 5.75, header: S.theirs!.id, status: 'draft' })).id;
  // A bill of sup5 naming the legacy RD-6: the migration's backfill links it to the copy.
  linkedBill = (await seedRawBill(pool, f, { items: [{ total: 40 }], subtotal: 40, total: 46, header: S.linked!.id, supplier: sup5 })).id;
  sup5Payment = String((await pool.query(`INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount,
    status, created_by) VALUES ($1, 'RD-PAY-1', $2, '2026-06-20', 5, 'draft', $3) RETURNING id`, [f.co, sup5, f.owner])).rows[0].id);
  await runMigration(pool);
}, 120_000);

afterAll(async () => {
  try {
    if (f && other) {
      await dropLegacy(pool, [f.co, other.co]);
      await dropCanonical(pool, [f.co, other.co]);
      await pool.query('DELETE FROM supplier_payments WHERE company_id = $1', [f.co]);
    }
    for (const x of [f, other]) await dropBillFixture(pool, x);
  } finally { await pool.end(); }
}, 60_000);

describe('reports-supplier-pos reads the canonical table', () => {
  it('gives each copied order the figures the legacy table held, grouped by supplier, with its canonical status', async () => {
    const r = await report();
    const mine = r.suppliers.find((g) => g.supplierId === f.supplier)!;
    const pos = Object.fromEntries(mine.pos.map((p) => [p.id, p]));
    expect(pos[S.a!.id]).toEqual({ id: S.a!.id, orderNumber: 'RD-1', orderDate: '2026-05-01', deliveryDate: '2026-07-15',
      reference: 'REF-RD-1', status: 'approved', subtotal: Number(S.a!.subtotal), taxAmount: Number(S.a!.tax), totalAmount: Number(S.a!.total) });
    expect(pos[S.b!.id]).toMatchObject({ orderNumber: 'RD-2', orderDate: '2026-04-20', status: 'closed', totalAmount: Number(S.b!.total) });
    expect(mine.poCount).toBe(3);
    expect(mine.totalValue).toBe(Math.round((Number(S.a!.total) + Number(S.b!.total) + Number(S.pdf!.total)) * 100) / 100);
    const second = r.suppliers.find((g) => g.supplierId === sup2)!;
    expect(second.pos.map((p) => [p.orderNumber, p.status, p.totalAmount])).toEqual([['RD-3', 'draft', Number(S.c!.total)]]);
    expect(r.grandPoCount).toBe(7);
  });

  it('filters on a canonical status', async () => {
    const r = await report('closed');
    // RD-2 (invoiced) and RD-6 (sent, a bill names it): closed for billing evidence.
    expect(r.suppliers.flatMap((g) => g.pos.map((p) => p.id)).sort()).toEqual([S.b!.id, S.linked!.id].sort());
  });
});

describe('the purchase order PDF', () => {
  it('is built from the canonical copy (an edit made there shows; the frozen legacy row does not)', async () => {
    await pool.query(`UPDATE po_items SET description = 'Canonical splice kit' WHERE id = $1`, [S.a!.items[0]]);
    const pdf = (await generatePurchaseOrderPdf(f.co, S.a!.id)).toString('latin1');
    expect(pdf).toContain('RD-1');
    expect(pdf).toContain('Canonical splice kit');
    expect(pdf).not.toContain('Fibre splice kit');
  });
});

describe('supplier merges leave the copied orders with the source', () => {
  it('the supplier-merge route merges; the source supplier\'s purchase order stays with it', async () => {
    const out = await callRoute(supplierMergeRoute as never, f, f.owner, '/api/accounting/supplier-merge', { source_id: sup3, target_id: f.supplier });
    expect(out.statusCode).toBe(200);
    expect(await poSupplier(S.d!.id)).toBe(sup3);
  });

  it('mergeEntities (duplicates) merges; the duplicate\'s purchase order stays with it', async () => {
    const req = await openRequest(pool, f, f.owner);
    try {
      const res = await req.run(() => mergeEntities(f.co, 'supplier', f.supplier, sup4, f.owner));
      await req.commit();
      expect(res.reassignedTransactions).toBe(0);
    } catch (e) { await req.rollback(); throw e; }
    expect(await poSupplier(S.e!.id)).toBe(sup4);
  });
});

describe('a supplier whose purchase order has a linked bill', () => {
  const moved = async () => (await pool.query(
    `SELECT (SELECT supplier_id FROM purchase_orders WHERE id = $1) AS po, (SELECT supplier_id FROM supplier_invoices WHERE id = $2) AS bill,
            (SELECT supplier_id FROM supplier_payments WHERE id = $3) AS payment,
            (SELECT is_active FROM suppliers WHERE id = $4) AS active, (SELECT deleted_at FROM suppliers WHERE id = $4) AS deleted`,
    [S.linked!.id, linkedBill, sup5Payment, sup5])).rows[0];
  const untouched = () => ({ po: sup5, bill: sup5, payment: sup5, active: true, deleted: null });

  it('is linked after the copy (the precondition)', async () => {
    expect((await linkRows(pool, f, `l.supplier_invoice_id = '${linkedBill}'`)).map((l) => l.po)).toEqual([S.linked!.id]);
  });

  it('the supplier-merge route refuses it with a 400 and moves nothing', async () => {
    const out = await callRoute(supplierMergeRoute as never, f, f.owner, '/api/accounting/supplier-merge', { source_id: sup5, target_id: f.supplier });
    expect(out.statusCode).toBe(400);
    expect(await moved()).toEqual(untouched());
  });

  it('the duplicates-merge route (mergeEntities) refuses it with a 400 and moves nothing', async () => {
    const out = await callRoute(duplicatesMergeRoute as never, f, f.owner, '/api/accounting/duplicates-merge',
      { entityType: 'supplier', primaryId: f.supplier, duplicateId: sup5 });
    expect(out.statusCode).toBe(400);
    expect(String(out.body.error?.message ?? '')).toMatch(/linked to purchase orders/);
    expect(await moved()).toEqual(untouched());
  });
});

describe('the supplier invoice PDF', () => {
  it('names the copied order its header names, and never another company\'s order', async () => {
    expect((await generateSupplierInvoicePdf(f.co, pdfBill)).toString('latin1')).toContain('RD-PDF');
    expect((await generateSupplierInvoicePdf(f.co, foreignPdfBill)).toString('latin1')).not.toContain('THEIR-PDF');
  });
});

describe('the Demo reseed wipe', () => {
  it('deletes every legacy row past the retirement trigger: copied, edited through the PO PUT, deleted through the PO DELETE, skipped', async () => {
    // The PO PUT replaces a copy's lines with new po_items ids: the legacy lines' own copies are gone.
    const put = await callRoute(purchaseOrderDetailRoute as never, f, f.owner, `/api/accounting/purchase-orders/${S.c!.id}`,
      { items: [{ description: 'Edited', quantity: 2, unit_price: 3 }] }, { method: 'PUT', id: S.c!.id });
    expect(put.statusCode).toBe(200);
    expect((await pool.query('SELECT count(*)::INT AS n FROM po_items WHERE id = ANY($1::UUID[])', [S.c!.items])).rows[0].n).toBe(0);
    // The PO DELETE removes a draft copy outright: its legacy rows have no copy at all.
    const del = await callRoute(purchaseOrderDetailRoute as never, f, f.owner, `/api/accounting/purchase-orders/${S.e!.id}`, undefined, { method: 'DELETE', id: S.e!.id });
    expect(del.statusCode).toBe(200);
    expect((await pool.query('SELECT count(*)::INT AS n FROM purchase_orders WHERE id = $1', [S.e!.id])).rows[0].n).toBe(0);
    // The skipped order was never copied.
    expect((await pool.query('SELECT count(*)::INT AS n FROM purchase_orders WHERE id = $1', [S.skipped!.id])).rows[0].n).toBe(0);
    const tables = ['supplier_purchase_order_items', 'po_items', 'supplier_purchase_orders', 'purchase_orders'];
    const steps = WIPE_STEPS.filter((st) => tables.includes(st.table));
    expect(steps.map((st) => st.table)).toEqual(tables);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const st of steps) await c.query(deleteSql(st), [f.co]);
      const left = (await c.query('SELECT (SELECT count(*) FROM supplier_purchase_orders WHERE company_id = $1)::INT AS spo, '
        + '(SELECT count(*) FROM supplier_purchase_order_items i JOIN supplier_purchase_orders h ON h.id = i.purchase_order_id WHERE h.company_id = $1)::INT AS lines, '
        + '(SELECT count(*) FROM purchase_orders WHERE company_id = $1)::INT AS po', [f.co])).rows[0];
      expect(left).toEqual({ spo: 0, lines: 0, po: 0 });
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
