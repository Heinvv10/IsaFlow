/**
 * R-035 PR6: the journal creators nobody watches at the moment they run.
 * Neither may REFUSE a gated journal after it has written something it cannot
 * keep, so each decides from the amount BEFORE writing, leaves a gated journal
 * a DRAFT (marked) and raises the request itself, as the person who ran it.
 *
 *  - receipt-to-journal, autoPost: a gated receipt is claimed, its journal kept
 *    a draft with a pending request raised by the uploader, and the answer is a
 *    200 saying it is held — never a 4xx after the claim. The claim stays: the
 *    same document cannot be posted twice. Approved, the draft posts through
 *    the UI route. An ungated receipt auto-posts, marked.
 *  - GL import with post-immediately: a mixed batch posts the ungated journals,
 *    holds the gated ones (drafts with requests, listed in heldForApproval) and
 *    never fails because of approval.
 *  - Enforcement off: both behave as before and write no 869 column.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import receiptRoute from '../../pages/api/accounting/receipt-to-journal';
import glImport from '../../pages/api/accounting/gl-import';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import {
  cleanupPr6, enforceJournals, journalCompany, journalRoutes, journalRule, journalState, type JournalCompany,
} from './r035-pr6.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = journalRoutes(tokens);
const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr6(pool, companies, Object.values(u)));

/** A (admin) uploads and imports; B (owner) approves. Owner rule over R1 000 (enforced unless asked otherwise). */
async function fixture(opts: { enforced?: boolean } = {}): Promise<JournalCompany> {
  const f = await journalCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  const tag = f.c.slice(0, 6);
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
     VALUES($1,$2,'R035 VAT input','asset','debit',true,true,'vat_input'),($1,$3,'R035 Expense','expense','debit',true,true,'default_expense')`,
    [f.c, `VI${tag}`, `DX${tag}`]);
  await pool.query("UPDATE gl_accounts SET is_system_account = true WHERE id = $1", [f.bank]);
  clearSystemAccountCache(f.c);
  await journalRule(plantRule, pool, f.c);
  if (opts.enforced !== false) await enforceJournals(pool, f.c, u.b);
  return f;
}

async function receipt(f: JournalCompany, total: number): Promise<string> {
  const id = crypto.randomUUID();
  const subtotal = Math.round((total / 1.15) * 100) / 100;
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
     VALUES($1,$2,$3,'application/pdf','receipt',$4::jsonb,'pending')`,
    [id, f.c, `r035-${id}.pdf`, JSON.stringify({
      documentType: 'receipt', vendorName: 'Waltons Stationery', date: today, referenceNumber: `R6-${id.slice(0, 8)}`,
      currency: 'ZAR', subtotal, vatAmount: Math.round((total - subtotal) * 100) / 100, vatRate: 15, totalAmount: total,
      lineItems: [], confidence: 0.9, warnings: [], extractionMethod: 'vlm',
      rawText: `Waltons Stationery\nTAX INVOICE\nSub Total ${subtotal.toFixed(2)}\nVAT ${(total - subtotal).toFixed(2)}\nTotal ${total.toFixed(2)}`,
    })]);
  return id;
}
const postReceipt = (c: string, documentId: string) => callRoute(
  receiptRoute, tokens[u.a]!, c, 'POST', { documentId }, '/api/accounting/receipt-to-journal');
const requestOf = async (id: string) => (await pool.query(
  "SELECT requested_by, status FROM approval_requests WHERE document_type = 'manual_journal' AND document_id = $1", [id])).rows;

