/**
 * Budgets P5 §9, prod acceptance 2026-11-06: a bill made the way the new-bill form makes it, against a real PO.
 * - Its own PO line is not counted twice (committed 0 for this bill).
 * - The three-way match reads and recomputes on real tables: po_items and grn_items have no company_id, so the
 *   tenancy goes through the PO and the GRN, and another company's PO line never matches.
 * Real routes (withAuth → app_user), real PostgreSQL. Fixture route: isaflow_schema_fixture (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import billsRoute from '../../pages/api/accounting/supplier-invoices';
import remainingRoute from '../../pages/api/accounting/budgets/remaining';
import detailRoute from '../../pages/api/accounting/supplier-invoices-detail';
import matchRoute from '../../pages/api/accounting/supplier-invoices/[id]/three-way-match';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { approvePo, makePo } from './helpers/budgetPoFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;
const MONTH = '2026-06';

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-link');
  other = await seedBillFixture(pool, 'po-link-other');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])',
      [[f.owner, f.manager].flatMap((u) => [`purchase-order-approve:${u}`, `supplier-invoice-action:${u}`, `budget-remaining:${u}`])]);
    await dropBillFixture(pool, f);
    await dropBillFixture(pool, other);
  } finally {
    await pool.end();
  }
}, 60_000);

async function billFromPo(po: string, item: string, amount: number) {
  const r = await callRoute(billsRoute as never, f, f.owner, '/api/accounting/supplier-invoices', {
    useSequence: true, supplierId: f.supplier, purchaseOrderId: po, invoiceDate: `${MONTH}-15`, taxRate: 0,
    items: [{ poItemId: item, description: 'From the PO', quantity: 1, unitPrice: amount, taxRate: 0, glAccountId: f.acc.opex, cc1Id: f.cc.FT }],
  });
  expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
  return (r.body as { data: { id: string } }).data.id;
}
const remaining = async (bill: string) => {
  const r = await callRoute(remainingRoute as never, f, f.owner, '/api/accounting/budgets/remaining', { supplierInvoiceId: bill });
  expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
  return (r.body as { data: { lines: Array<{ committed: number; thisDocument: number }> } }).data.lines;
};
const match = (id: string, method: 'GET' | 'POST') => callRoute(matchRoute as never, f, f.owner,
  `/api/accounting/supplier-invoices/${id}/three-way-match`, undefined, { method, id });
const asDetail = async (id: string) => {
  const r = await callRoute(detailRoute as never, f, f.owner, `/api/accounting/supplier-invoices-detail?id=${id}`, undefined, { method: 'GET', id });
  expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
  return r.body.data as { poNumber?: string; items?: Array<{ poItemId?: string }> };
};
const approved = async (po: string) => {
  const r = await approvePo(f, f.owner, po, { budgetReason: 'setup' });
  expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
};

describe('a bill copied from a PO', () => {
  it('does not count its own PO line twice', async () => {
    const { po, items } = await makePo(pool, f, MONTH, [{ acct: f.acc.opex, amount: 200, cc1: f.cc.FT }]);
    await approved(po);
    const bill = await billFromPo(po, items[0]!, 200);
    const [line] = await remaining(bill);
    expect(line?.committed).toBe(0);
  });

  it('the three-way match names the PO, computes from its lines, and POST persists the same answer', async () => {
    const { po, items } = await makePo(pool, f, MONTH, [{ acct: f.acc.opex, amount: 100, cc1: f.cc.FT }]);
    await approved(po);
    const bill = await billFromPo(po, items[0]!, 110);

    const read = await match(bill, 'GET');
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
    const state = (read.body as { data: Record<string, unknown> & { itemResults: Array<Record<string, unknown>>; summary: Record<string, number> } }).data;
    expect(state.hasPurchaseOrder).toBe(true);
    expect(state.itemResults[0]).toMatchObject({ poQuantity: 1, invoiceQuantity: 1, poUnitPrice: 100, invoiceUnitPrice: 110, description: 'From the PO' });
    expect(state.summary).toMatchObject({ totalLines: 1, fullyMatched: 0, priceMismatches: 1, quantityMismatches: 0, grnMismatches: 1 });
    expect(state.tolerancesApplied).toEqual({ qtyTolerancePct: 2, priceTolerancePct: 2 });

    const posted = await match(bill, 'POST');
    expect(posted.statusCode, JSON.stringify(posted.body)).toBe(200);
    const after = (posted.body as { data: typeof state }).data;
    expect(after.itemResults).toEqual(state.itemResults);
    const stored = await pool.query('SELECT match_status FROM supplier_invoices WHERE id = $1', [bill]);
    expect(stored.rows[0].match_status).toBe(after.matchStatus);
  });

  it('its detail read names the PO, not another company\'s', async () => {
    const { po, items } = await makePo(pool, f, MONTH, [{ acct: f.acc.opex, amount: 70, cc1: f.cc.FT }]);
    await approved(po);
    const bill = await billFromPo(po, items[0]!, 70);
    const number = (await pool.query('SELECT po_number FROM purchase_orders WHERE id = $1', [po])).rows[0].po_number;
    const invoice = await asDetail(bill);
    expect(invoice.poNumber).toBe(number);
    expect(invoice.items?.[0]?.poItemId).toBe(items[0]);
    // A forged cross-company link prints nothing.
    await pool.query('UPDATE purchase_orders SET company_id = $1 WHERE id = $2', [other.co, po]);
    try {
      expect((await asDetail(bill)).poNumber).toBeUndefined();
    } finally {
      await pool.query('UPDATE purchase_orders SET company_id = $1 WHERE id = $2', [f.co, po]);
    }
  });

  it('a bill with no PO says so', async () => {
    const r = await callRoute(billsRoute as never, f, f.owner, '/api/accounting/supplier-invoices', {
      useSequence: true, supplierId: f.supplier, invoiceDate: `${MONTH}-16`, taxRate: 0,
      items: [{ description: 'No PO', quantity: 1, unitPrice: 5, taxRate: 0, glAccountId: f.acc.opex }],
    });
    const id = (r.body as { data: { id: string } }).data.id;
    const read = await match(id, 'GET');
    expect((read.body as { data: { hasPurchaseOrder: boolean } }).data.hasPurchaseOrder).toBe(false);
  });

  it('another company\'s id reads as nothing', async () => {
    const { po, items } = await makePo(pool, f, MONTH, [{ acct: f.acc.opex, amount: 50, cc1: f.cc.FT }]);
    await approved(po);
    const bill = await billFromPo(po, items[0]!, 50);
    const read = await callRoute(matchRoute as never, other, other.owner,
      `/api/accounting/supplier-invoices/${bill}/three-way-match`, undefined, { method: 'GET', id: bill });
    expect(read.statusCode).toBe(404);
  });
});
