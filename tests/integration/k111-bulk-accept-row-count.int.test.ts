// K-111 review round 2 (MEDIUM-4): bulkAcceptTransactions read `.count` off an
// UPDATE with no RETURNING and fell back to ids.length, so it reported success
// for every id the operator sent — including rows the status predicate skipped.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { bulkAcceptTransactions } from '../../src/modules/accounting/services/bank/bankTransactionQueryService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

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

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K111 bulk fixture', other, 'K111 bulk second tenant']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance)
     VALUES($1,$2,'1100','Current account','asset','debit'),($3,$4,'1100','Their account','asset','debit')`,
    [bankAccount, company, foreignAccount, other]);
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
     VALUES($1,$2,$3,'2026-08-01',100,'Imported','imported'),
           ($4,$2,$3,'2026-08-02',200,'Allocated','allocated'),
           ($5,$2,$3,'2026-08-03',300,'Already matched','matched'),
           ($6,$2,$3,'2026-08-04',400,'Excluded','excluded')`,
    [imported, company, bankAccount, allocated, alreadyMatched, excluded]);
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
     VALUES($1,$2,$3,'2026-08-05',500,'Other tenant','imported')`,
    [foreignTx, other, foreignAccount]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, other]]);
  } finally { await pool.end(); }
});

it('counts the rows the status predicate matched, not the ids it was handed', async () => {
  const count = await bulkAcceptTransactions(company, [imported, allocated, alreadyMatched, excluded]);
  const matched = await pool.query(
    "SELECT id FROM bank_transactions WHERE company_id=$1 AND status='matched'", [company]);
  // imported + allocated move; matched and excluded do not.
  expect({ count, stored: matched.rows.length }).toEqual({ count: 2, stored: 3 });
});

it('does not count or touch another tenant\'s transaction', async () => {
  const count = await bulkAcceptTransactions(company, [foreignTx]);
  const foreign = await pool.query('SELECT status FROM bank_transactions WHERE id=$1', [foreignTx]);
  expect({ count, foreignStatus: foreign.rows[0].status }).toEqual({ count: 0, foreignStatus: 'imported' });
});

it('reports zero for an empty id list without touching the table', async () => {
  expect(await bulkAcceptTransactions(company, [])).toBe(0);
});
