/**
 * K-032 adjacent cases for the cancelled-document reversal suppression.
 *
 * Every fixture is a CREDIT NOTE. `customerInvoiceCancelService` and
 * `supplierInvoiceWorkflowService` NULL `gl_journal_entry_id` when they cancel,
 * so a cancelled invoice never enters `cancelled_entries_base` at all and the
 * pairing this fix adds cannot reach it. Only `creditNoteCancelService` keeps
 * the link, which is the shape reproduced here.
 *
 * 1. The reversal dated into the NEXT period is a genuine correction to an
 *    already-filed return: the original must stand in period N and the credit
 *    must appear in N+1.
 * 2. Reversing the reversal by hand must not re-admit the cancelled VAT.
 * 3. A cancelled credit note that was never reversed stays suppressed.
 * 4. Company B's journal pointing at company A's cancelled original must
 *    survive in B's boxes.
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

const lateOriginal = crypto.randomUUID();
const lateReversal = crypto.randomUUID();
const lateNote = crypto.randomUUID();
const twiceOriginal = crypto.randomUUID();
const twiceReversal = crypto.randomUUID();
const twiceRereversal = crypto.randomUUID();
const twiceNote = crypto.randomUUID();
const legacyOriginal = crypto.randomUUID();
const legacyNote = crypto.randomUUID();
const foreignOriginal = crypto.randomUUID();
const foreignNote = crypto.randomUUID();
const crossReversal = crypto.randomUUID();

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
/** A customer credit note: DR sales 1000, DR output VAT 150, CR AR 1150. */
async function creditNoteLegs(entry: string, owner: string, rev: string, vat: string, ar: string | null) {
  await line(entry, owner, rev, 1000, 0, 'standard');
  await line(entry, owner, vat, 150, 0, 'standard');
  if (ar) await line(entry, owner, ar, 0, 1150, null);
}
async function reversedLegs(entry: string, owner: string, rev: string, vat: string, ar: string | null) {
  await line(entry, owner, rev, 0, 1000, 'standard');
  await line(entry, owner, vat, 0, 150, 'standard');
  if (ar) await line(entry, owner, ar, 1150, 0, null);
}
async function cancelledNote(id: string, owner: string, number: string, date: string, entry: string) {
  await pool.query(
    `INSERT INTO credit_notes(id,company_id,credit_note_number,type,credit_date,
       subtotal,tax_amount,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,$3,'customer',$4,1000,150,1150,'cancelled',$5,$6)`,
    [id, owner, number, date, entry, user],
  );
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [
    company, 'K-032 adjacent', other, 'K-032 adjacent other',
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

  // 1. Credit note raised in June, cancelled once June had closed: the reversal
  //    carries a July date.
  await journal(lateOriginal, company, 'K032A-LATE', '2026-06-15', null);
  await creditNoteLegs(lateOriginal, company, revenue, vatOutput, receivable);
  await journal(lateReversal, company, 'K032A-LATE-REV', '2026-07-10', lateOriginal);
  await reversedLegs(lateReversal, company, revenue, vatOutput, receivable);
  await cancelledNote(lateNote, company, 'K032A-1', '2026-06-15', lateOriginal);

  // 2. Cancelled in June, then the reversal itself reversed by hand in June.
  await journal(twiceOriginal, company, 'K032A-TWICE', '2026-06-16', null);
  await creditNoteLegs(twiceOriginal, company, revenue, vatOutput, receivable);
  await journal(twiceReversal, company, 'K032A-TWICE-REV', '2026-06-17', twiceOriginal);
  await reversedLegs(twiceReversal, company, revenue, vatOutput, receivable);
  await journal(twiceRereversal, company, 'K032A-TWICE-REV2', '2026-06-18', twiceReversal);
  await creditNoteLegs(twiceRereversal, company, revenue, vatOutput, receivable);
  await cancelledNote(twiceNote, company, 'K032A-2', '2026-06-16', twiceOriginal);

  // 3. Legacy cancelled note with no reversal at all, in July.
  await journal(legacyOriginal, company, 'K032A-LEGACY', '2026-07-05', null);
  await creditNoteLegs(legacyOriginal, company, revenue, vatOutput, receivable);
  await cancelledNote(legacyNote, company, 'K032A-3', '2026-07-05', legacyOriginal);

  // 4. Company A's cancelled original, with company B carrying a journal that
  //    names it in reversal_of_id. B's boxes must not lose that journal.
  await journal(foreignOriginal, company, 'K032A-FGN', '2026-06-19', null);
  await creditNoteLegs(foreignOriginal, company, revenue, vatOutput, receivable);
  await cancelledNote(foreignNote, company, 'K032A-4', '2026-06-19', foreignOriginal);
  await journal(crossReversal, other, 'K032A-CROSS', '2026-06-19', foreignOriginal);
  await reversedLegs(crossReversal, other, otherRevenue, otherVatOutput, null);
});

