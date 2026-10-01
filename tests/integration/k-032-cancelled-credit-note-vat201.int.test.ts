/**
 * K-032 RED — cancelling a credit note leaves spurious VAT201 amounts.
 *
 * `cancelCreditNote` posts a REVERSING journal and leaves
 * `credit_notes.gl_journal_entry_id` pointing at the ORIGINAL. The
 * `cancelled_entries` CTE in vatBoxBasisQuery.ts therefore suppresses the
 * original only; the reversal is an unlinked posted journal in the same period
 * and survives. The pair should net to nothing; instead the return keeps the
 * reversal's positive output VAT and standard-rated base.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getVatPeriodLines } from '../../src/modules/accounting/services/reports/vatBoxBasisQuery';
import { deriveVatBoxes } from '../../src/modules/accounting/services/reports/vatBoxBasis';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const revenue = crypto.randomUUID();
const receivable = crypto.randomUUID();
const vatOutput = crypto.randomUUID();
const original = crypto.randomUUID();
const reversal = crypto.randomUUID();
const creditNote = crypto.randomUUID();

const PERIOD_START = '2026-06-01';
const PERIOD_END = '2026-06-30';

async function journal(id: string, entryNumber: string, reversalOf: string | null) {
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,
       status,source,created_by,reversal_of_id)
     VALUES($1,$2,$3,'2026-06-15',$4,'posted','manual',$5,$6)`,
    [id, company, entryNumber, `K-032 ${entryNumber}`, user, reversalOf],
  );
}
async function line(entry: string, account: string, debit: number, credit: number, vatType: string | null) {
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit,vat_type)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [entry, company, account, debit, credit, vatType],
  );
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K-032 VAT fixture']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
     VALUES($1,$4,'K032-4000','Sales','revenue','sales','credit'),
           ($2,$4,'K032-1100','Trade receivables','asset','receivable','debit'),
           ($3,$4,'K032-2120','VAT output','liability','vat_output','credit')`,
    [revenue, receivable, vatOutput, company],
  );

  // Original credit-note journal: DR sales 1000, DR output VAT 150, CR AR 1150.
  await journal(original, 'K032-CN-ORIG', null);
  await line(original, revenue, 1000, 0, 'standard');
  await line(original, vatOutput, 150, 0, 'standard');
  await line(original, receivable, 0, 1150, null);

  // Its reversal, posted by cancelCreditNote, dated into the same open period.
  await journal(reversal, 'K032-CN-REV', original);
  await line(reversal, revenue, 0, 1000, 'standard');
  await line(reversal, vatOutput, 0, 150, 'standard');
  await line(reversal, receivable, 1150, 0, null);

  await pool.query(
    `INSERT INTO credit_notes(id,company_id,credit_note_number,type,credit_date,
       subtotal,tax_amount,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,'K032-CN-1','customer','2026-06-15',1000,150,1150,'cancelled',$3,$4)`,
    [creditNote, company, original, user],
  );
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM credit_notes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  } finally {
    await pool.end();
  }
});

it('nets a cancelled credit note and its reversal to nothing in the VAT201 boxes', async () => {
  const { lines } = await getVatPeriodLines(company, PERIOD_START, PERIOD_END);
  const basis = deriveVatBoxes(lines);

  // A cancelled credit note raises no VAT and no supply, in either direction.
  // Soft so both numbers are measured — the tax assertion alone used to abort
  // the test and leave the base figure unevidenced.
  expect.soft(basis.outputTax).toBeCloseTo(0, 2);
  expect.soft(basis.outputBase).toBeCloseTo(0, 2);
});
