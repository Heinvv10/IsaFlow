/**
 * The `app` links (design decisions 4, 11; migration 1006), real PostgreSQL: a bill saved naming a PO of its supplier gets a
 * link per PO it names, in the bill's own transaction, and keeps it right on every draft edit.
 *   - the REST create: a header PO (amount: the subtotal, or the lines naming that PO), lines-only bills naming two POs
 *     (header NULL), a PO of another supplier / company, a legacy id, a draft PO or no PO: links only where the PO is the bill's
 *     supplier's and linkable;
 *   - the links are written inside the create's transaction (a rolled-back create leaves none);
 *   - a draft edit (MCP update_supplier_invoice with new lines, REST PUT) makes the `app` links again from what the bill now
 *     says; a link another writer made is not touched.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import billsRoute from '../../pages/api/accounting/supplier-invoices';
import detailRoute from '../../pages/api/accounting/supplier-invoices-detail';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool } from './helpers/poImportHarness';
import { linkRows, seedPo, seedSupplier } from './helpers/poBillLinkHarness';
import { updateSupplierInvoiceTool as updateBill } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-links-app');
  other = await seedBillFixture(pool, 'po-links-app-other');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try { for (const x of [f, other]) await dropBillFixture(pool, x); } finally { await pool.end(); }
}, 60_000);

describe('the REST create writes the app link', () => {
  const create = (body: Record<string, unknown>) => callRoute(billsRoute as never, f, f.owner, '/api/accounting/supplier-invoices', {
    useSequence: true, supplierId: f.supplier, invoiceDate: '2026-06-15', taxRate: 0, ...body });
  const line = (poItemId?: string) => ({ ...(poItemId ? { poItemId } : {}), description: 'x', quantity: 1, unitPrice: 80, taxRate: 0, glAccountId: f.acc.opex, cc1Id: f.cc.FT });

  it('a bill naming a PO of its supplier gets one; a legacy, foreign or other-supplier id gets none', async () => {
    const po = await seedPo(pool, f, { lines: [80, 20] });
    const ok = await create({ purchaseOrderId: po.po, items: [line(po.items[0])] });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(201);
    const bill = (ok.body as { data: { id: string } }).data.id;
    expect(await linkRows(pool, f, `l.supplier_invoice_id = '${bill}'`)).toEqual([expect.objectContaining({ po: po.po, amount: '80.00', source: 'app', created_by: f.owner })]);

    const headerOnly = await create({ purchaseOrderId: po.po, items: [line()] });
    const bill2 = (headerOnly.body as { data: { id: string } }).data.id;
    expect((await linkRows(pool, f, `l.supplier_invoice_id = '${bill2}'`))[0]).toMatchObject({ amount: '80.00', source: 'app' });

    const legacy = await create({ purchaseOrderId: crypto.randomUUID(), items: [line()] });
    expect(legacy.statusCode).toBe(201);
    expect(await linkRows(pool, f, `l.supplier_invoice_id = '${(legacy.body as { data: { id: string } }).data.id}'`)).toEqual([]);
    const foreignPo = await seedPo(pool, other, { lines: [10] });
    const foreign = await create({ purchaseOrderId: foreignPo.po, items: [line()] });
    expect(foreign.statusCode).toBe(201);
    expect(await linkRows(pool, f, `l.supplier_invoice_id = '${(foreign.body as { data: { id: string } }).data.id}'`)).toEqual([]);
    const sup = crypto.randomUUID();
    await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'Other supplier', true)", [sup, f.co]);
    const strangers = await seedPo(pool, f, { lines: [10], supplier: sup });
    const otherSupplier = await create({ purchaseOrderId: strangers.po, items: [line()] });
    expect(otherSupplier.statusCode, JSON.stringify(otherSupplier.body)).toBe(201);
    expect(await linkRows(pool, f, `l.supplier_invoice_id = '${(otherSupplier.body as { data: { id: string } }).data.id}'`)).toEqual([]);
    const none = await create({ items: [line()] });
    expect(await linkRows(pool, f, `l.supplier_invoice_id = '${(none.body as { data: { id: string } }).data.id}'`)).toEqual([]);
  });
});


describe('line-only bills, linkable statuses, the create transaction and the draft edit', () => {
  const create = (body: Record<string, unknown>) => callRoute(billsRoute as never, f, f.owner, '/api/accounting/supplier-invoices', {
    useSequence: true, supplierId: f.supplier, invoiceDate: '2026-06-15', taxRate: 0, ...body });
  const line = (amount: number, poItemId?: string) => ({ ...(poItemId ? { poItemId } : {}), description: `x${amount}`, quantity: 1, unitPrice: amount, taxRate: 0, glAccountId: f.acc.opex, cc1Id: f.cc.FT });
  const idOf = (r: { body: unknown }) => (r.body as { data: { id: string } }).data.id;

  it('a bill whose LINES name two POs (no header PO) gets one link per PO; a draft PO header gets none', async () => {
    const a = await seedPo(pool, f, { lines: [60] });
    const b = await seedPo(pool, f, { lines: [40] });
    const r = await create({ items: [line(60, a.items[0]), line(40, b.items[0])] });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
    const links = await linkRows(pool, f, `l.supplier_invoice_id = '${idOf(r)}'`);
    expect(links.map((l) => [l.po, l.amount, l.source]).sort()).toEqual([[a.po, '60.00', 'app'], [b.po, '40.00', 'app']].sort());
    expect(String((await pool.query('SELECT purchase_order_id FROM supplier_invoices WHERE id = $1', [idOf(r)])).rows[0].purchase_order_id)).toBe('null');
    const draftPo = await seedPo(pool, f, { lines: [10], status: 'draft' });
    const d = await create({ purchaseOrderId: draftPo.po, items: [line(10)] });
    expect(d.statusCode).toBe(201);
    expect(await linkRows(pool, f, `l.supplier_invoice_id = '${idOf(d)}'`)).toEqual([]);
  });

  it('the links are written in the create\'s own transaction: a create that rolls back leaves none', async () => {
    const po = await seedPo(pool, f, { lines: [90] });
    const before = (await linkRows(pool, f)).length;
    const req = await openRequest(pool, f, f.owner);
    let made = 0;
    try {
      await req.run(async () => {
        const bill = await createSupplierInvoice(f.co, {
          supplierId: f.supplier, invoiceNumber: `TX-${po.po.slice(0, 6)}`, invoiceDate: '2026-06-15', purchaseOrderId: po.po,
          items: [{ description: 'x', quantity: 1, unitPrice: 90, taxRate: 0, glAccountId: f.acc.opex }],
        } as never, f.owner);
        made = (await req.client.query('SELECT count(*)::INT AS n FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [bill.id])).rows[0].n;
      });
    } finally { await req.rollback(); }
    expect(made).toBe(1);
    expect((await linkRows(pool, f)).length).toBe(before);
  });

  it('a draft edit makes the app links again from the new lines; an mcp link of the same bill is not touched', async () => {
    const po = await seedPo(pool, f, { lines: [80, 20] });
    const other2 = await seedPo(pool, f, { lines: [10] });
    const r = await create({ purchaseOrderId: po.po, items: [line(80)] });
    const bill = idOf(r);
    expect((await linkRows(pool, f, `l.supplier_invoice_id = '${bill}'`))[0]).toMatchObject({ po: po.po, amount: '80.00', source: 'app' });
    await pool.query(`INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, 5, 'mcp')`, [f.co, other2.po, bill]);

    const edit = await callTool(pool, f, updateBill, { invoice_id: bill, lines: [{ description: 'smaller', quantity: 1, unit_price: 50, tax_rate: 0, gl_account_id: f.acc.opex }] });
    expect(edit.isError, edit.text).toBe(false);
    const after = await linkRows(pool, f, `l.supplier_invoice_id = '${bill}'`);
    expect(after.map((l) => [l.po, l.amount, l.source]).sort()).toEqual([[po.po, '50.00', 'app'], [other2.po, '5.00', 'mcp']].sort());

    const put = await callRoute(detailRoute as never, f, f.owner, '/api/accounting/supplier-invoices-detail', { id: bill, notes: 'edited' }, { method: 'PUT' });
    expect(put.statusCode, JSON.stringify(put.body)).toBe(200);
    expect((await linkRows(pool, f, `l.supplier_invoice_id = '${bill}' AND l.source = 'app'`))[0]).toMatchObject({ po: po.po, amount: '50.00' });
  });

  it('a supplier of another company is never linked, whichever way the PO is named', async () => {
    const theirs = await seedPo(pool, other, { lines: [10] });
    const supplier2 = await seedSupplier(pool, f);
    const mine2 = await seedPo(pool, f, { lines: [10], supplier: supplier2 });
    for (const po of [theirs.po, mine2.po]) {
      const r = await create({ purchaseOrderId: po, items: [line(10)] });
      expect(r.statusCode).toBe(201);
      expect(await linkRows(pool, f, `l.supplier_invoice_id = '${idOf(r)}'`)).toEqual([]);
    }
  });
});
