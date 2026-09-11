/**
 * K-072 round 36: a meals merchant's input VAT "held for a person" is HELD.
 *
 * On the chart every company is seeded with (migrations 200/476/605), 5600 is
 * `Administrative Expenses` and migration 521 does not flag it, so a restaurant
 * receipt the merchant map routes there CLAIMS its VAT. Round 35 withheld the
 * route's auto-post and nothing else: MCP `post_journal` then posted the draft,
 * claiming R130.43 of s17(2)(a)-denied input VAT. Proved on the DB, real chart:
 *
 *   - Wimpy, Mugg & Bean, Cafe Del Mar, Seattle Coffee and Mr Delivery slips
 *     through `receipt-to-journal` are marked drafts, and `post_journal`
 *     refuses every one — they stay drafts;
 *   - the approve tools refuse a captured restaurant bill that claims VAT
 *     (single and bulk), and a non-meals bill still approves;
 *   - the other direction: a non-meals slip still auto-posts claiming its VAT.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { SignJWT } from 'jose';
import receiptToJournal from '../../pages/api/accounting/receipt-to-journal';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { als } from '@/lib/als';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { postJournalTool } from '@/lib/mcp/tools/writeJournals';
import { approveSupplierInvoiceTool } from '@/lib/mcp/tools/writeSupplierInvoices';
import { bulkApproveSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkApproveSupplierInvoices';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const A: Record<string, string> = {};
let token = '';
const ctx = { userId: admin, companyId: company, scopes: ['write:invoices', 'write:journals', 'write:post'], tokenJti: 'jti', oauthAppId: null } as McpToolContext;
const HELD = /held for a person/;
const today = new Date().toISOString().slice(0, 10);

async function seed(vendor: string | null, item: string, type: 'receipt' | 'invoice' = 'receipt', confirmed: string | null = null): Promise<string> {
  const rawText = `${vendor ?? 'Linden'}\nTAX INVOICE\nVAT No 4987654321\nDate: ${today}\n${item} 1000.00\nSubtotal 869.57\nVAT 130.43\nTOTAL 1000.00\nCARD 1000.00\n`;
  const extracted = { documentType: type, vendorName: vendor, date: today, referenceNumber: crypto.randomUUID().slice(0, 8), currency: 'ZAR',
    subtotal: 869.57, vatAmount: 130.43, vatRate: 15, totalAmount: 1000, lineItems: [], rawText, confidence: 0.99, warnings: [], extractionMethod: 'vlm' };
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,vendor_name,status)
    VALUES($1,$2,$3,'application/pdf',$4,$5::jsonb,$6,'pending')`, [id, company, `k072-${id}.pdf`, type, JSON.stringify(extracted), confirmed]);
  return id;
}

async function viaRoute(documentId: string) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as { url: string; body: unknown; query: object };
  req.url = '/api/accounting/receipt-to-journal';
  req.query = {};
  req.body = { documentId };
  const result = response();
  await receiptToJournal(req as never, result.res);
  expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(200);
  const { rows } = await pool.query(`SELECT je.id, je.status, je.description,
      (SELECT COALESCE(SUM(debit),0)::float8 FROM gl_journal_lines WHERE journal_entry_id=je.id AND gl_account_id=$3) AS vat
    FROM gl_journal_entries je WHERE je.company_id=$1 AND je.source_document_id=$2`, [company, documentId, A.in]);
  return rows[0] as { id: string; status: string; description: string; vat: number };
}

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

async function bill(documentId: string, supplier: string): Promise<string> {
  const { rows } = await pool.query(`INSERT INTO supplier_invoices(company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_rate,
    tax_amount,total_amount,status,created_by,source_document_id) VALUES($1,$2,$3,$4,869.57,15,130.43,1000,'draft',$5,$6) RETURNING id`,
  [company, supplier, `K072-M-${documentId.slice(0, 8)}`, today, admin, documentId]);
  await pool.query(`INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,tax_rate,tax_amount,line_total)
    VALUES($1,'Catering',1,869.57,15,130.43,869.57)`, [rows[0].id]);
  return rows[0].id as string;
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K072 r36 meals held')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [company, admin, 'admin']);
  await pool.query(`INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,'K072 FY',1,EXTRACT(YEAR FROM CURRENT_DATE)::int,date_trunc('year',CURRENT_DATE)::date,
      (date_trunc('year',CURRENT_DATE) + interval '1 year - 1 day')::date,'open')`, [company]);
  // The seeded chart, as migrations 200/476/605 create it — nothing renamed, nothing flagged.
  for (const [key, code, name, type, subtype, normal] of [['bank', '1000', 'Bank', 'asset', 'bank', 'debit'],
    ['in', '1140', 'VAT Input', 'asset', 'vat_input', 'debit'], ['ap', '2000', 'Accounts Payable', 'liability', 'payable', 'credit'],
    ['exp', '6000', 'General Expenses', 'expense', 'default_expense', 'debit'],
    ['adm', '5600', 'Administrative Expenses', 'expense', 'admin_expense', 'debit']]) {
    const { rows } = await pool.query(`INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,normal_balance,
      is_active,is_system_account) VALUES($1,$2,$3,$4,$5,$6,true,true) RETURNING id`, [company, code, name, type, subtype, normal]);
    A[key] = rows[0].id as string;
  }
  clearSystemAccountCache(company);
  for (const [key, name] of [['spur', 'Spur Steak Ranches'], ['steel', 'Brits Steel']]) {
    const { rows } = await pool.query('INSERT INTO suppliers(company_id,name,is_active) VALUES($1,$2,true) RETURNING id', [company, name]);
    A[key] = rows[0].id as string;
  }
  token = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    for (const q of ['DELETE FROM gl_journal_lines WHERE company_id=$1', 'UPDATE supplier_invoices SET gl_journal_entry_id=NULL WHERE company_id=$1',
      'DELETE FROM gl_journal_entries WHERE company_id=$1',
      'DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id=$1)',
      'DELETE FROM supplier_invoices WHERE company_id=$1', 'DELETE FROM captured_documents WHERE company_id=$1',
      'DELETE FROM suppliers WHERE company_id=$1',
      'DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)',
      'DELETE FROM gl_accounts WHERE company_id=$1', 'DELETE FROM fiscal_periods WHERE company_id=$1',
      'DELETE FROM company_users WHERE company_id=$1', 'DELETE FROM companies WHERE id=$1']) await pool.query(q, [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

it.each(['Wimpy Linden', 'Mugg & Bean Rosebank', 'Cafe Del Mar', 'Seattle Coffee Co', 'Mr Delivery'])(
  '%s on the seeded 5600: a marked draft claiming its VAT, and post_journal refuses it', async (vendor) => {
    const je = await viaRoute(await seed(vendor, 'Meal'));
    expect(je).toMatchObject({ status: 'draft', vat: 130.43 });
    expect(je.description).toMatch(/HELD for a person/);
    const out = await tool(() => postJournalTool.handler({ journal_id: je.id, idempotency_key: crypto.randomUUID() }, ctx));
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(HELD);
    expect((await pool.query('SELECT status FROM gl_journal_entries WHERE id=$1', [je.id])).rows[0].status).toBe('draft');
  });

// r37 MEDIUM-2: the route reads the person's correction first, as the posters do — one function, the same inputs.
it.each([['W1MPY LINDEN', 'Wimpy Linden'], [null, 'Mugg & Bean Rosebank']])(
  'extracted `%s`, corrected to `%s`: the route holds it, and post_journal refuses it', async (extracted, confirmed) => {
    const je = await viaRoute(await seed(extracted, 'Meal', 'receipt', confirmed));
    expect(je).toMatchObject({ status: 'draft', vat: 130.43 });
    expect(je.description).toMatch(/HELD for a person/);
    const out = await tool(() => postJournalTool.handler({ journal_id: je.id, idempotency_key: crypto.randomUUID() }, ctx));
    expect(out.content[0]!.text).toMatch(HELD);
  });

it('a correction AWAY from a meals name lifts it: extracted `Wimpy`, corrected to `Brits Steel`, auto-posts claiming', async () => {
  expect(await viaRoute(await seed('Wimpy Linden', 'Flat bar', 'receipt', 'Brits Steel'))).toMatchObject({ status: 'posted', vat: 130.43 });
});

it('the other direction: a non-meals slip still auto-posts claiming its VAT', async () => {
  expect(await viaRoute(await seed('Brits Steel', 'Flat bar'))).toMatchObject({ status: 'posted', vat: 130.43 });
});

it('the approve tools refuse a captured restaurant bill that claims VAT; a non-meals bill approves', async () => {
  const spurBill = await bill(await seed('Spur Steak Ranches Rosebank', 'Catering', 'invoice'), A.spur);
  const single = await tool(() => approveSupplierInvoiceTool.handler({ invoice_id: spurBill, idempotency_key: crypto.randomUUID() }, ctx));
  expect(single.content[0]!.text).toMatch(HELD);
  const bulk = await tool(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [spurBill], idempotency_key: crypto.randomUUID() }, ctx));
  expect(bulk.content[0]!.text).toMatch(HELD);
  expect((await pool.query('SELECT status, gl_journal_entry_id FROM supplier_invoices WHERE id=$1', [spurBill])).rows[0])
    .toEqual({ status: 'draft', gl_journal_entry_id: null });

  const steelBill = await bill(await seed('Brits Steel', 'Flat bar', 'invoice'), A.steel);
  const ok = await tool(() => approveSupplierInvoiceTool.handler({ invoice_id: steelBill, idempotency_key: crypto.randomUUID() }, ctx));
  expect(ok.isError ?? false, ok.content[0]!.text).toBe(false);
});
