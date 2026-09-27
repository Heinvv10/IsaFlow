/**
 * R-035 PR2: the paths that approve a supplier invoice with nobody deciding at
 * that moment (design A4–A6, B1–B2, test 8), and the MCP half of test 3.
 *
 *  - MCP approve_supplier_invoice refuses a gated bill as a tool error from a
 *    pre-read: nothing posted, and the idempotency key stays free (Q6: an agent
 *    neither submits nor decides approvals).
 *  - MCP bulk_approve_supplier_invoices skips it with an approval_required reason.
 *  - A recurring autoPost template leaves the bill a draft, raises a request as
 *    the runner, and reports posted:false.
 *  - capture/[id]/post and ai-invoice-pipeline, which INSERT an auto-approved
 *    bill as 'approved', insert it as a DRAFT with a pending request instead —
 *    absent from the AP ageing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { als } from '../../src/lib/als';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { approveSupplierInvoiceTool } from '../../src/lib/mcp/tools/writeSupplierInvoices';
import { bulkApproveSupplierInvoicesTool } from '../../src/lib/mcp/tools/writeBulkApproveSupplierInvoices';
import { updateSupplierInvoiceTool } from '../../src/lib/mcp/tools/writeUpdateSupplierInvoice';
import recurringExecute from '../../pages/api/accounting/recurring-transactions-execute';
import { getAPAgingDetail } from '../../src/modules/accounting/services/ap/apAgingService';
import pipelineRoute from '../../pages/api/accounting/ai-invoice-pipeline';
import capturePostRoute from '../../pages/api/accounting/capture/[id]/post';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantBill, plantRule, reasonOf, type Bill } from './r035-approval.helpers';
import { billState, cleanupPr2, dataOf, enforce, postableCompany, routes } from './r035-pr2.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = routes(tokens);
const templates: string[] = [];

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(async () => {
  await pool.query('DELETE FROM recurring_transaction_templates WHERE id = ANY($1)', [templates]);
  await pool.query('DELETE FROM supplier_coding_history WHERE company_id = ANY($1)', [companies]);
  await pool.query('UPDATE captured_documents SET matched_invoice_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM capture_events WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ANY($1))', [companies]);
  await pool.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM company_document_numbers WHERE company_id = ANY($1)', [companies]);
  await cleanupPr2(pool, companies, Object.values(u));
});

/** A (admin) runs and captures; B (owner) approves. Owner rule on every bill, enforced. */
async function fixture(): Promise<{ c: string; bill: Bill }> {
  const c = await postableCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  await plantRule(pool, c, 'owner');
  await enforce(pool, c, u.b);
  return { c, bill: await plantBill(pool, c, u.a) };
}

async function asUser<T>(userId: string, companyId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId, companyId, claims: { sub: userId } } as never, fn);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const registry = new McpRegistry();
registry.register(approveSupplierInvoiceTool);
registry.register(bulkApproveSupplierInvoicesTool);
const mcp = (c: string, name: string, args: Record<string, unknown>) => asUser(u.a, c, () => registry.call(name, args,
  { userId: u.a, companyId: c, scopes: ['write:invoices', 'write:post'], tokenJti: 'r035-pr2', oauthAppId: null }));
const text = (res: { content: { text: string }[] }) => res.content[0]!.text;

async function approvedByB(c: string, billId: string): Promise<void> {
  const raised = await r.raise(u.a, c, billId);
  expect(raised.state.statusCode).toBe(200);
  expect((await r.decide(pool, u.b, c, dataOf<{ id: string }>(raised).id)).state.statusCode).toBe(200);
}

const pendingRequests = async (billId: string) => (await pool.query(
  "SELECT requested_by FROM approval_requests WHERE document_id = $1 AND status = 'pending'", [billId])).rows;

describe('MCP (A4, A5, Q6)', () => {
  it('approve_supplier_invoice refuses a gated bill before writing, and leaves its idempotency key free', async () => {
    const { c, bill } = await fixture();
    const key = `r035-${bill.id}`;
    const refused = await mcp(c, 'approve_supplier_invoice', { invoice_id: bill.id, idempotency_key: key });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/needs owner approval/);
    // Refused from the tool's own pre-read, which tells the agent it cannot fix this itself (Q6).
    expect(text(refused)).toMatch(/cannot raise or decide approvals/);
    expect(await billState(pool, bill.id)).toEqual({ status: 'draft', gl_journal_entry_id: null, journals: 0 });

    await approvedByB(c, bill.id);
    const posted = await mcp(c, 'approve_supplier_invoice', { invoice_id: bill.id, idempotency_key: key });
    expect(posted.isError, text(posted)).toBeFalsy();
    expect((await billState(pool, bill.id)).status).toBe('approved');
  });

  it('bulk_approve_supplier_invoices skips the gated bill and posts its cleared sibling', async () => {
    const { c, bill } = await fixture();
    const cleared = await plantBill(pool, c, u.a);
    await approvedByB(c, cleared.id);
    const res = await mcp(c, 'bulk_approve_supplier_invoices', { invoice_ids: [bill.id, cleared.id], idempotency_key: `r035-bulk-${bill.id}` });
    expect(res.isError, text(res)).toBeFalsy();
    const body = JSON.parse(text(res)) as { posted: number; skipped: { document_id: string; reason: string }[] };
    expect(body.posted).toBe(1);
    expect(body.skipped).toEqual([expect.objectContaining({ document_id: bill.id, reason: expect.stringMatching(/^approval_required/) })]);
    expect((await billState(pool, bill.id)).journals).toBe(0);
  });

  it('an MCP line edit after approval makes the approval stale (test 3, MCP half)', async () => {
    const { c, bill } = await fixture();
    await approvedByB(c, bill.id);
    const edited = await asUser(u.a, c, () => updateSupplierInvoiceTool.handler({
      invoice_id: bill.id, idempotency_key: `r035-edit-${bill.id}`,
      lines: [
        { description: 'Line A', quantity: 2, unit_price: 300, tax_rate: 15, gl_account_id: bill.accountB },
        { description: 'Line B', quantity: 1, unit_price: 400, tax_rate: 15, gl_account_id: bill.accountB },
      ],
    }, { companyId: c, userId: u.a, tokenJti: 'r035' } as never));
    expect(edited.isError, JSON.stringify(edited)).toBeFalsy();
    const res = await r.approveBill(u.a, c, bill.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_STALE');
  });
});

