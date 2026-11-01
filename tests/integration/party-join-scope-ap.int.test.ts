// tests/integration/party-join-scope-ap.int.test.ts
//
// AP readers on a document of company A naming company B's supplier: every id
// on these rows is a bare id or a bare FK to suppliers(id), so the row can exist
// and the join is what keeps B's name out. The row itself stays, unlabelled or
// under UNKNOWN_SUPPLIER; A's own row keeps A's name.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropAgingScope, newAgingScope, seedAgingScope } from '../helpers/agingScopeFixture';
import { docNo, dropPartyDocs, seedPartyDocs, type PartyDocs } from '../helpers/partyJoinScopeFixture';
import { getSupplierInvoiceById } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { UNKNOWN_SUPPLIER } from '@/modules/accounting/services/ap/apAgingInvoices';
import { generateSupplierInvoicePdf } from '@/modules/accounting/services/ap/supplierInvoicePdfBuilder';
import { generatePurchaseOrderPdf } from '@/modules/accounting/services/ap/purchaseOrderPdfBuilder';
import { getSupplierPaymentById, getSupplierPayments } from '@/modules/accounting/services/ap/supplierPaymentService';
import { listAlerts } from '@/modules/accounting/services/capture/supplierGraphService';
import { getReconciliation, listReconciliations } from '@/modules/accounting/services/capture/supplierStatementReconService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const S = newAgingScope();
const OK_NAME = `Tenant A Supplier ${S.TAG}`;

describeIfDb('AP readers keep another tenant\'s supplier name out', () => {
  let admin: Pool;
  let docs: PartyDocs;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes company, supplier and document fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await seedAgingScope(admin, S);
    docs = await seedPartyDocs(admin, S);
    await admin.query(`UPDATE suppliers SET company_name = name WHERE id = ANY($1)`, [[S.SUPP_A, S.SUPP_B]]);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await dropPartyDocs(admin, S);
    await dropAgingScope(admin, S);
    await admin.end();
  }, 60000);

  it('getSupplierInvoiceById labels a foreign supplier UNKNOWN_SUPPLIER and keeps A\'s own name', async () => {
    const bad = await getSupplierInvoiceById(S.A, docs.POISONED.apInvoice);
    expect(bad?.supplierName).toBe(UNKNOWN_SUPPLIER);
    expect(JSON.stringify(bad)).not.toContain(S.LEAK_SUPPLIER);
    const ok = await getSupplierInvoiceById(S.A, docs.OK.apInvoice);
    expect(ok?.supplierName).toBe(OK_NAME);
  });

  it('the supplier invoice PDF shows neither B\'s supplier nor its bank details', async () => {
    await admin.query(`UPDATE suppliers SET bank_name = $2 WHERE id = $1`, [S.SUPP_B, `BANK ${S.TAG}`]);
    const pdf = (await generateSupplierInvoicePdf(S.A, docs.POISONED.apInvoice)).toString('latin1');
    expect(pdf).not.toContain(S.LEAK_SUPPLIER);
    expect(pdf).not.toContain(`BANK ${S.TAG}`);
    expect(pdf).toContain('Unknown Supplier');
    expect((await generateSupplierInvoicePdf(S.A, docs.OK.apInvoice)).toString('latin1')).toContain(OK_NAME);
  });

  it('the purchase order PDF does not name B\'s supplier', async () => {
    const pdf = (await generatePurchaseOrderPdf(S.A, docs.POISONED.supplierPo)).toString('latin1');
    expect(pdf).not.toContain(S.LEAK_SUPPLIER);
    expect(pdf).toContain('Unknown Supplier');
    expect((await generatePurchaseOrderPdf(S.A, docs.OK.supplierPo)).toString('latin1')).toContain(OK_NAME);
  });

  it.each([
    ['no filter', {}],
    ['status', { status: 'processed' }],
  ])('getSupplierPayments (%s) keeps both rows, B\'s name on neither', async (_l, filters) => {
    const { payments } = await getSupplierPayments(S.A, filters as never);
    const byNumber = new Map(payments.map((p) => [p.paymentNumber, p.supplierName]));
    expect(byNumber.get(docNo(S, 'SP', 'OK'))).toBe(OK_NAME);
    expect(byNumber.has(docNo(S, 'SP', 'POISONED'))).toBe(true);
    expect(byNumber.get(docNo(S, 'SP', 'POISONED'))).toBeUndefined();
  });

  it.each([
    ['supplierId', { supplierId: S.SUPP_B }],
    ['supplierId + status', { supplierId: S.SUPP_B, status: 'processed' }],
  ])('getSupplierPayments (%s) finds the poisoned row and not B\'s name', async (_l, filters) => {
    const { payments } = await getSupplierPayments(S.A, filters as never);
    expect(payments.map((p) => p.paymentNumber)).toEqual([docNo(S, 'SP', 'POISONED')]);
    expect(JSON.stringify(payments)).not.toContain(S.LEAK_SUPPLIER);
  });

  it('getSupplierPaymentById does not name B\'s supplier', async () => {
    const p = await getSupplierPaymentById(S.A, docs.POISONED.supplierPayment);
    expect(p?.paymentNumber).toBe(docNo(S, 'SP', 'POISONED'));
    expect(JSON.stringify(p)).not.toContain(S.LEAK_SUPPLIER);
  });

  it('listAlerts keeps the alert under UNKNOWN_SUPPLIER', async () => {
    const alerts = await listAlerts(S.A);
    const bad = alerts.find((a) => a.signalType === docNo(S, 'FA', 'POISONED'));
    expect(bad?.supplierName).toBe(UNKNOWN_SUPPLIER);
    expect(alerts.find((a) => a.signalType === docNo(S, 'FA', 'OK'))?.supplierName).toBe(OK_NAME);
  });

  it('listReconciliations keeps the reconciliation under UNKNOWN_SUPPLIER', async () => {
    const rows = await listReconciliations(S.A);
    expect(rows.map((r) => r.supplierName).sort()).toEqual([OK_NAME, UNKNOWN_SUPPLIER].sort());
  });

  it('getReconciliation opens the poisoned reconciliation under UNKNOWN_SUPPLIER', async () => {
    const bad = await getReconciliation(S.A, docs.POISONED.recon);
    expect(bad?.supplierName).toBe(UNKNOWN_SUPPLIER);
    expect((await getReconciliation(S.A, docs.OK.recon))?.supplierName).toBe(OK_NAME);
  });
});