afterAll(async () => {
  try {
    // Company B's cross-tenant journal names a company A row, so every
    // reversal link has to go before any journal does.
    for (const owner of [company, other]) {
      await pool.query('UPDATE gl_journal_entries SET reversal_of_id=NULL WHERE company_id=$1', [owner]);
    }
    for (const owner of [company, other]) {
      await pool.query('DELETE FROM credit_notes WHERE company_id=$1', [owner]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [owner]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [owner]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [owner]);
      await pool.query('DELETE FROM companies WHERE id=$1', [owner]);
    }
  } finally {
    await pool.end();
  }
});

async function boxes(owner: string, period: [string, string]) {
  const { lines } = await getVatPeriodLines(owner, ...period);
  return { lines, basis: deriveVatBoxes(lines) };
}

it('keeps the original in its own period when the reversal is dated into the next', async () => {
  const { lines } = await boxes(company, JUNE);
  const original = lines.filter((l) => l.journalEntryId === lateOriginal);
  expect(original.length).toBeGreaterThan(0);
  expect(original.every((l) => l.cancelledSource === false)).toBe(true);
});

it('takes the credit in the period the reversal is dated into', async () => {
  const { lines } = await boxes(company, JULY);
  const reversal = lines.filter((l) => l.journalEntryId === lateReversal);
  expect(reversal.length).toBeGreaterThan(0);
  expect(reversal.every((l) => l.cancelledSource === false)).toBe(true);
});

it('does not re-admit the cancelled VAT when the reversal is itself reversed', async () => {
  const { lines } = await boxes(company, JUNE);
  const trio = [twiceOriginal, twiceReversal, twiceRereversal];
  const suppressed = lines.filter((l) => trio.includes(l.journalEntryId));
  expect(suppressed.length).toBe(9);
  expect(suppressed.every((l) => l.cancelledSource === true)).toBe(true);
});

it('still suppresses a cancelled credit note that was never reversed', async () => {
  const { lines } = await boxes(company, JULY);
  const legacy = lines.filter((l) => l.journalEntryId === legacyOriginal);
  expect(legacy.length).toBeGreaterThan(0);
  expect(legacy.every((l) => l.cancelledSource === true)).toBe(true);
});

it('nets June to the standing original plus the reversed pair only', async () => {
  const { basis } = await boxes(company, JUNE);
  // lateOriginal stands (a credit note debits output VAT); the twice-reversed
  // trio and the cross-tenant original are suppressed.
  expect.soft(basis.outputTax).toBeCloseTo(-150, 2);
  expect.soft(basis.outputBase).toBeCloseTo(-1000, 2);
});

it('does not suppress company B lines that name company A journals', async () => {
  const { lines, basis } = await boxes(other, JUNE);
  const cross = lines.filter((l) => l.journalEntryId === crossReversal);
  expect(cross.length).toBeGreaterThan(0);
  expect(cross.every((l) => l.cancelledSource === false)).toBe(true);
  expect(lines.every((l) => l.journalEntryId !== foreignOriginal)).toBe(true);
  expect.soft(basis.outputTax).toBeCloseTo(150, 2);
});