describe('recurring autoPost (A6)', () => {
  it('leaves the bill a draft with a pending request raised by the runner, and reports posted:false', async () => {
    const { c, bill } = await fixture();
    const id = crypto.randomUUID();
    templates.push(id);
    await pool.query(
      `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,auto_post,created_by)
       VALUES($1,$2,'R035 AP auto-post','supplier_invoice',$3,'daily',true,$4)`,
      [id, c, JSON.stringify({ supplierId: bill.supplierId, subtotal: 100, vatAmount: 15, totalAmount: 115,
        lines: [{ description: 'Retainer', quantity: 1, unitPrice: 100, taxRate: 15, lineTotal: 100, accountId: bill.accountA }] }), u.a]);
    const res = await callRoute(recurringExecute, tokens[u.a]!, c, 'POST', { templateId: id }, '/api/accounting/recurring-transactions-execute');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const result = dataOf<{ entityId: string; posted: boolean }>(res);
    expect(result.posted).toBe(false);
    expect(await billState(pool, result.entityId)).toMatchObject({ status: 'draft', journals: 0 });
    expect(await pendingRequests(result.entityId)).toEqual([{ requested_by: u.a }]);
  });
});

describe('capture and the AI pipeline (B1, B2)', () => {
  const clientIp = `127.3.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

  async function extractedDoc(c: string): Promise<{ doc: string; supplier: string }> {
    const supplier = crypto.randomUUID();
    const name = `R035 Capture ${supplier.slice(0, 6)} CC`;
    await pool.query("INSERT INTO suppliers(id,company_id,name,vat_number,is_active) VALUES($1,$2,$3,'4999999999',true)", [supplier, c, name]);
    const doc = crypto.randomUUID();
    const extracted = {
      documentType: 'invoice', vendorName: name, date: '2026-09-10', referenceNumber: `R035-${doc.slice(0, 8)}`,
      currency: 'ZAR', subtotal: 300, vatAmount: 45, vatRate: 15, totalAmount: 345,
      lineItems: [{ description: 'Stationery', quantity: 1, unitPrice: 300, total: 300 }],
      rawText: 'TAX INVOICE\nSub Total 300.00\nVAT 45.00\nTotal 345.00', confidence: 0.95, warnings: [], extractionMethod: 'vlm',
    };
    await pool.query(
      `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
       VALUES($1,$2,$3,'application/pdf','invoice',$4::jsonb,'pending')`, [doc, c, `r035-${doc}.pdf`, JSON.stringify(extracted)]);
    return { doc, supplier };
  }

  const token = (user: string) => new SignJWT({ sub: user, aal: 'aal2', session_id: crypto.randomUUID() })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

  async function billFor(c: string, doc: string): Promise<string> {
    const { rows } = await pool.query('SELECT id FROM supplier_invoices WHERE company_id = $1 AND source_document_id = $2', [c, doc]);
    expect(rows).toHaveLength(1);
    return String(rows[0].id);
  }

  async function assertHeldForApproval(c: string, supplier: string, billId: string): Promise<void> {
    expect(await billState(pool, billId)).toMatchObject({ status: 'draft', journals: 0 });
    expect(await pendingRequests(billId)).toEqual([{ requested_by: u.a }]);
    const ageing = await asUser(u.a, c, () => getAPAgingDetail(c, supplier));
    expect(ageing.invoices).toEqual([]);
  }

  it('capture/[id]/post inserts a draft and raises the request', async () => {
    const { c } = await fixture();
    const { doc, supplier } = await extractedDoc(c);
    const eventId = crypto.randomUUID();
    await pool.query("INSERT INTO capture_events(id,company_id,channel,status,captured_document_id) VALUES($1,$2,'api','extracted',$3)", [eventId, c, doc]);
    const req = request({ 'sb-access-token': await token(u.a), active_company_id: c }, 'POST');
    req.url = `/api/accounting/capture/${eventId}/post`;
    (req as unknown as { query: Record<string, string> }).query = { id: eventId };
    req.body = {};
    const res = response();
    await capturePostRoute(req as never, res.res as never);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    await assertHeldForApproval(c, supplier, await billFor(c, doc));
  });

  it('ai-invoice-pipeline inserts a draft and raises the request', async () => {
    const { c } = await fixture();
    const { doc, supplier } = await extractedDoc(c);
    const req = request({ 'sb-access-token': await token(u.a), active_company_id: c }, 'POST');
    (req.socket as { remoteAddress: string }).remoteAddress = clientIp;
    req.url = '/api/accounting/ai-invoice-pipeline';
    req.body = { documentId: doc };
    const res = response();
    await pipelineRoute(req as never, res.res as never);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    await assertHeldForApproval(c, supplier, await billFor(c, doc));
  });
});
