// R-127 — the paths that approve a captured invoice WITHOUT approveSupplierInvoice.
//
// ai-invoice-pipeline and capture/[id]/post INSERT the invoice as 'approved' on
// the auto-approve route, with no journal, and then run the evidence attach. If
// that attach turns a provisional into the slip's evidence, the ledger already
// holds the bill (expense / VAT / bank) while the AP subledger shows it owing —
// and the "Post to GL" action (postSupplierInvoiceToGL) would then post the
// bill a second time. These paths must end where approval does: the invoice's
// journal, the provisional reclassed into its payment, the invoice paid.
import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import pipelineRoute from '../../pages/api/accounting/ai-invoice-pipeline';
import capturePostRoute from '../../pages/api/accounting/capture/[id]/post';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { runCapturePostFollowUps } from '@/modules/accounting/services/capture/capturePostFollowUps';
import { getAPAgingDetail } from '@/modules/accounting/services/ap/apAgingService';
import { request, response } from './mfa-impersonation-postgres.helpers';
import {
  company, inTx, invoiceState, jeState, paymentsFor, pool, seedDoc, seedInvoice, seedProvisional,
  slipLedger, supplier, today, useR127Fixture, user,
} from './r127-double-booking.helpers';

useR127Fixture();

let token = '';
beforeAll(async () => {
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

// checkAiRateLimit keys on the IP with a persistent counter; one address per run.
const clientIp = `127.2.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

async function runPipeline(documentId: string) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
  (req.socket as { remoteAddress: string }).remoteAddress = clientIp;
  req.url = '/api/accounting/ai-invoice-pipeline';
  req.body = { documentId };
  const result = response();
  await pipelineRoute(req as never, result.res as never);
  return result.state;
}

/** An unclaimed captured slip whose extraction the pipeline auto-approves (clean, low value). */
async function seedExtractedDoc(total: number): Promise<string> {
  const id = crypto.randomUUID();
  const net = Math.round((total / 1.15) * 100) / 100;
  const vat = Math.round((total - net) * 100) / 100;
  const extracted = {
    documentType: 'invoice', vendorName: 'R127 Supplies CC', date: today,
    referenceNumber: `R127-${id.slice(0, 8)}`, currency: 'ZAR', subtotal: net, vatAmount: vat, vatRate: 15,
    totalAmount: total, lineItems: [{ description: 'Stationery', quantity: 1, unitPrice: net, total: net }],
    rawText: `TAX INVOICE\nSub Total ${net.toFixed(2)}\nVAT ${vat.toFixed(2)}\nTotal ${total.toFixed(2)}`,
    confidence: 0.9, warnings: [], extractionMethod: 'vlm',
  };
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
     VALUES($1,$2,$3,'application/pdf','invoice',$4::jsonb,'pending')`,
    [id, company, `r127-${id}.pdf`, JSON.stringify(extracted)],
  );
  return id;
}

/**
 * Files this month's VAT period, so the bank date and the slip date are both
 * filed and the settlement is refused. Returns the unlock. capture/[id]/post
 * used to fail its settlement for want of line items (R-131); it writes them now.
 */
async function fileThisMonth(): Promise<() => Promise<void>> {
  const monthStart = `${today.slice(0, 8)}01`;
  const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const lock = (await pool.query(
    `INSERT INTO vat_period_locks(company_id,period_start,period_end,output_tax,input_tax,net_vat,posted_through,locked_by,actor_type)
     VALUES($1,$2,$3,0,0,0,NOW(),$4,'human') RETURNING id`, [company, monthStart, monthEnd, user])).rows[0].id as string;
  return async () => {
    await pool.query('UPDATE vat_period_locks SET unlocked_at=NOW(), unlocked_by=$2, unlock_reason=$3 WHERE id=$1',
      [lock, user, 'R127 test cleanup']);
  };
}

async function invoiceForDoc(documentId: string): Promise<string> {
  const { rows } = await pool.query(
    'SELECT id FROM supplier_invoices WHERE company_id=$1 AND source_document_id=$2', [company, documentId],
  );
  expect(rows).toHaveLength(1);
  return String(rows[0].id);
}