describe('receipt-to-journal autoPost', () => {
  it('holds a gated receipt: claimed, draft, marked, request raised by the uploader — a 200, never a 4xx', async () => {
    const f = await fixture();
    const doc = await receipt(f, 1150);
    const res = await postReceipt(f.c, doc);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const body = dataOf<{ journalEntry: { id: string; status: string }; autoPosted: boolean; heldForApproval: boolean }>(res);
    expect(body).toMatchObject({ journalEntry: { status: 'draft' }, autoPosted: false, heldForApproval: true });
    const id = body.journalEntry.id;
    expect(await journalState(pool, id)).toMatchObject({ status: 'draft', marker: 'manual_journal', posted_debit: 0 });
    expect(await requestOf(id)).toEqual([{ requested_by: u.a, status: 'pending' }]);
    const claim = (await pool.query('SELECT posted_at FROM captured_documents WHERE id = $1', [doc])).rows[0];
    expect(claim.posted_at).not.toBeNull();
    expect((await postReceipt(f.c, doc)).state.statusCode).toBe(400);

    const requestId = (await pool.query("SELECT id FROM approval_requests WHERE document_id = $1", [id])).rows[0].id;
    expect((await r.decide(pool, u.b, f.c, requestId)).state.statusCode).toBe(200);
    expect((await r.post(u.a, f.c, id)).state.statusCode).toBe(200);
    expect((await journalState(pool, id)).status).toBe('posted');
  });

  it('auto-posts an ungated receipt, marked', async () => {
    const f = await fixture();
    const res = await postReceipt(f.c, await receipt(f, 575));
    const body = dataOf<{ journalEntry: { id: string }; autoPosted: boolean; heldForApproval: boolean }>(res);
    expect(body).toMatchObject({ autoPosted: true, heldForApproval: false });
    expect(await journalState(pool, body.journalEntry.id)).toMatchObject({ status: 'posted', marker: 'manual_journal' });
  });

  it('enforcement off: auto-posts as before, unmarked, nothing raised', async () => {
    const f = await fixture({ enforced: false });
    const res = await postReceipt(f.c, await receipt(f, 1150));
    const body = dataOf<{ journalEntry: { id: string }; autoPosted: boolean }>(res);
    expect(body.autoPosted).toBe(true);
    expect(await journalState(pool, body.journalEntry.id)).toMatchObject({ status: 'posted', marker: null });
    expect(await requestOf(body.journalEntry.id)).toEqual([]);
  });
});

describe('GL import with post-immediately', () => {
  const rows = (f: JournalCompany) => {
    const tag = f.c.slice(0, 6);
    return [
      { date: '2026-09-01', reference: 'BIG', description: 'big', accountCode: `EA${tag}`, debit: 1500, credit: 0 },
      { date: '2026-09-01', reference: 'BIG', description: 'big', accountCode: `BK${tag}`, debit: 0, credit: 1500 },
      { date: '2026-09-01', reference: 'SMALL', description: 'small', accountCode: `EB${tag}`, debit: 500, credit: 0 },
      { date: '2026-09-01', reference: 'SMALL', description: 'small', accountCode: `BK${tag}`, debit: 0, credit: 500 },
    ];
  };
  const run = (f: JournalCompany) => callRoute(glImport, tokens[u.a]!, f.c, 'POST',
    { rows: rows(f), postImmediately: true }, '/api/accounting/gl-import');
  const byRef = async (c: string, ref: string) => String((await pool.query(
    'SELECT id FROM gl_journal_entries WHERE company_id = $1 AND reference = $2', [c, ref])).rows[0].id);

  it('posts the ungated journals and holds the gated ones, listing them; the import does not fail', async () => {
    const f = await fixture();
    const res = await run(f);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const big = await byRef(f.c, 'BIG');
    const small = await byRef(f.c, 'SMALL');
    expect(dataOf(res)).toMatchObject({ entriesCreated: 2, heldForApproval: [big] });
    expect(await journalState(pool, big)).toMatchObject({ status: 'draft', marker: 'manual_journal' });
    expect(await requestOf(big)).toEqual([{ requested_by: u.a, status: 'pending' }]);
    expect(await journalState(pool, small)).toMatchObject({ status: 'posted', marker: 'manual_journal' });
  });

  it('enforcement off: everything posts as before, unmarked, nothing held', async () => {
    const f = await fixture({ enforced: false });
    const res = await run(f);
    expect(dataOf(res)).toMatchObject({ entriesCreated: 2, heldForApproval: [] });
    expect(await journalState(pool, await byRef(f.c, 'BIG'))).toMatchObject({ status: 'posted', marker: null });
  });
});
