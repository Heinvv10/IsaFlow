/**
 * A bill is never written onto a soft-deleted (merged-away) supplier (review of 0d51f4a5, L2; migration 1021's
 * trg_supplier_invoices_supplier_live, ap/billSupplierLive.ts), real PostgreSQL, as app_user:
 *   - the REST create answers 400 with the typed wording (the trigger: its own supplier check is tenant-only);
 *   - create_supplier_invoice, bulk_create_supplier_invoices and update_supplier_invoice refuse it by their own live-supplier check
 *     first (Not found); a supplier deleted between that check and the write (the merge race) meets the trigger, typed (race B);
 *   - any other writer (recurring, the Sage import, capture, the AI pipeline insert directly) meets the trigger: SQLSTATE 23503,
 *     constraint supplier_invoices_supplier_live;
 *   - a live supplier, and an edit that leaves a bill's (deleted) supplier alone, are untouched.
 * The race with a merge is in mcp-goods-received-supplier-merge.int.test.ts (race B). Fixture route: isaflow_schema_fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedSupplier } from './helpers/poBillLinkHarness';
import { callTool, dropGrnExtras, dropMaintExtras } from './helpers/grnHarness';
import { createSupplierInvoiceTool as createTool } from '@/lib/mcp/tools/writeSupplierInvoices';
import { bulkCreateSupplierInvoicesTool as bulkTool } from '@/lib/mcp/tools/writeBulkInvoices';
import { updateSupplierInvoiceTool as update } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import billsRoute from '../../pages/api/accounting/supplier-invoices';
import executeRoute from '../../pages/api/accounting/recurring-transactions-execute';
import { softDelete, undoDelete } from '@/modules/accounting/services/core/softDeleteService';
import { SoftDeleteRefusalError } from '@/modules/accounting/services/core/softDeleteErrors';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
let gone: string;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'bill-supplier-live');
  gone = await seedSupplier(pool, f, 'Merged away');
  await pool.query('UPDATE suppliers SET deleted_at = now() WHERE id = $1', [gone]);
}, 60_000);
afterAll(async () => {
  try { await dropGrnExtras(pool, f); await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const number = () => `LIVE-${crypto.randomUUID().slice(0, 8)}`;
const lines = () => [{ description: 'Goods', quantity: 1, unit_price: 40, tax_rate: 15, gl_account_id: f.acc.opex }];
const billsOf = async (supplier: string) => Number((await pool.query('SELECT count(*) AS n FROM supplier_invoices WHERE supplier_id = $1', [supplier])).rows[0].n);
const WORDING = 'The supplier has been merged into another or deleted, so this bill was not saved';


describe('every bill writer refuses a soft-deleted supplier', () => {
  it('the REST create answers 400, typed; nothing is written', async () => {
    const out = await callRoute(billsRoute as never, f, f.owner, '/api/accounting/supplier-invoices', {
      supplierId: gone, invoiceNumber: number(), invoiceDate: '2026-06-15',
      items: [{ description: 'Goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: f.acc.opex }],
    });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body)).toContain(WORDING);
    expect(await billsOf(gone)).toBe(0);
  });

  it('create_supplier_invoice and bulk_create_supplier_invoices refuse it (their own live-supplier check answers first: Not found)', async () => {
    const [n1, n2] = [number(), number()];
    const one = await callTool(pool, f, createTool, { supplier_id: gone, invoice_number: n1, invoice_date: '2026-06-15', lines: lines() });
    expect(one.isError).toBe(true);
    const bulk = await callTool(pool, f, bulkTool, { invoices: [{ supplier_id: gone, invoice_number: n2, invoice_date: '2026-06-15', lines: lines() }] });
    expect(bulk.text).toContain('Not found');
    expect(Number((await pool.query('SELECT count(*) AS n FROM supplier_invoices WHERE invoice_number = ANY($1::text[])', [[n1, n2]])).rows[0].n)).toBe(0);
  });

  it('update_supplier_invoice refuses a supplier change onto it (its own check: Not found); the bill keeps its supplier', async () => {
    const req = await openRequest(pool, f, f.owner);
    let bill: string;
    try {
      bill = (await req.run(() => createSupplierInvoice(f.co, {
        invoiceNumber: number(), supplierId: f.supplier, invoiceDate: '2026-06-15',
        items: [{ description: 'Goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: f.acc.opex }],
      }, f.owner))).id;
      await req.commit();
    } catch (err) { await req.rollback(); throw err; }
    const r = await callTool(pool, f, update, { invoice_id: bill!, supplier_id: gone });
    expect(r.isError).toBe(true);
    expect(String((await pool.query('SELECT supplier_id FROM supplier_invoices WHERE id = $1', [bill!])).rows[0].supplier_id)).toBe(f.supplier);
  });

  it('a direct insert (recurring, Sage import, capture, AI pipeline) meets the trigger: 23503 supplier_invoices_supplier_live', async () => {
    const req = await openRequest(pool, f, f.owner);
    try {
      await expect(req.client.query(
        `INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date, subtotal, total_amount, status, created_by)
         VALUES ($1, $2, $3, '2026-06-15', 40, 46, 'draft', $4)`, [f.co, number(), gone, f.owner]))
        .rejects.toMatchObject({ code: '23503', constraint: 'supplier_invoices_supplier_live' });
    } finally { await req.rollback(); }
  });

  it('a live supplier, and an edit that leaves a bill on its (since deleted) supplier, are untouched', async () => {
    const other = await seedSupplier(pool, f, 'Deleted later');
    const req = await openRequest(pool, f, f.owner);
    let bill: string;
    try {
      bill = (await req.run(() => createSupplierInvoice(f.co, {
        invoiceNumber: number(), supplierId: other, invoiceDate: '2026-06-15',
        items: [{ description: 'Goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: f.acc.opex }],
      }, f.owner))).id;
      await req.commit();
    } catch (err) { await req.rollback(); throw err; }
    await pool.query('UPDATE suppliers SET deleted_at = now() WHERE id = $1', [other]);
    const r = await callTool(pool, f, update, { invoice_id: bill!, notes: 'still editable' });
    expect(r.isError, r.text).toBe(false);
  });
});

describe('the trigger fires after the FK\'s RI trigger (review of b4741393, L2)', () => {
  it('trigger order is by name: the FK\'s RI trigger on supplier_id sorts before trg_supplier_invoices_supplier_live', async () => {
    const rows = (await pool.query(
      `SELECT t.tgname, t.tgname::text COLLATE "C" < 'trg_supplier_invoices_supplier_live' AS before FROM pg_trigger t
         JOIN pg_constraint c ON c.oid = t.tgconstraint
        WHERE t.tgrelid = 'public.supplier_invoices'::regclass AND c.conname = 'supplier_invoices_supplier_id_fkey'`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.before, String(r.tgname)).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_supplier_invoices_supplier_live' AND tgenabled = 'A'")).rows[0].n).toBe(1);
  });
});

describe('the undo of a bill whose supplier was deleted since (review of b4741393, L2)', () => {
  it('is refused, typed, naming the exit; the bill stays deleted', async () => {
    const later = await seedSupplier(pool, f, 'Deleted after the bill');
    const req = await openRequest(pool, f, f.owner);
    let bill: string;
    try {
      bill = (await req.run(() => createSupplierInvoice(f.co, {
        invoiceNumber: number(), supplierId: later, invoiceDate: '2026-06-15',
        items: [{ description: 'Goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: f.acc.opex }],
      }, f.owner))).id;
      await req.run(() => softDelete(f.co, 'supplier_invoice', bill, f.owner));
      await req.commit();
    } catch (err) { await req.rollback(); throw err; }
    await pool.query('UPDATE suppliers SET deleted_at = now() WHERE id = $1', [later]);
    const u = await openRequest(pool, f, f.owner);
    let out: unknown;
    try { out = await u.run(() => undoDelete(f.co, 'supplier_invoice', bill!, f.owner)); await u.commit(); } catch (err) { await u.rollback(); out = err; }
    expect(out).toBeInstanceOf(SoftDeleteRefusalError);
    expect((out as Error).message).toContain('supplier has been merged into another or deleted');
    expect((out as Error).message).toContain('enter the bill again');
    expect((await pool.query('SELECT deleted_at IS NOT NULL AS deleted FROM supplier_invoices WHERE id = $1', [bill!])).rows[0].deleted).toBe(true);
  });
});

describe('a recurring bill template naming a deleted supplier (review of b4741393, M2)', () => {
  it('the execute route answers 400 for that template, typed, and writes nothing', async () => {
    const tpl = crypto.randomUUID();
    await pool.query(
      `INSERT INTO recurring_transaction_templates (id, company_id, name, entity_type, template_data, frequency, auto_post, created_by)
       VALUES ($1, $2, 'Live rec', 'supplier_invoice', $3, 'monthly', false, $4)`,
      [tpl, f.co, JSON.stringify({ supplierId: gone, lines: [{ description: 'Rent', quantity: 1, unitPrice: 100, taxRate: 15, lineTotal: 100, accountId: f.acc.opex }] }), f.owner]);
    try {
      const out = await callRoute(executeRoute as never, f, f.owner, '/api/accounting/recurring-transactions-execute', { templateId: tpl });
      expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
      expect(JSON.stringify(out.body)).toContain('names a supplier that has been merged into another or deleted');
      expect(await billsOf(gone)).toBe(0);
    } finally {
      await pool.query('DELETE FROM recurring_transaction_templates WHERE id = $1', [tpl]);
    }
  });
});
