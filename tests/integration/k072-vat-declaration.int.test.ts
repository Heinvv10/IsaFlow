/**
 * K-072 round 35: "no VAT read" evidences none only where the SUPPLIER declares
 * itself not VAT registered, as a line of its own, on a page that says nothing
 * else about tax. Round 34 accepted a mid-sentence phrase, so an item footnote
 * on a VAT-charging bill whose VAT line the reader missed was approved with no
 * VAT. Proved against the DB, with nothing forced unread:
 *
 *   - the reviewer's three shapes: `approve_supplier_invoice` (Bosman, `VAT
 *     INCL 391.30` + a call-out-fee footnote + an OCR-damaged VAT number),
 *     `bulk_approve_supplier_invoices` (Brits Bouwerk, `VAT included 300.00` +
 *     a customer footnote) and `post_journal` (an Engen fuel footnote) all
 *     refuse, and nothing is posted;
 *   - the footnote variants refuse on both tools and `post_journal`;
 *   - the other direction: a supplier that says `We are not VAT registered.`
 *     on an otherwise tax-free page is approved and posted claiming none.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { SignJWT } from 'jose';
import pipeline from '../../pages/api/accounting/ai-invoice-pipeline';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { als } from '@/lib/als';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { extractFromText } from '@/modules/accounting/services/core/ocrService';
import { approveSupplierInvoiceTool } from '@/lib/mcp/tools/writeSupplierInvoices';
import { bulkApproveSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkApproveSupplierInvoices';
import { postJournalTool } from '@/lib/mcp/tools/writeJournals';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const supplier = crypto.randomUUID();
const A: Record<string, string> = {};
let token = '';
const ctx = { userId: admin, companyId: company, scopes: ['write:invoices', 'write:journals', 'write:post'], tokenJti: 'jti', oauthAppId: null } as McpToolContext;
const UNEVIDENCED = /not the VAT read off the captured document/;

async function seed(text: string, vendorName: string, type: 'invoice' | 'receipt'): Promise<string> {
  const extracted = { ...(await extractFromText(text)), documentType: type, vendorName, confidence: 0.99, extractionMethod: 'vlm' };
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,extracted_data,status)
    VALUES($1,$2,$3,'pdf',$4::jsonb,'pending')`, [id, company, `k072-${id}.pdf`, JSON.stringify({ ...extracted, referenceNumber: id.slice(0, 8) })]);
  return id;
}

async function viaPipeline(documentId: string): Promise<string> {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as { url: string; body: unknown; query: object };
  req.url = '/api/accounting/ai-invoice-pipeline';
  req.query = {};
  req.body = { documentId };
  const result = response();
  await pipeline(req as never, result.res);
  expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(200);
  const { rows } = await pool.query('SELECT id FROM supplier_invoices WHERE company_id=$1 AND source_document_id=$2', [company, documentId]);
  return rows[0].id as string;
}

async function draftBill(documentId: string, total: number): Promise<string> {
  const { rows } = await pool.query(`INSERT INTO supplier_invoices(company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_rate,
    tax_amount,total_amount,status,created_by,source_document_id) VALUES($1,$2,$3,'2026-05-10',$4,0,0,$4,'draft',$5,$6) RETURNING id`,
  [company, supplier, `K072-D-${documentId.slice(0, 8)}`, total, admin, documentId]);
  await pool.query(`INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,tax_rate,tax_amount,line_total)
    VALUES($1,'Service',1,$2,0,0,$2)`, [rows[0].id, total]);
  return rows[0].id as string;
}

async function draftJournal(documentId: string, total: number): Promise<string> {
  const { rows } = await pool.query(`INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,status,created_by,
    source_document_id) VALUES($1,$2,'2026-05-10','Receipt: r35','auto_invoice','draft',$3,$4) RETURNING id`,
  [company, `K072-J-${documentId.slice(0, 8)}`, admin, documentId]);
  await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit,description)
    VALUES($1,$2,$3,$5,0,'x'),($1,$2,$4,0,$5,'x')`, [rows[0].id, company, A.exp, A.bank, total]);
  return rows[0].id as string;
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
const approve = (id: string) => tool(() => approveSupplierInvoiceTool.handler({ invoice_id: id, idempotency_key: crypto.randomUUID() }, ctx));
const bulk = (id: string) => tool(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [id], idempotency_key: crypto.randomUUID() }, ctx));
const postJ = (id: string) => tool(() => postJournalTool.handler({ journal_id: id, idempotency_key: crypto.randomUUID() }, ctx));
const billState = async (id: string) => (await pool.query('SELECT status, gl_journal_entry_id FROM supplier_invoices WHERE id=$1', [id])).rows[0];
const journalState = async (id: string) => (await pool.query('SELECT status FROM gl_journal_entries WHERE id=$1', [id])).rows[0].status;

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K072 r35 VAT declaration')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [company, admin, 'admin']);
  await pool.query(`INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,'K072 FY',1,2026,'2026-01-01','2026-12-31','open')`, [company]);
  for (const [key, code, name, type, subtype, normal] of [['exp', '6000', 'K072 Expense', 'expense', 'default_expense', 'debit'],
    ['in', '1300', 'K072 VAT Input', 'asset', 'vat_input', 'debit'], ['ap', '2000', 'K072 Payables', 'liability', 'payable', 'credit'],
    ['bank', '1000', 'K072 Bank', 'asset', 'bank', 'debit']]) {
    const { rows } = await pool.query(`INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,normal_balance,
      is_active,is_system_account) VALUES($1,$2,$3,$4,$5,$6,true,true) RETURNING id`, [company, code, name, type, subtype, normal]);
    A[key] = rows[0].id as string;
  }
  clearSystemAccountCache(company);
  await pool.query('INSERT INTO suppliers(id,company_id,name,is_active) VALUES($1,$2,$3,true)', [supplier, company, 'Bosman Motors']);
  await pool.query("INSERT INTO suppliers(company_id,name,is_active) VALUES($1,'Brits Bouwerk',true),($1,'Joe Garden Services',true)", [company]);
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

it('the reviewer\'s three DB shapes are refused, nothing forced unread, and nothing posts', async () => {
  const bosman = await seed('Bosman Motors\nINVOICE\nVAT No: 4I23450000\nInvoice No: 7781\nDate: 2026-05-03\nService 60 000km 3000.00\n'
    + 'Call-out fee 450.00\nTOTAL 3450.00\nVAT INCL 391.30\nPlease note: VAT is not applicable on the call-out fee\nBank: FNB 62000000000\n', 'Bosman Motors', 'invoice');
  const bosmanBill = await viaPipeline(bosman);
  expect((await approve(bosmanBill)).content[0]!.text).toMatch(UNEVIDENCED);
  expect(await billState(bosmanBill)).toEqual({ status: 'draft', gl_journal_entry_id: null });

  const brits = await seed('Brits Bouwerk\nINVOICE\nInvoice No: BB-55\nDate: 2026-05-04\nBricks 1000 x 2.30 2300.00\nTOTAL 2300.00\n'
    + 'VAT included 300.00\nNon-VAT registered customers pay the full amount\nBank: FNB 62000000000\n', 'Brits Bouwerk', 'invoice');
  const britsBill = await viaPipeline(brits);
  expect((await bulk(britsBill)).content[0]!.text).toMatch(UNEVIDENCED);
  expect(await billState(britsBill)).toEqual({ status: 'draft', gl_journal_entry_id: null });

  const engen = await seed('Engen Linden\nTAX INVOICE\nDate: 2026-05-05\nDiesel 40.00L 1000.00\nOil 5W30 1L 230.00\nTOTAL 1230.00\nVAT INCL 30.00\n'
    + 'Fuel is zero rated - VAT not applicable on fuel\n', 'Engen Linden', 'receipt');
  const engenJe = await draftJournal(engen, 1230);
  expect((await postJ(engenJe)).content[0]!.text).toMatch(UNEVIDENCED);
  expect(await journalState(engenJe)).toBe('draft');
});

it.each(['VAT is not applicable on the call-out fee', 'VAT not applicable to zero-rated goods', 'Customer: not VAT registered',
  'No VAT', 'Deposit\nNo VAT', 'We are not VAT registered, prices are final',
  // A valid whole-line declaration does not outvote a VAT line on the same page (the reader missed it).
  'We are not VAT registered.'])('footnote `%s` over a missed VAT: both tools and post_journal refuse', async (foot) => {
  const text = `Joe Garden Services\nINVOICE\nGarden service 1000.00\nTOTAL 1000.00\nVAT included 130.43\n${foot}\n`;
  const bill = await draftBill(await seed(text, 'Joe Garden Services', 'invoice'), 1000);
  expect((await approve(bill)).content[0]!.text).toMatch(UNEVIDENCED);
  expect((await bulk(bill)).content[0]!.text).toMatch(UNEVIDENCED);
  expect(await billState(bill)).toEqual({ status: 'draft', gl_journal_entry_id: null });
  const je = await draftJournal(await seed(text, 'Joe Garden Services', 'receipt'), 1000);
  expect((await postJ(je)).content[0]!.text).toMatch(UNEVIDENCED);
  expect(await journalState(je)).toBe('draft');
});

// r36 MEDIUM-1: the reviewer's bill-to shapes — a CUSTOMER's `Not VAT registered`, and a glued `TotalVAT` or a
// `15.00%` rate the reader does not read. The first goes through the pipeline, as the reviewer ran it.
it.each([['billto-totalvat', 'TotalVAT 130.43'], ['billto-rate', 'Std rate 15.00% 130.43']])('%s: both tools and post_journal refuse', async (tag, taxLine) => {
  const text = `Bosman Motors\nINVOICE\nInvoice No: ${tag}\nDate: 2026-05-0${tag === 'billto-rate' ? 4 : 2}\nBill To:\nMokoena Trading\nNot VAT registered\n`
    + `Service 60 000km 869.57\nSubtotal 869.57\n${taxLine}\nTOTAL 1000.00\n`;
  const doc = await seed(text, 'Bosman Motors', 'invoice');
  const billId = tag === 'billto-totalvat' ? await viaPipeline(doc) : await draftBill(doc, 1000);
  expect((await approve(billId)).content[0]!.text).toMatch(UNEVIDENCED);
  expect((await bulk(billId)).content[0]!.text).toMatch(UNEVIDENCED);
  expect(await billState(billId)).toEqual({ status: 'draft', gl_journal_entry_id: null });
  const je = await draftJournal(await seed(text, 'Bosman Motors', 'receipt'), 1000);
  expect((await postJ(je)).content[0]!.text).toMatch(UNEVIDENCED);
});

// r37 MEDIUM-1: the reviewer's tokenisation shapes (`Bill-To:` + `VATAMT`, through the pipeline as it was run) and the
// structural tripwire (a VAT-shaped figure under an innocent label, on a page the supplier declares tax-free).
it.each([
  // Its own total: the pipeline's fuzzy duplicate check answers 409 for another R1 000 Bosman bill.
  ['billto-vatamt', 'Bill-To:\nMokoena Trading\nNot VAT registered\nService 60 000km 1739.13\nSubtotal 1739.13\nVATAMT 260.87\nTOTAL 2000.00'],
  ['deliverto-taxamt', 'Deliver-To:\nMokoena Trading\nNot VAT registered\nService 60 000km 869.57\nSubtotal 869.57\nTaxAmt 130.43\nTOTAL 1000.00'],
  ['to-vatincl', 'To:\nMokoena Trading\nNot VAT registered\nService 60 000km 869.57\nSubtotal 869.57\nVATINCL 130.43\nTOTAL 1000.00'],
  ['tripwire', 'We are not VAT registered.\nService 60 000km 869.57\nExtras 130.43\nTOTAL 1000.00'],
  // One rule each: a separator-only customer head with no tax line; a right-glued tax word whose figure is not VAT-shaped.
  ['separator-only', 'Bill-To:\nMokoena Trading\nNot VAT registered\nService 60 000km 1000.00\nTOTAL 1000.00'],
  ['glued-right-only', 'We are not VAT registered.\nService 60 000km 987.00\nTaxAmt 13.00\nTOTAL 1000.00'],
])('%s: both tools and post_journal refuse', async (tag, body) => {
  const text = `Bosman Motors\nINVOICE\nInvoice No: ${tag}\nDate: 2026-05-0${tag.length % 9}\n${body}\n`;
  const doc = await seed(text, 'Bosman Motors', 'invoice');
  const total = tag === 'billto-vatamt' ? 2000 : 1000;
  const billId = tag === 'billto-vatamt' ? await viaPipeline(doc) : await draftBill(doc, total);
  expect((await approve(billId)).content[0]!.text).toMatch(UNEVIDENCED);
  expect((await bulk(billId)).content[0]!.text).toMatch(UNEVIDENCED);
  expect(await billState(billId)).toEqual({ status: 'draft', gl_journal_entry_id: null });
  const je = await draftJournal(await seed(text, 'Bosman Motors', 'receipt'), total);
  expect((await postJ(je)).content[0]!.text).toMatch(UNEVIDENCED);
});

// r38 LOW-1: the reviewer's stacked mixed-rate pages — an unlisted customer head, a tax label the reader misses, a VAT
// that is not 15%-shaped (a mixed-rate bill), no VAT number. The first through the pipeline, as the reviewer ran it.
it.each([['stacked-wat', 'Billing Address:', 'WAT 130.43'], ['stacked-slashat', 'Billing Address:', '\\/AT 130.43'],
  ['stacked-tx', 'Postal Address:', 'Tx 130.43']])('%s: refused by both tools and post_journal', async (tag, head, taxLine) => {
  const text = `Bosman Foods\nINVOICE\nInvoice No: ${tag}\nDate: 2026-05-0${tag.length % 9}\n${head}\nMokoena Trading\nNot VAT registered\nCooldrinks 869.57\n`
    + `Brown bread 210.00\nSubtotal 1079.57\n${taxLine}\nTOTAL 1210.00\n`;
  const doc = await seed(text, 'Bosman Motors', 'invoice');
  const billId = tag === 'stacked-wat' ? await viaPipeline(doc) : await draftBill(doc, 1210);
  expect((await approve(billId)).content[0]!.text).toMatch(UNEVIDENCED);
  expect((await bulk(billId)).content[0]!.text).toMatch(UNEVIDENCED);
  expect(await billState(billId)).toEqual({ status: 'draft', gl_journal_entry_id: null });
  const je = await draftJournal(await seed(text, 'Bosman Motors', 'receipt'), 1210);
  expect((await postJ(je)).content[0]!.text).toMatch(UNEVIDENCED);
});

// r39 LOW-1: a mixed-case `Wat` / `wAT` tax label beside the supplier's own declaration (not 15%-shaped: a mixed-rate
// bill) — refused; the Afrikaans prose word `wat` still passes. `Wat` goes through the pipeline, with its own total.
it.each([['wat-mixed', 'Wat 260.86'], ['wat-lower-upper', 'wAT 260.86']])('%s: refused by both tools and post_journal', async (tag, taxLine) => {
  const text = `Bosman Foods\nWe are not VAT registered.\nInvoice No: ${tag}\nDate: 2026-05-1${tag.length % 9}\nCooldrinks 1739.14\n`
    + `Brown bread 420.00\nSubtotal 2159.14\n${taxLine}\nTOTAL 2420.00\n`;
  const doc = await seed(text, 'Bosman Motors', 'invoice');
  const billId = tag === 'wat-mixed' ? await viaPipeline(doc) : await draftBill(doc, 2420);
  expect((await approve(billId)).content[0]!.text).toMatch(UNEVIDENCED);
  expect((await bulk(billId)).content[0]!.text).toMatch(UNEVIDENCED);
  expect(await billState(billId)).toEqual({ status: 'draft', gl_journal_entry_id: null });
  const je = await draftJournal(await seed(text, 'Bosman Motors', 'receipt'), 2420);
  expect((await postJ(je)).content[0]!.text).toMatch(UNEVIDENCED);
});

// r40 LOW-1: `Wat` behind other separators, or alone on its line in a column layout. The dotted leader goes through the pipeline.
it.each([['wat-leader', 'Cooldrinks 1739.14\nBrown bread 420.00\nWat ........ 260.86\nTOTAL 2420.00'],
  ['wat-pipe', 'Cooldrinks 1739.14\nBrown bread 420.00\nWat | 260.86\nTOTAL 2420.00'],
  ['wat-dash', 'Cooldrinks 1739.14\nBrown bread 420.00\nWat — 260.86\nTOTAL 2420.00'],
  ['wat-column', 'Cooldrinks\nBrown bread\nSubtotal\nWat\nTOTAL\n1806.14\n420.00\n2226.14\n260.86\n2487.00']])('%s: refused by both tools and post_journal', async (tag, body) => {
  const text = `Bosman Foods\nWe are not VAT registered.\nInvoice No: ${tag}\nDate: 2026-06-0${tag.length % 9}\n${body}\n`;
  const doc = await seed(text, 'Bosman Motors', 'invoice');
  const billId = tag === 'wat-leader' ? await viaPipeline(doc) : await draftBill(doc, 2420);
  expect((await approve(billId)).content[0]!.text).toMatch(UNEVIDENCED);
  expect((await bulk(billId)).content[0]!.text).toMatch(UNEVIDENCED);
  const je = await draftJournal(await seed(text, 'Bosman Motors', 'receipt'), 2420);
  expect((await postJ(je)).content[0]!.text).toMatch(UNEVIDENCED);
});

it('r39 the other direction: a declared page whose Afrikaans prose says `wat` is approved and posted claiming none', async () => {
  const text = 'Joe se Tuindienste\nNie BTW-geregistreer nie\nWerk wat gedoen is 1000.00\nBedrag Verskuldig 1000.00\n';
  const bill = await draftBill(await seed(text, 'Joe Garden Services', 'invoice'), 1000);
  const approved = await approve(bill);
  expect(approved.isError ?? false, approved.content[0]!.text).toBe(false);
  const je = await draftJournal(await seed(text, 'Joe Garden Services', 'receipt'), 1000);
  const posted = await postJ(je);
  expect(posted.isError ?? false, posted.content[0]!.text).toBe(false);
});

// r36: the reviewer's shapes fail two rules at once; each of these fails exactly ONE, so each rule is pinned alone.
it.each([
  ['customer block only', 'Bill To:\nMokoena Trading\nNot VAT registered\nService 1000.00\nTOTAL 1000.00'],
  // r38: a head no list names — only the inverted rule (the supplier's own region) decides it.
  ['unlisted head only', 'Billing Address:\nMokoena Trading\nNot VAT registered\nService 1000.00\nTOTAL 1000.00'],
  ['glued TotalVAT only', 'We are not VAT registered.\nService 869.57\nSubtotal 869.57\nTotalVAT 130.43\nTOTAL 1000.00'],
  ['15.00% rate only', 'We are not VAT registered.\nService 869.57\nSubtotal 869.57\nStd rate 15.00% 130.43\nTOTAL 1000.00'],
])('%s: both tools and post_journal refuse', async (_tag, body) => {
  const text = `Joe Garden Services\nINVOICE\n${body}\n`;
  const billId = await draftBill(await seed(text, 'Joe Garden Services', 'invoice'), 1000);
  expect((await approve(billId)).content[0]!.text).toMatch(UNEVIDENCED);
  expect((await bulk(billId)).content[0]!.text).toMatch(UNEVIDENCED);
  const je = await draftJournal(await seed(text, 'Joe Garden Services', 'receipt'), 1000);
  expect((await postJ(je)).content[0]!.text).toMatch(UNEVIDENCED);
});

// Pages with NO other tax line, so only the declaration's own shape — and the VAT-number guard — decide.
it.each(['Sold to Mokoena Trading, who is not VAT registered', 'Not VAT registered\nReg 4I23450000', 'Not VAT registered\nRef 4123  450000'])(
  'a quiet page with `%s` is refused: not a supplier line, or a VAT-number shape beside it', async (extra) => {
    const text = `Joe Garden Services\nINVOICE\nGarden service 1000.00\n${extra}\nAmount Due 1000.00\n`;
    const bill = await draftBill(await seed(text, 'Joe Garden Services', 'invoice'), 1000);
    expect((await approve(bill)).content[0]!.text).toMatch(UNEVIDENCED);
    expect((await bulk(bill)).content[0]!.text).toMatch(UNEVIDENCED);
    const je = await draftJournal(await seed(text, 'Joe Garden Services', 'receipt'), 1000);
    expect((await postJ(je)).content[0]!.text).toMatch(UNEVIDENCED);
  });

it('the other direction: `We are not VAT registered.` on an otherwise tax-free page is approved and posted claiming none', async () => {
  const text = 'Joe Garden Services\nINVOICE\nWe are not VAT registered.\nGarden service 1000.00\nAmount Due 1000.00\n';
  const bill = await draftBill(await seed(text, 'Joe Garden Services', 'invoice'), 1000);
  const approved = await approve(bill);
  expect(approved.isError ?? false, approved.content[0]!.text).toBe(false);
  expect((await billState(bill)).status).toBe('approved');
  const je = await draftJournal(await seed(text, 'Joe Garden Services', 'receipt'), 1000);
  const posted = await postJ(je);
  expect(posted.isError ?? false, posted.content[0]!.text).toBe(false);
  expect(await journalState(je)).toBe('posted');
});
