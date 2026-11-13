/**
 * The bill / customer-invoice `hasDocument` flag is COMPUTED from the document tables, not read off
 * `source_document_id IS NOT NULL` (and get-by-id used to carry no flag at all, so it always read false).
 * One predicate (core/documentPresenceSql) feeds the flag, the "Missing document" filter and list_missing_documents.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { getSupplierInvoiceById, getSupplierInvoices } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { getCustomerInvoiceDetail, listCustomerInvoices } from '@/modules/accounting/services/ar/customerInvoiceReadService';
import { dropFixture, seedBill, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { capturedDoc, crossLink, dropDocuments, procDoc } from './helpers/documentFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('hasDocument is computed from the document tables', () => {
  let fx: Fixture;
  let other: Fixture;
  const bills: Record<string, string> = {};
  const invoices: Record<string, string> = {};
  const n = () => randomUUID().slice(0, 8);

  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, bills and documents.');
    fx = await seedFixture('HASDOC', DATABASE_URL!);
    other = await seedFixture('HASDOCB', DATABASE_URL!);
    const bill = async (key: string) => { bills[key] = await seedBill(fx, { number: `B-${n()}`, date: '2026-06-10', total: 115 }); };
    for (const k of ['none', 'upload', 'linked', 'inactive', 'captured', 'capturedNoBytes', 'capturedRejected', 'foreignCapture',
      'poLinkedOnly', 'grnLinkedOnly', 'capturedNullStatus']) await bill(k);
    await procDoc('supplier_invoice', bills.upload!);
    const shared = await procDoc('supplier_invoice', bills.none!, { active: true, name: 'po-doc.pdf' });
    await sql`DELETE FROM procurement_documents WHERE id = ${shared}::UUID`;
    const crossDoc = await procDoc('supplier_invoice', bills.upload!, { name: 'other-bill.pdf' });
    await crossLink(crossDoc, 'supplier_invoice', bills.linked!);
    await procDoc('supplier_invoice', bills.inactive!, { active: false });
    // autoLinkSupplierInvoice: the PO's and GRN's own documents are linked to the bill — the order's paperwork, not its invoice.
    await crossLink(await procDoc('purchase_order', randomUUID()), 'supplier_invoice', bills.poLinkedOnly!, 'po_invoice_link');
    await crossLink(await procDoc('goods_receipt_note', randomUUID()), 'supplier_invoice', bills.grnLinkedOnly!, 'grn_invoice_link');
    const set = (id: string, doc: string) => sql`UPDATE supplier_invoices SET source_document_id = ${doc}::UUID WHERE id = ${id}::UUID`;
    await set(bills.captured!, await capturedDoc(fx.companyId));
    await set(bills.capturedNoBytes!, await capturedDoc(fx.companyId, { stored: false }));
    await set(bills.capturedRejected!, await capturedDoc(fx.companyId, { status: 'rejected' }));
    await set(bills.foreignCapture!, await capturedDoc(other.companyId));
    await set(bills.capturedNullStatus!, await capturedDoc(fx.companyId, { status: null }));

    const inv = async (key: string) => { invoices[key] = await seedInvoice(fx, { number: `I-${n()}`, date: '2026-06-10', total: 115 }); };
    for (const k of ['none', 'upload', 'captured', 'capturedNoBytes']) await inv(k);
    await procDoc('customer_invoice', invoices.upload!);
    await sql`UPDATE customer_invoices SET source_document_id = ${await capturedDoc(fx.companyId)}::UUID WHERE id = ${invoices.captured!}::UUID`;
    await sql`UPDATE customer_invoices SET source_document_id = ${await capturedDoc(fx.companyId, { stored: false })}::UUID WHERE id = ${invoices.capturedNoBytes!}::UUID`;
    // The list joins this view; a fresh cluster has it unpopulated.
    await sql`REFRESH MATERIALIZED VIEW customer_invoice_view_summary_mv`;
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      if (!f) continue;
      await dropDocuments(f);
      await dropFixture(f);
    }
  }, 120000);

  const EXPECT_BILLS: Record<string, boolean> = {
    none: false, upload: true, linked: true, inactive: false, captured: true,
    capturedNoBytes: false, capturedRejected: false, foreignCapture: false,
    poLinkedOnly: false, grnLinkedOnly: false, capturedNullStatus: true,
  };

  it('list_supplier_invoices flag: an uploaded or cross-linked document counts; a capture with no bytes / rejected / another company\'s does not', async () => {
    const { invoices: rows } = await getSupplierInvoices(fx.companyId, { limit: 200 });
    const byId = new Map(rows.map((r) => [r.id, r.hasDocument]));
    for (const [key, want] of Object.entries(EXPECT_BILLS)) expect({ key, got: byId.get(bills[key]!) }).toEqual({ key, got: want });
  });

  it('get_supplier_invoice carries the same computed flag as the list', async () => {
    for (const [key, want] of Object.entries(EXPECT_BILLS)) {
      const bill = await getSupplierInvoiceById(fx.companyId, bills[key]!);
      expect({ key, got: bill?.hasDocument }).toEqual({ key, got: want });
    }
  });

  it('the "Missing document" filter is the complement of the flag', async () => {
    const { invoices: rows } = await getSupplierInvoices(fx.companyId, { limit: 200, missingDocument: true });
    const missing = new Set(rows.map((r) => r.id));
    for (const [key, want] of Object.entries(EXPECT_BILLS)) expect({ key, missing: missing.has(bills[key]!) }).toEqual({ key, missing: !want });
  });

  it('customer invoices: list and detail rows carry the same computed has_document', async () => {
    const want: Record<string, boolean> = { none: false, upload: true, captured: true, capturedNoBytes: false };
    const { invoices: rows } = await listCustomerInvoices(fx.companyId, { limit: 100 });
    const byId = new Map(rows.map((r) => [String(r.id), r.has_document]));
    for (const [key, w] of Object.entries(want)) {
      expect({ key, list: byId.get(invoices[key]!) }).toEqual({ key, list: w });
      expect({ key, detail: (await getCustomerInvoiceDetail(fx.companyId, invoices[key]!))?.has_document }).toEqual({ key, detail: w });
    }
  });
});
