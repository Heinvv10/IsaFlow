// The all-accounts bank export: every posted statement line of the company in
// the date range, across every bank account, and nothing else — not another
// tenant's rows, not a pending feed row, not a row outside the range.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getAllBankTransactionsForExport } from '@/modules/accounting/services/bank/bankTxExportAll';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const bankA = crypto.randomUUID();
const bankB = crypto.randomUUID();
const otherBank = crypto.randomUUID();
const cc = crypto.randomUUID();
const bu = crypto.randomUUID();
const conn = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'Export-all fixture', other, 'Export-all other tenant']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
     VALUES($1,$4,'EXA1','EXA Bank A','asset','bank','debit'),
           ($2,$4,'EXA2','EXA Bank B','asset','bank','debit'),
           ($3,$5,'EXO1','EXO Bank','asset','bank','debit')`,
    [bankA, bankB, otherBank, company, other],
  );
  await pool.query('INSERT INTO cost_centres(id,company_id,code,name) VALUES($1,$2,$3,$4)', [cc, company, 'EXA-CC', 'Ops']);
  await pool.query('INSERT INTO business_units(id,company_id,code,name) VALUES($1,$2,$3,$4)', [bu, company, 'EXA-BU', 'North']);
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active)
     VALUES($1,$2,$3,'test_provider','active',true)`, [conn, company, bankB]);
  // A pending feed row is not a statement line yet — the export leaves it out.
  await pool.query(
    `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,status,
       bank_feed_connection_id,provider_transaction_id,feed_state)
     VALUES($1,$2,DATE '2025-04-15',-50,'B pending feed','imported',$3,'exa-pending','pending')`,
    [company, bankB, conn]);
  await pool.query(
    `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,status,feed_state,cc1_id,bu_id)
     VALUES($1,$2,DATE '2025-04-01',-10,'A first','imported','posted',$4,$5),
           ($1,$3,DATE '2025-04-30',20,'B last','imported','posted',NULL,NULL),
           ($1,$2,DATE '2025-03-31',-30,'A before range','imported','posted',NULL,NULL),
           ($1,$2,DATE '2025-05-01',-40,'A after range','imported','posted',NULL,NULL),
           ($6,$7,DATE '2025-04-15',-60,'Other tenant','imported','posted',NULL,NULL)`,
    [company, bankA, bankB, cc, bu, other, otherBank],
  );
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM cost_centres WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM business_units WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, other]]);
  } finally {
    await pool.end();
  }
});

describe('getAllBankTransactionsForExport', () => {
  it('returns every posted line in range across all bank accounts, ordered by account then date', async () => {
    const txs = await getAllBankTransactionsForExport(company, '2025-04-01', '2025-04-30');
    expect(txs.map((t) => t.description)).toEqual(['A first', 'B last']);
    expect(txs.map((t) => t.bankAccountName)).toEqual(['EXA Bank A', 'EXA Bank B']);
    expect(txs[0].cc1Code).toBe('EXA-CC');
    expect(txs[0].buCode).toBe('EXA-BU');
  });
});
