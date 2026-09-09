/**
 * K-032 adjacent cases for the cancelled-document reversal suppression.
 *
 * 1. A cancelled customer INVOICE has the same shape as the credit note: the
 *    reversal is linked from no document row.
 * 2. A reversal dated into the NEXT period must be suppressed there too — the
 *    original is already suppressed in its own period, so keeping the reversal
 *    would swing the following period negative instead of netting to nothing.
 * 3. The reversal of ANOTHER tenant's cancelled original must not be suppressed
 *    in this company's boxes.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getVatPeriodLines } from '../../src/modules/accounting/services/reports/vatBoxBasisQuery';
import { deriveVatBoxes } from '../../src/modules/accounting/services/reports/vatBoxBasis';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
const revenue = crypto.randomUUID();
const receivable = crypto.randomUUID();
const vatOutput = crypto.randomUUID();
const otherRevenue = crypto.randomUUID();
const otherVatOutput = crypto.randomUUID();

const invOriginal = crypto.randomUUID();
const invReversal = crypto.randomUUID();
const invoice = crypto.randomUUID();
const lateOriginal = crypto.randomUUID();
const lateReversal = crypto.randomUUID();
const lateInvoice = crypto.randomUUID();
const foreignOriginal = crypto.randomUUID();
const foreignReversal = crypto.randomUUID();
const foreignInvoice = crypto.randomUUID();
const customer = crypto.randomUUID();
const foreignCustomer = crypto.randomUUID();

const JUNE: [string, string] = ['2026-06-01', '2026-06-30'];
const JULY: [string, string] = ['2026-07-01', '2026-07-31'];

async function journal(
  id: string,
  owner: string,
  entryNumber: string,
  entryDate: string,
  reversalOf: string | null,
) {
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,
       status,source,created_by,reversal_of_id)
     VALUES($1,$2,$3,$4,$5,'posted','manual',$6,$7)`,
    [id, owner, entryNumber, entryDate, `K-032 ${entryNumber}`, user, reversalOf],
  );
}
async function line(
  entry: string,
  owner: string,
  account: string,
  debit: number,
  credit: number,
  vatType: string | null,
) {
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit,vat_type)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [entry, owner, account, debit, credit, vatType],
  );
}
/** A sale: CR revenue 1000, CR output VAT 150, DR AR 1150. */
async function sale(entry: string, owner: string, rev: string, vat: string, ar: string | null) {
  await line(entry, owner, rev, 0, 1000, 'standard');
  await line(entry, owner, vat, 0, 150, 'standard');
  if (ar) await line(entry, owner, ar, 1150, 0, null);
}
async function saleReversed(entry: string, owner: string, rev: string, vat: string, ar: string | null) {
  await line(entry, owner, rev, 1000, 0, 'standard');
  await line(entry, owner, vat, 150, 0, 'standard');
  if (ar) await line(entry, owner, ar, 0, 1150, null);
}
async function cancelledInvoice(id: string, owner: string, number: string, date: string, entry: string) {
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,invoice_date,due_date,
       customer_id,subtotal,tax_amount,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,$3,$4,$4,$7,1000,150,1150,'cancelled',$5,$6)`,
    [id, owner, number, date, entry, user, owner === company ? customer : foreignCustomer],
  );
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [
    company, 'K-032 adjacent', other, 'K-032 adjacent other',
  ]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6)', [
    customer, company, 'K-032 customer', foreignCustomer, other, 'K-032 other customer',
  ]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
     VALUES($1,$4,'K032A-4000','Sales','revenue','sales','credit'),
           ($2,$4,'K032A-1100','Trade receivables','asset','receivable','debit'),
           ($3,$4,'K032A-2120','VAT output','liability','vat_output','credit'),
           ($5,$6,'K032A-4000','Sales','revenue','sales','credit'),
           ($7,$6,'K032A-2120','VAT output','liability','vat_output','credit')`,
    [revenue, receivable, vatOutput, company, otherRevenue, other, otherVatOutput],
  );

  // 1. Cancelled invoice, reversal in the SAME period.
  await journal(invOriginal, company, 'K032A-INV', '2026-06-15', null);
  await sale(invOriginal, company, revenue, vatOutput, receivable);
  await journal(invReversal, company, 'K032A-INV-REV', '2026-06-20', invOriginal);
  await saleReversed(invReversal, company, revenue, vatOutput, receivable);
  await cancelledInvoice(invoice, company, 'K032A-1', '2026-06-15', invOriginal);

  // 2. Cancelled invoice dated June, reversal dated into JULY.
  await journal(lateOriginal, company, 'K032A-LATE', '2026-06-15', null);
  await sale(lateOriginal, company, revenue, vatOutput, receivable);
  await journal(lateReversal, company, 'K032A-LATE-REV', '2026-07-10', lateOriginal);
  await saleReversed(lateReversal, company, revenue, vatOutput, receivable);
  await cancelledInvoice(lateInvoice, company, 'K032A-2', '2026-06-15', lateOriginal);

  // 3. Another tenant's cancelled invoice and its reversal, both in June.
  await journal(foreignOriginal, other, 'K032A-FGN', '2026-06-15', null);
  await sale(foreignOriginal, other, otherRevenue, otherVatOutput, null);
  await journal(foreignReversal, other, 'K032A-FGN-REV', '2026-06-20', foreignOriginal);
  await saleReversed(foreignReversal, other, otherRevenue, otherVatOutput, null);
  await cancelledInvoice(foreignInvoice, other, 'K032A-3', '2026-06-15', foreignOriginal);
});

afterAll(async () => {
  try {
    for (const owner of [company, other]) {
      await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [owner]);
      await pool.query('DELETE FROM customers WHERE company_id=$1', [owner]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [owner]);
      await pool.query('UPDATE gl_journal_entries SET reversal_of_id=NULL WHERE company_id=$1', [owner]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [owner]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [owner]);
      await pool.query('DELETE FROM companies WHERE id=$1', [owner]);
    }
  } finally {
    await pool.end();
  }
});

it('nets a cancelled invoice and its same-period reversal to nothing', async () => {
  const { lines } = await getVatPeriodLines(company, ...JUNE);
  const basis = deriveVatBoxes(lines);
  expect(basis.outputTax).toBeCloseTo(0, 2);
  expect(basis.outputBase).toBeCloseTo(0, 2);
});

it('leaves the next period at nothing when the reversal is dated into it', async () => {
  const { lines } = await getVatPeriodLines(company, ...JULY);
  const basis = deriveVatBoxes(lines);
  expect(basis.outputTax).toBeCloseTo(0, 2);
  expect(basis.outputBase).toBeCloseTo(0, 2);
});

it('does not suppress lines belonging to another tenant', async () => {
  const { lines } = await getVatPeriodLines(other, ...JUNE);
  const journalIds = new Set(lines.map((l) => l.journalEntryId));
  expect(journalIds.has(foreignOriginal)).toBe(true);
  expect(journalIds.has(foreignReversal)).toBe(true);
  expect(lines.every((l) => l.journalEntryId !== invOriginal)).toBe(true);
  expect(deriveVatBoxes(lines).outputTax).toBeCloseTo(0, 2);
});
