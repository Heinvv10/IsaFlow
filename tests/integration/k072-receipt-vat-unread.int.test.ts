/**
 * K-072 round 31. The RECEIPT paths of a capture whose VAT was never read.
 *
 * `buildExpenseJournalFromReceipt` derived 15/115 of the total as a VAT Input
 * leg whenever the VAT was missing — R130.43 on a non-VAT R1 000 slip — and
 * left it on a DRAFT journal the MCP `post_journal` tool posted by id. The
 * employee branch of `capture/[id]/post-expense` put the same derived figure on
 * a claim line. Proved here against the DB, by outcome:
 *
 *   - `receipt-to-journal` and the petty-cash branch of `post-expense` write a
 *     draft with NO VAT Input leg, the gross on the expense, and the flag;
 *   - MCP `post_journal` posts such a draft as it stands, claiming no VAT
 *     (r32: the draft's VAT Input must equal the document's read VAT, none = 0);
 *   - it refuses a LEGACY draft carrying a VAT the document does not show, and
 *     it stays a draft: the invented 130.43 on an unread document (and one with
 *     no `vatAmount` KEY — JSON.stringify drops an undefined field), and the
 *     r32 shapes where the VAT WAS read but the net was not, so the old builder
 *     derived 15/115 anyway: 117.42 on a slip printing `VAT 0.00`, 18.26 on one
 *     printing 13.04;
 *   - the employee branch writes the claim line with VAT 0, code `none`, flagged;
 *   - the other direction: a receipt whose VAT WAS read keeps it — the draft
 *     posts its read VAT through `post_journal`, and the claim line carries it.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { SignJWT } from 'jose';
import receiptToJournal from '../../pages/api/accounting/receipt-to-journal';
import postExpense from '../../pages/api/accounting/capture/[id]/post-expense';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { als } from '@/lib/als';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { postJournalTool } from '@/lib/mcp/tools/writeJournals';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const employee = crypto.randomUUID();
let token = '';
let vatInput = '';
let bank = '';
const ctx = { userId: admin, companyId: company, scopes: ['write:journals', 'write:post'], tokenJti: 'jti', oauthAppId: null } as McpToolContext;

const SLIP = (tag: string, vat: Record<string, unknown>) => ({
  documentType: 'receipt', vendorName: `K072 Garden ${tag}`, date: '2026-04-10', referenceNumber: `K072-R-${tag}`,
  totalAmount: 1000, lineItems: [], rawText: '', confidence: 0.9, warnings: [], extractionMethod: 'vlm', ...vat,
});
// r34: none read counts as none only where the document says no VAT applies.
const NO_VAT = { subtotal: null, vatAmount: null, rawText: 'K072 Garden\nNot VAT registered\nGarden service 1000.00\nAmount Due 1000.00' };
const READ_VAT = { subtotal: 869.57, vatAmount: 130.43 };

async function seedDocument(extracted: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
     VALUES($1,$2,$3,'application/pdf','receipt',$4::jsonb,'pending')`,
    [id, company, `k072-${id}.pdf`, JSON.stringify(extracted)],
  );
  return id;
}

async function route(handler: typeof receiptToJournal, query: Record<string, string>, body: unknown) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as {
    url: string; body: unknown; query: Record<string, string>;
  };
  req.url = '/api/accounting/x';
  req.query = query;
  req.body = body;
  const result = response();
  await handler(req as never, result.res);
  return result.state;
}

async function postExpenseFor(documentId: string, body: Record<string, unknown>) {
  const eventId = crypto.randomUUID();
  await pool.query(`INSERT INTO capture_events(id,company_id,channel,status,captured_document_id) VALUES($1,$2,'api','extracted',$3)`,
    [eventId, company, documentId]);
  return route(postExpense, { id: eventId }, body);
}

async function journalOf(documentId: string) {
  const { rows } = await pool.query(
    `SELECT je.id, je.status, je.description,
            COALESCE(SUM(jl.debit) FILTER (WHERE jl.gl_account_id = $3), 0)::float8 AS vat,
            COALESCE(SUM(jl.credit) FILTER (WHERE jl.gl_account_id = $4), 0)::float8 AS paid
       FROM gl_journal_entries je LEFT JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
      WHERE je.company_id = $1 AND je.source_document_id = $2 GROUP BY je.id`,
    [company, documentId, vatInput, bank],
  );
  expect(rows).toHaveLength(1);
  return rows[0] as { id: string; status: string; description: string; vat: number; paid: number };
}

async function postJournal(journalId: string): Promise<McpToolResult> {
  const client: PoolClient = await pool.connect();
  await client.query('BEGIN');
  try {
    const out = await als.run({ client, userId: admin, companyId: company, claims: {} } as never,
      () => postJournalTool.handler({ journal_id: journalId, idempotency_key: crypto.randomUUID() }, ctx));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

async function account(code: string, subtype: string, type: string, normal: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$2,$3,$4,$5,$6,true,true) RETURNING id`, [company, code, `K072 ${subtype}`, type, subtype, normal],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K072 receipt VAT fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [company, admin, 'admin']);
  await pool.query(`INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,'K072 FY',1,2026,'2026-01-01','2026-12-31','open')`, [company]);
  await account('6000', 'default_expense', 'expense', 'debit');
  bank = await account('1000', 'bank', 'asset', 'debit');
  vatInput = await account('1300', 'vat_input', 'asset', 'debit');
  await account('2000', 'payable', 'liability', 'credit');
  clearSystemAccountCache(company);
  await pool.query(`INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date)
    VALUES($1,$2,'K072-E1','Ray','Tester','2026-01-01')`, [employee, company]);
  token = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    for (const q of [
      'UPDATE expense_claims SET posted_je_id=NULL WHERE company_id=$1',
      'DELETE FROM expense_claim_lines WHERE company_id=$1', 'DELETE FROM expense_claims WHERE company_id=$1',
      'DELETE FROM gl_journal_lines WHERE company_id=$1', 'DELETE FROM gl_journal_entries WHERE company_id=$1',
      'DELETE FROM capture_events WHERE company_id=$1', 'DELETE FROM captured_documents WHERE company_id=$1',
      'DELETE FROM payroll_employees WHERE company_id=$1',
      'DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)',
      'DELETE FROM gl_accounts WHERE company_id=$1', 'DELETE FROM fiscal_periods WHERE company_id=$1',
      'DELETE FROM company_users WHERE company_id=$1', 'DELETE FROM companies WHERE id=$1',
    ]) await pool.query(q, [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

async function legacyDraft(documentId: string, vat: number, total: number): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,status,created_by,source_document_id)
     VALUES($1,$2,'2026-04-10','Receipt: legacy','auto_invoice','draft',$3,$4) RETURNING id`,
    [company, `K072-L-${documentId.slice(0, 8)}`, admin, documentId],
  );
  const expense = (await pool.query("SELECT id FROM gl_accounts WHERE company_id=$1 AND account_code='6000'", [company])).rows[0].id;
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit,description)
     VALUES($1,$2,$3,$6,0,'x'),($1,$2,$4,$7,0,'VAT Input'),($1,$2,$5,0,$8,'x')`,
    [rows[0].id, company, expense, vatInput, bank, Math.round((total - vat) * 100) / 100, vat, total],
  );
  return rows[0].id as string;
}

async function expectRefused(journalId: string) {
  const refused = await postJournal(journalId);
  expect(refused.isError).toBe(true);
  expect(refused.content[0]!.text).toMatch(/not the VAT read off the captured document/);
  const { rows } = await pool.query('SELECT status FROM gl_journal_entries WHERE id=$1', [journalId]);
  expect(rows[0].status).toBe('draft');
}

it('receipt-to-journal: no VAT read is a draft with no VAT leg, and post_journal posts it claiming none', async () => {
  const documentId = await seedDocument(SLIP('rtj', NO_VAT));
  const res = await route(receiptToJournal, {}, { documentId });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  const je = await journalOf(documentId);
  expect(je).toMatchObject({ status: 'draft', vat: 0, paid: 1000 });
  expect(je.description).toMatch(/VAT not read from the document, none claimed$/);

  const posted = await postJournal(je.id);
  expect(posted.isError, posted.content[0]!.text).toBeFalsy();
  expect(await journalOf(documentId)).toMatchObject({ status: 'posted', vat: 0, paid: 1000 });
});

it('post-expense (petty cash): the same draft, posted the same way', async () => {
  const documentId = await seedDocument(SLIP('pc', NO_VAT));
  const res = await postExpenseFor(documentId, {});
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  const je = await journalOf(documentId);
  expect(je).toMatchObject({ status: 'draft', vat: 0, paid: 1000 });
  expect((await postJournal(je.id)).isError).toBeFalsy();
  expect(await journalOf(documentId)).toMatchObject({ status: 'posted', vat: 0 });
});

it('post_journal refuses a LEGACY draft carrying the invented 130.43, and one whose document has no vatAmount KEY', async () => {
  const { vatAmount: _v, subtotal: _s, ...noKey } = SLIP('nokey', NO_VAT);
  for (const extracted of [SLIP('legacy', NO_VAT), noKey]) {
    await expectRefused(await legacyDraft(await seedDocument(extracted), 130.43, 1000));
  }
});

it('post_journal refuses a LEGACY draft whose VAT was read but whose net was not (r32: 117.42 on VAT 0.00, 18.26 on 13.04)', async () => {
  // Q3: a non-VAT fuel slip printing `VAT 0.00` and no net; the old builder booked 15/115 of 900.22.
  const fuel = await seedDocument({ ...SLIP('q3', { subtotal: null, vatAmount: 0 }), totalAmount: 900.22 });
  await expectRefused(await legacyDraft(fuel, 117.42, 900.22));
  // Q4: a mixed slip printing `VAT 13.04` and no net; the old builder booked 18.26 of 140.00.
  const mixed = await seedDocument({ ...SLIP('q4', { subtotal: null, vatAmount: 13.04 }), totalAmount: 140 });
  await expectRefused(await legacyDraft(mixed, 18.26, 140));
  // The same slip's draft carrying its READ 13.04 posts — the comparison, not the shape, decides.
  const kept = await seedDocument({ ...SLIP('q4-read', { subtotal: null, vatAmount: 13.04 }), totalAmount: 140 });
  const posted = await postJournal(await legacyDraft(kept, 13.04, 140));
  expect(posted.isError, posted.content[0]!.text).toBeFalsy();
});

it('the other direction: a receipt whose VAT WAS read keeps it, and post_journal posts it', async () => {
  const documentId = await seedDocument(SLIP('read', READ_VAT));
  await route(receiptToJournal, {}, { documentId });
  const je = await journalOf(documentId);
  expect(je).toMatchObject({ status: 'draft', vat: 130.43 });
  const posted = await postJournal(je.id);
  expect(posted.isError, posted.content[0]!.text).toBeFalsy();
  expect((await journalOf(documentId)).status).toBe('posted');
});

it('post-expense (employee claim): no VAT read is a claim line with VAT 0, code none, flagged; a VAT read is kept', async () => {
  const lines = async (documentId: string) => (await pool.query(
    `SELECT vat_amount::float8 AS vat, vat_code, description FROM expense_claim_lines WHERE company_id=$1 AND source_document_id=$2`,
    [company, documentId])).rows;
  const unread = await seedDocument(SLIP('claim', NO_VAT));
  const res = await postExpenseFor(unread, { employeeId: employee });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  expect(await lines(unread)).toEqual([expect.objectContaining({ vat: 0, vat_code: 'none' })]);
  expect((await lines(unread))[0].description).toMatch(/VAT not read from the document, none claimed$/);

  const read = await seedDocument(SLIP('claim-read', READ_VAT));
  await postExpenseFor(read, { employeeId: employee });
  expect(await lines(read)).toEqual([expect.objectContaining({ vat: 130.43, vat_code: 'standard' })]);
});