describe('R-127: auto-approved captured invoices settle against the provisional they evidence', () => {
  it('ai-invoice-pipeline: an auto-approved slip that evidences a provisional ends paid, booked once', async () => {
    const { je, bt } = await seedProvisional({ totalAmount: 402.50, supplierId: supplier });
    const doc = await seedExtractedDoc(402.50);

    const res = await runPipeline(doc);
    expect(res.statusCode).toBe(200);
    const body = res.body as { data: { invoice: { status: string }; provisionalAttach: { attachedJeId: string | null } } };
    expect(body.data.provisionalAttach.attachedJeId).toBe(je);

    const invoiceId = await invoiceForDoc(doc);
    const inv = await invoiceState(invoiceId);
    expect(inv.gl_journal_entry_id).not.toBeNull();
    expect(inv.status).toBe('paid');
    expect(inv.paid).toBe(402.50);
    const payments = await paymentsFor(bt, invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.allocated).toBe(402.50);
    expect(await slipLedger(je, bt, invoiceId)).toEqual({ expense: 350.00, vat: 52.50, ap: 0, bank: -402.50 });
  });

  it('capture/[id]/post shape (approved, no line items): an unsettleable auto-approval goes back to draft, off AP', async () => {
    const { je, bt } = await seedProvisional({ totalAmount: 403.65, supplierId: supplier });
    const doc = await seedDoc();
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 403.65, status: 'approved', withItems: false });
    // As an approval leaves it: who approved it, and when.
    await pool.query('UPDATE supplier_invoices SET approved_by=$2, approved_at=NOW() WHERE id=$1', [invoiceId, user]);

    const out = await inTx(() => runCapturePostFollowUps({
      companyId: company, userId: user, eventId: crypto.randomUUID(), documentId: doc, invoiceId,
      invoiceStatus: 'approved', supplierId: supplier, supplierName: 'R127 Supplies CC',
      vendorVatNumber: null, totalAmount: 403.65, invoiceDate: today,
      decision: { outcome: 'route_review', reasons: ['test'], rule: null },
    }));
    expect(out.provisionalAttach.attachedJeId).toBe(je);

    // The invoice survived the request's COMMIT, its attach included. With no line
    // items it cannot post a journal (a separate defect, see R-127 fix.md). Left
    // 'approved', it read as owing a bill the provisional already paid — and paying
    // it would pay twice — so its auto-approval is withdrawn: DRAFT, with the reason
    // on the bill and in the response, and nothing booked a second time.
    const inv = await invoiceState(invoiceId);
    expect(inv).toBeDefined();
    expect(inv.status).toBe('draft');
    expect(inv.gl_journal_entry_id).toBeNull();
    expect(out.provisionalAttach.settlementRefused).toMatch(/.+/);
    const approval = (await pool.query('SELECT approved_by, approved_at FROM supplier_invoices WHERE id=$1', [invoiceId])).rows[0];
    expect(approval).toEqual({ approved_by: null, approved_at: null });
    const notes = String((await pool.query('SELECT notes FROM supplier_invoices WHERE id=$1', [invoiceId])).rows[0].notes);
    expect(notes).toMatch(/provisional/i);
    const ageing = await getAPAgingDetail(company, supplier);
    expect(ageing.invoices.map((i) => i.invoiceNumber)).not.toContain(
      (await pool.query('SELECT invoice_number FROM supplier_invoices WHERE id=$1', [invoiceId])).rows[0].invoice_number);
    expect((await jeState(je)).source_document_id).toBe(doc);
    expect(await paymentsFor(bt, invoiceId)).toHaveLength(0);
    expect(await slipLedger(je, bt, invoiceId)).toEqual({ expense: 351.00, vat: 52.65, ap: 0, bank: -403.65 });
  });

  it('a settlement that fails AFTER the invoice journal posted rolls back whole, and only itself', async () => {
    const { je, bt } = await seedProvisional({ totalAmount: 405.95, supplierId: supplier });
    const doc = await seedDoc();
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 405.95, status: 'approved' });
    // Fixture-only fault: the payment INSERT — after the invoice journal and the
    // reclass have posted — raises, which aborts the transaction it runs in.
    await pool.query(`CREATE OR REPLACE FUNCTION r127_fail_payment() RETURNS trigger LANGUAGE plpgsql
                      AS $$ BEGIN RAISE EXCEPTION 'r127 injected failure'; END $$`);
    await pool.query(`CREATE TRIGGER r127_fail_payment BEFORE INSERT ON supplier_payments FOR EACH ROW
                      WHEN (NEW.company_id = '${company}'::uuid AND NEW.total_amount = 405.95)
                      EXECUTE FUNCTION r127_fail_payment()`);
    try {
      const out = await inTx(() => runCapturePostFollowUps({
        companyId: company, userId: user, eventId: crypto.randomUUID(), documentId: doc, invoiceId,
        invoiceStatus: 'approved', supplierId: supplier, supplierName: 'R127 Supplies CC',
        vendorVatNumber: null, totalAmount: 405.95, invoiceDate: today,
        decision: { outcome: 'route_review', reasons: ['test'], rule: null },
      }));
      expect(out.provisionalAttach.attachedJeId).toBe(je);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS r127_fail_payment ON supplier_payments');
      await pool.query('DROP FUNCTION IF EXISTS r127_fail_payment()');
    }

    // The attach committed with the request; the half-done settlement did not —
    // no invoice journal left standing beside the provisional.
    expect((await jeState(je)).source_document_id).toBe(doc);
    const inv = await invoiceState(invoiceId);
    expect(inv.status).toBe('draft');
    expect(inv.gl_journal_entry_id).toBeNull();
    expect(await slipLedger(je, bt, invoiceId)).toEqual({ expense: 353.00, vat: 52.95, ap: 0, bank: -405.95 });
  });

  it('Post to GL on an approved, unposted invoice whose slip evidences a provisional settles it', async () => {
    const doc = await seedDoc();
    const { je, bt } = await seedProvisional({ totalAmount: 404.80, evidencedBy: doc });
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 404.80, status: 'approved' });

    const posted = await inTx(() => postSupplierInvoiceToGL(company, invoiceId, user));
    expect(posted.alreadyPosted).toBe(false);

    const inv = await invoiceState(invoiceId);
    expect(inv.status).toBe('paid');
    expect(inv.paid).toBe(404.80);
    expect(await slipLedger(je, bt, invoiceId)).toEqual({ expense: 352.00, vat: 52.80, ap: 0, bank: -404.80 });
  });

  it('capture/[id]/post answers the bill\'s status as it ends — draft when its settlement was refused', async () => {
    await seedProvisional({ totalAmount: 1406.50, supplierId: supplier });
    const doc = await seedExtractedDoc(1406.50);
    const eventId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO capture_events(id,company_id,channel,status,captured_document_id) VALUES($1,$2,'api','extracted',$3)",
      [eventId, company, doc]);
    const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
    req.url = `/api/accounting/capture/${eventId}/post`;
    (req as unknown as { query: Record<string, string> }).query = { id: eventId };
    req.body = {};
    const res = response();
    const unlock = await fileThisMonth();
    try {
      await capturePostRoute(req as never, res.res as never);
    } finally {
      await unlock();
    }
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const invoiceId = await invoiceForDoc(doc);
    // Both dates are filed, so the settlement is refused and the auto-approval
    // is withdrawn — and the response must not still say 'approved'.
    expect((await invoiceState(invoiceId)).status).toBe('draft');
    expect((res.state.body as { data: { invoice: { status: string } } }).data.invoice.status).toBe('draft');
    // The auto-approval was withdrawn: the route it reports is the one needing a human.
    expect((res.state.body as { data: { approvalRoute: string } }).data.approvalRoute).toBe('manual_review');
  });

  it('ai-invoice-pipeline answers draft when the settlement of its auto-approval is refused', async () => {
    await seedProvisional({ totalAmount: 2407.65, supplierId: supplier });
    const doc = await seedExtractedDoc(2407.65);
    const monthStart = `${today.slice(0, 8)}01`;
    const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
    // Both the bank date and the slip date are filed: the settlement is refused.
    const lock = (await pool.query(
      `INSERT INTO vat_period_locks(company_id,period_start,period_end,output_tax,input_tax,net_vat,posted_through,locked_by,actor_type)
       VALUES($1,$2,$3,0,0,0,NOW(),$4,'human') RETURNING id`, [company, monthStart, monthEnd, user])).rows[0].id as string;
    try {
      const res = await runPipeline(doc);
      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
      const invoiceId = await invoiceForDoc(doc);
      expect((await invoiceState(invoiceId)).status).toBe('draft');
      expect((res.body as { data: { invoice: { status: string } } }).data.invoice.status).toBe('draft');
      expect((res.body as { data: { approvalRoute: string } }).data.approvalRoute).toBe('manual_review');
    } finally {
      await pool.query('UPDATE vat_period_locks SET unlocked_at=NOW(), unlocked_by=$2, unlock_reason=$3 WHERE id=$1',
        [lock, user, 'R127 test cleanup']);
    }
  });

  it('capture/[id]/post FAILS the request (≥500, nothing kept) when withdrawing the auto-approval fails', async () => {
    await seedProvisional({ totalAmount: 3408.80, supplierId: supplier });
    const doc = await seedExtractedDoc(3408.80);
    const eventId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO capture_events(id,company_id,channel,status,captured_document_id) VALUES($1,$2,'api','extracted',$3)",
      [eventId, company, doc]);
    // Fixture-only fault: the approved → draft revert raises, aborting the request transaction.
    await pool.query(`CREATE OR REPLACE FUNCTION r127_fail_revert() RETURNS trigger LANGUAGE plpgsql
                      AS $$ BEGIN RAISE EXCEPTION 'r127 injected revert failure'; END $$`);
    await pool.query(`CREATE TRIGGER r127_fail_revert BEFORE UPDATE ON supplier_invoices FOR EACH ROW
                      WHEN (OLD.status = 'approved' AND NEW.status = 'draft' AND NEW.company_id = '${company}'::uuid)
                      EXECUTE FUNCTION r127_fail_revert()`);
    const res = response();
    const unlock = await fileThisMonth();
    try {
      const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
      req.url = `/api/accounting/capture/${eventId}/post`;
      (req as unknown as { query: Record<string, string> }).query = { id: eventId };
      req.body = {};
      await capturePostRoute(req as never, res.res as never);
    } finally {
      await unlock();
      await pool.query('DROP TRIGGER IF EXISTS r127_fail_revert ON supplier_invoices');
      await pool.query('DROP FUNCTION IF EXISTS r127_fail_revert()');
    }
    // Not a 200 over a COMMIT that silently became a ROLLBACK.
    expect(res.state.statusCode).toBeGreaterThanOrEqual(500);
    const kept = await pool.query('SELECT id FROM supplier_invoices WHERE company_id=$1 AND source_document_id=$2', [company, doc]);
    expect(kept.rows).toHaveLength(0);
    const event = (await pool.query('SELECT status FROM capture_events WHERE id=$1', [eventId])).rows[0].status as string;
    expect(event).toBe('extracted');
  });
});
