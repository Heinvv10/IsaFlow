/**
 * K-072 round 30. A captured bill whose VAT the extraction never read.
 *
 * `buildInvoiceFromExtraction` used to INVENT 15/115 of the total as such a
 * draft's `tax_amount` (130.43 on a R1 000 non-VAT garden service), and the MCP
 * approve tools could then post it as input VAT with nobody looking. Proved
 * here against the DB, by outcome:
 *
 *   - BOTH capture routes (`capture/[id]/post`, `ai-invoice-pipeline`) store
 *     tax 0 at a 0% rate, lines included, and the note saying why;
 *   - BOTH MCP approve tools refuse that draft and post nothing — and a LEGACY
 *     draft still carrying the invented 130.43 too, because the refusal reads
 *     the captured document, not the draft;
 *   - the other direction: a captured bill whose VAT WAS read is approved by
 *     the same tool, and its journal posts that VAT.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { SignJWT } from 'jose';
import post from '../../pages/api/accounting/capture/[id]/post';
import pipeline from '../../pages/api/accounting/ai-invoice-pipeline';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { als } from '@/lib/als';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { VAT_UNREAD_NOTE } from '@/modules/accounting/services/core/aiInvoicePipelineService';
import { approveSupplierInvoiceTool } from '@/lib/mcp/tools/writeSupplierInvoices';
import { bulkApproveSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkApproveSupplierInvoices';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const supplier = crypto.randomUUID();
let adminToken = '';
const ctx = { userId: admin, companyId: company, scopes: ['write:invoices', 'write:post'], tokenJti: 'jti', oauthAppId: null } as McpToolContext;

/** A non-VAT vendor's bill: the model read no VAT, because none is printed. */
const NO_VAT = {
  documentType: 'invoice', vendorName: 'K072 Garden Services', date: '2026-04-10', totalAmount: 1000,
  subtotal: null, vatAmount: null, confidence: 0.99, lineItems: [], warnings: [],
  rawText: 'K072 Garden Services\nINVOICE\nGarden service September 1 1000.00 1000.00\nAmount Due 1000.00',
};

async function seedDocument(extracted: Record<string, unknown>, tag: string): Promise<string> {
  const documentId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,extracted_data,status)
     VALUES($1,$2,$3,'pdf',$4::jsonb,'pending')`,
    [documentId, company, `k072-${tag}.pdf`, JSON.stringify({ ...extracted, referenceNumber: `K072-${tag}` })],
  );
  return documentId;
}

async function callRoute(handler: typeof post, query: Record<string, string>, body: unknown) {
  const req = request({ 'sb-access-token': adminToken, active_company_id: company }, 'POST') as never as {
    url: string; body: unknown; query: Record<string, string>;
  };
  req.url = '/api/accounting/capture/x';
  req.query = query;
  req.body = body;
  const result = response();
  await handler(req as never, result.res);
  return result.state;
}

async function invoiceFor(documentId: string) {
  const { rows } = await pool.query(
    `SELECT si.id, si.status, si.tax_amount::float8 AS tax, si.tax_rate::float8 AS rate, si.subtotal::float8 AS sub,
            si.notes, (SELECT COALESCE(SUM(tax_amount),0)::float8 FROM supplier_invoice_items WHERE supplier_invoice_id = si.id) AS line_tax
       FROM supplier_invoices si WHERE si.company_id=$1 AND si.source_document_id=$2`,
    [company, documentId],
  );
  return rows;
}

/** An MCP tool call inside one transaction, as the registry runs it. */
async function tool(fn: () => Promise<McpToolResult>): Promise<McpToolResult> {
  const client: PoolClient = await pool.connect();
  await client.query('BEGIN');
  try {
    const out = await als.run({ client, userId: admin, companyId: company, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

async function draftFor(documentId: string, tax: number, total: number, tag: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO supplier_invoices(company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_rate,tax_amount,
       total_amount,status,created_by,source_document_id)
     VALUES($1,$2,$3,'2026-04-10',$4,15,$5,$6,'draft',$7,$8) RETURNING id`,
    [company, supplier, `K072-${tag}`, total - tax, tax, total, admin, documentId],
  );
  await pool.query(
    `INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,tax_rate,tax_amount,line_total)
     VALUES($1,'Service',1,$2,15,$3,$2)`, [rows[0].id, total - tax, tax],
  );
  return rows[0].id as string;
}

