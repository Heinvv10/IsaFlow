// K-111 review round 2 (MEDIUM-4): bulkAcceptTransactions read `.count` off an
// UPDATE with no RETURNING and fell back to ids.length, so it reported success
// for every id the operator sent — including rows the status predicate skipped.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import { bulkAcceptTransactions } from '../../src/modules/accounting/services/bank/bankTransactionQueryService';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const bankAccount = crypto.randomUUID();
const foreignAccount = crypto.randomUUID();
const imported = crypto.randomUUID();
const allocated = crypto.randomUUID();
const alreadyMatched = crypto.randomUUID();
const excluded = crypto.randomUUID();
const foreignTx = crypto.randomUUID();
const user = crypto.randomUUID();
let token = '';

async function callBulkAccept(body: Record<string, unknown>) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = { action: 'bulk_accept', ...body };
  req.query = {};
  req.url = '/api/accounting/bank-transactions-action';
  const result = response();
  await bankTransactionsAction(req as never, result.res);
  return result;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K111 bulk fixture', other, 'K111 bulk second tenant']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance)
     VALUES($1,$2,'1100','Current account','asset','debit'),($3,$4,'1100','Their account','asset','debit')`,
    [bankAccount, company, foreignAccount, other]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  // Migration 980: Review stamps only a line whose cash a journal carries, so the allocated and matched lines each
  // point at a journal line (a draft entry is enough for the FK).
  const je = (await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_date,description,status,created_by)
     VALUES($1,'2026-08-02','K111 seed','draft',$2) RETURNING id`, [company, user])).rows[0].id;
  const jl = (await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,company_id)
     VALUES($1,$2,200,0,$3),($1,$2,300,0,$3) RETURNING id`, [je, bankAccount, company])).rows.map((r) => r.id);
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,reviewed_at,
       matched_journal_line_id)
     VALUES($1,$2,$3,'2026-08-01',100,'Imported','imported',NULL,NULL),
           ($4,$2,$3,'2026-08-02',200,'Allocated','allocated',NULL,$7),
           ($5,$2,$3,'2026-08-03',300,'Already reviewed','matched',NOW(),$8),
           ($6,$2,$3,'2026-08-04',400,'Excluded','excluded',NULL,NULL)`,
    [imported, company, bankAccount, allocated, alreadyMatched, excluded, jl[0], jl[1]]);
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
     VALUES($1,$2,$3,'2026-08-05',500,'Other tenant','imported')`,
    [foreignTx, other, foreignAccount]);
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('counts the rows the status predicate matched, not the ids it was handed', async () => {
  const count = await bulkAcceptTransactions(company, [imported, allocated, alreadyMatched, excluded], user);
  // Migration 980: only the allocated line is reviewed — the imported one has no journal, the matched one is already
  // reviewed, the excluded one is not reviewable. Review stamps who and when and changes no status.
  expect(count).toBe(1);
  const rows = (await pool.query(
    'SELECT id::TEXT AS id, status, reviewed_by::TEXT AS by FROM bank_transactions WHERE company_id=$1 ORDER BY amount',
    [company])).rows;
  expect(rows.map((r) => [r.status, r.by])).toEqual([
    ['imported', null], ['allocated', user], ['matched', null], ['excluded', null]]);
});

it('does not count or touch another tenant\'s transaction', async () => {
  const count = await bulkAcceptTransactions(company, [foreignTx], user);
  const foreign = await pool.query('SELECT status FROM bank_transactions WHERE id=$1', [foreignTx]);
  expect({ count, foreignStatus: foreign.rows[0].status }).toEqual({ count: 0, foreignStatus: 'imported' });
});

it('reports zero for an empty id list without touching the table', async () => {
  expect(await bulkAcceptTransactions(company, [], user)).toBe(0);
});

it('rejects a bulk_accept with no id list before it reaches the service', async () => {
  // Round 2 LOW-6 claimed an omitted list reaches ids.length on undefined and
  // 500s. It does not: BankTxActionSchema requires bankTransactionIds .min(1),
  // so the request is refused as 422 at validation, ahead of the switch.
  const result = await callBulkAccept({});
  expect(result.state.statusCode).toBe(422);
});

it('rejects a bulk_accept with an empty id list', async () => {
  const result = await callBulkAccept({ bankTransactionIds: [] });
  expect(result.state.statusCode).toBe(422);
});