async function account(code: string, name: string, type: string, subtype: string, normal: string) {
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active,is_system_account) VALUES($1,$2,$3,$4,$5,$6,true,true)`,
    [company, code, name, type, subtype, normal],
  );
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K072 VAT unread fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [company, admin, 'admin']);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K072 FY',1,2026,'2026-01-01','2026-12-31','open')`, [company],
  );
  await account('6000', 'K072 Expense', 'expense', 'default_expense', 'debit');
  await account('1300', 'K072 VAT Input', 'asset', 'vat_input', 'debit');
  await account('2000', 'K072 Payables', 'liability', 'payable', 'credit');
  clearSystemAccountCache(company);
  await pool.query('INSERT INTO suppliers(id,company_id,name,is_active) VALUES($1,$2,$3,true)', [supplier, company, 'K072 Garden Services']);
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  adminToken = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(secret);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id=NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM capture_events WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

it('capture/[id]/post: a bill with no VAT read is a DRAFT with no VAT, a 0% rate and the note', async () => {
  const documentId = await seedDocument(NO_VAT, 'post');
  const eventId = crypto.randomUUID();
  await pool.query(`INSERT INTO capture_events(id,company_id,channel,status,captured_document_id) VALUES($1,$2,'api','extracted',$3)`,
    [eventId, company, documentId]);
  const res = await callRoute(post, { id: eventId }, {});
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  expect(await invoiceFor(documentId)).toEqual([expect.objectContaining(
    { status: 'draft', tax: 0, rate: 0, sub: 1000, notes: VAT_UNREAD_NOTE, line_tax: 0 })]);
});

it('ai-invoice-pipeline: the same bill, the same draft', async () => {
  const documentId = await seedDocument({ ...NO_VAT, totalAmount: 1010, rawText: NO_VAT.rawText.replace(/1000/g, '1010') }, 'pipe');
  const res = await callRoute(pipeline, {}, { documentId });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  expect(await invoiceFor(documentId)).toEqual([expect.objectContaining(
    { status: 'draft', tax: 0, rate: 0, sub: 1010, notes: VAT_UNREAD_NOTE, line_tax: 0 })]);
});

it('the MCP approve tools refuse a draft whose captured VAT was never read — a legacy invented 130.43 included', async () => {
  const documentId = await seedDocument(NO_VAT, 'legacy');
  const invoiceId = await draftFor(documentId, 130.43, 1000, 'legacy');

  const single = await tool(() => approveSupplierInvoiceTool.handler({ invoice_id: invoiceId, idempotency_key: 'k1' }, ctx));
  expect(single.isError).toBe(true);
  expect(single.content[0]!.text).toMatch(/VAT was never read/);

  const bulk = await tool(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [invoiceId], idempotency_key: 'k2' }, ctx));
  expect(bulk.isError).toBe(true);
  expect(bulk.content[0]!.text).toMatch(/VAT was never read/);

  const { rows } = await pool.query('SELECT status, gl_journal_entry_id FROM supplier_invoices WHERE id=$1', [invoiceId]);
  expect(rows[0]).toEqual({ status: 'draft', gl_journal_entry_id: null });
});

it('a captured document with no vatAmount KEY at all counts as not read (JSON.stringify drops undefined)', async () => {
  const { vatAmount: _v, ...noKey } = NO_VAT;
  const documentId = await seedDocument(noKey, 'nokey');
  const invoiceId = await draftFor(documentId, 130.43, 1000, 'nokey');
  const single = await tool(() => approveSupplierInvoiceTool.handler({ invoice_id: invoiceId, idempotency_key: 'k4' }, ctx));
  expect(single.isError).toBe(true);
  expect(single.content[0]!.text).toMatch(/VAT was never read/);
});

it('the other direction: a captured bill whose VAT WAS read is approved, and posts that VAT', async () => {
  const documentId = await seedDocument({ ...NO_VAT, totalAmount: 1150, subtotal: 1000, vatAmount: 150 }, 'read');
  const invoiceId = await draftFor(documentId, 150, 1150, 'read');
  const res = await tool(() => approveSupplierInvoiceTool.handler({ invoice_id: invoiceId, idempotency_key: 'k3' }, ctx));
  expect(res.isError, res.content[0]!.text).toBeFalsy();
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(jl.debit),0)::float8 AS vat FROM gl_journal_lines jl
       JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.account_subtype = 'vat_input'
       JOIN supplier_invoices si ON si.gl_journal_entry_id = jl.journal_entry_id
      WHERE si.id = $1`, [invoiceId],
  );
  expect(rows[0].vat).toBeCloseTo(150, 2);
});
