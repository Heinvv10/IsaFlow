// tests/integration/report-pack-ratio-inputs.int.test.ts
//
// THE PACK'S INTEREST, TAX, EMPLOYEE COST AND HEAD COUNT, AGAINST REAL ROWS.
//
// `getReportPackInput` takes these from `readLedgerRatioInputs`: a head count
// off `payroll_employees` and one query summing journal lines by account
// subtype. The unit tests stub the database, so neither the subtype matching
// nor the tenant scope of either query had been checked against a ledger.
//
// Two companies whose figures differ in every amount and by an order of
// magnitude: a read not scoped to its company is nowhere near.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';
import { getReportPackInput } from '@/modules/accounting/services/reports/reportPackDataService';
import { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';

const DATABASE_URL = process.env.DATABASE_URL;
const FROM = '2026-03-01';
const TO = '2026-08-31';

interface Book {
  company: string;
  tag: string;
  sales: number; interest: number; interestEarned: number; wages: number; tax: number; materials: number;
  /** Employed now, and one who left last year. */
  staff: number;
}

const A: Book = {
  company: '00000000-0000-0000-0000-0000005d0a01', tag: 'a',
  sales: 900_000.4, interest: 31_250.75, interestEarned: 4_100.1, wages: 210_500.35, tax: 48_600.2, materials: 120_000.15, staff: 7,
};
const B: Book = {
  company: '00000000-0000-0000-0000-0000005d0b01', tag: 'b',
  sales: 44_000_000.9, interest: 2_750_000.55, interestEarned: 610_000.45, wages: 9_300_000.05, tax: 3_100_000.6, materials: 8_800_000.8, staff: 143,
};

const cents = (n: number | undefined): number => Math.round((n ?? Number.NaN) * 100);

function carried(input: Awaited<ReturnType<typeof getReportPackInput>>) {
  return {
    interest: cents(input.interestExpense), interestEarned: cents(input.interestIncome),
    wages: cents(input.employeeCosts), tax: cents(input.taxExpense), materials: cents(input.directMaterialCosts),
    staff: input.employeeCount,
  };
}
const seeded = (b: Book) => ({
  interest: cents(b.interest), interestEarned: cents(b.interestEarned), wages: cents(b.wages),
  tax: cents(b.tax), materials: cents(b.materials), staff: b.staff,
});

// Only on a throwaway database: this seeds whole companies.
const describeIfDb = isDisposableDb(DATABASE_URL) ? describe : describe.skip;

describeIfDb('the report pack\'s ratio inputs, read from real rows', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertDisposableDb('This test inserts and deletes companies, accounts, journals and employees.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);
    for (const book of [A, B]) await seed(admin, book);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it.each([['company A', A], ['company B', B]])('%s carries its own interest, tax, employee cost, materials and head count', async (_n, book) => {
    const input = await getReportPackInput(book.company, 'Fixture', FROM, TO);
    expect(carried(input)).toEqual(seeded(book));
    expect(input.ratioInputsUnavailable).toBeUndefined();
  });

  it('prints interest cover off them: operating profit over interest expense', async () => {
    const input = await getReportPackInput(A.company, 'Fixture', FROM, TO);
    const ratios = buildReportPack('management', input, FROM, TO)
      .sections.find((s) => s.type === 'ratios')!.data as Record<string, number | null>;
    expect(ratios.interestCoverage).toBe(Math.round((input.operatingProfit! / A.interest) * 100) / 100);
    expect(ratios.revenuePerEmployee).toBe(Math.round((input.revenue / A.staff) * 100) / 100);
  });

  it('leaves out a draft journal, one dated after the window, and an employee who has left', async () => {
    // Seeded: a draft and a later journal of 5 000 000.00 on every one of the
    // five accounts, and one employee whose end date is in the past.
    expect(carried(await getReportPackInput(A.company, 'Fixture', FROM, TO))).toEqual(seeded(A));
  });

  it('never lets one company\'s rows reach another\'s pack', async () => {
    const a = carried(await getReportPackInput(A.company, 'Fixture', FROM, TO));
    await admin.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [B.company]);
    await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [B.company]);
    await admin.query('DELETE FROM payroll_employees WHERE company_id = $1', [B.company]);
    // A's are A's alone: removing B's books and staff changes nothing for A.
    expect(carried(await getReportPackInput(A.company, 'Fixture', FROM, TO))).toEqual(a);
    // And B, with nothing left, carries nil rather than A's.
    expect(carried(await getReportPackInput(B.company, 'Fixture', FROM, TO)))
      .toEqual({ interest: 0, interestEarned: 0, wages: 0, tax: 0, materials: 0, staff: 0 });
  });
});

// ── fixture helpers ──────────────────────────────────────────────────────────

function accounts(book: Book) {
  const id = (n: number) => `00000000-0000-0000-0000-0000005d${book.tag}1${String(n).padStart(2, '0')}`;
  return { bank: id(1), sales: id(2), interest: id(3), interestEarned: id(4), wages: id(5), tax: id(6), materials: id(7) };
}

async function seed(admin: Pool, book: Book): Promise<void> {
  const gl = accounts(book);
  await admin.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)`,
    [book.company, `Ratio Inputs Pack Fixture ${book.tag.toUpperCase()}`]);
  await admin.query(
    `INSERT INTO gl_accounts
       (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES
       ($2, $1, 'PR1000', 'Bank',            'asset',   'bank',             'debit',  true),
       ($3, $1, 'PR4000', 'Sales',           'revenue', 'sales',            'credit', true),
       ($4, $1, 'PR6000', 'Loan Interest',   'expense', 'interest_expense', 'debit',  true),
       ($5, $1, 'PR4500', 'Interest Earned', 'revenue', 'interest_income',  'credit', true),
       ($6, $1, 'PR5100', 'Salaries',        'expense', 'salaries',         'debit',  true),
       ($7, $1, 'PR7000', 'Income Tax',      'expense', 'income_tax',       'debit',  true),
       ($8, $1, 'PR5000', 'Raw Materials',   'expense', 'raw_materials',    'debit',  true)`,
    [book.company, gl.bank, gl.sales, gl.interest, gl.interestEarned, gl.wages, gl.tax, gl.materials],
  );
  const received = (contra: string, amount: number) => [
    { account: gl.bank, debit: amount, credit: 0 }, { account: contra, debit: 0, credit: amount }];
  const paid = (contra: string, amount: number) => [
    { account: gl.bank, debit: 0, credit: amount }, { account: contra, debit: amount, credit: 0 }];

  // First and last day of the window included.
  await postEntry(admin, book, 'sales', FROM, received(gl.sales, book.sales));
  await postEntry(admin, book, 'earned', '2026-04-30', received(gl.interestEarned, book.interestEarned));
  await postEntry(admin, book, 'interest', '2026-05-31', paid(gl.interest, book.interest));
  await postEntry(admin, book, 'wages', '2026-06-25', paid(gl.wages, book.wages));
  await postEntry(admin, book, 'materials', '2026-07-10', paid(gl.materials, book.materials));
  await postEntry(admin, book, 'tax', TO, paid(gl.tax, book.tax));
  // Neither may reach the read.
  for (const account of [gl.interest, gl.interestEarned, gl.wages, gl.tax, gl.materials]) {
    const legs = account === gl.interestEarned ? received(account, 5_000_000) : paid(account, 5_000_000);
    await postEntry(admin, book, `draft-${account.slice(-2)}`, '2026-05-05', legs, 'draft');
    await postEntry(admin, book, `later-${account.slice(-2)}`, '2026-09-01', legs);
  }

  for (let n = 1; n <= book.staff; n += 1) await employ(admin, book, n, null);
  await employ(admin, book, book.staff + 1, '2025-12-31');
}

async function employ(admin: Pool, book: Book, n: number, endDate: string | null): Promise<void> {
  await admin.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, end_date)
     VALUES ($1, $2, 'Fixture', $3, '2024-01-01', $4)`,
    [book.company, `PR-${n}`, `Employee ${n}`, endDate],
  );
}

async function postEntry(
  admin: Pool, book: Book, name: string, entryDate: string,
  legs: Array<{ account: string; debit: number; credit: number }>, status: 'posted' | 'draft' = 'posted',
): Promise<void> {
  const { rows } = await admin.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
     VALUES ($1, $2, $3, 'pack ratio inputs fixture', $4, $5)
     RETURNING id`,
    [book.company, `pri-${book.tag}-${name}`, entryDate, status, book.company],
  );
  for (const leg of legs) {
    await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1, $2, $3, $4, $5)`,
      [book.company, rows[0].id, leg.account, leg.debit, leg.credit],
    );
  }
}

async function cleanup(admin: Pool): Promise<void> {
  const companies = [A.company, B.company];
  await admin.query('DELETE FROM payroll_employees WHERE company_id = ANY($1)', [companies]);
  await admin.query('DELETE FROM gl_journal_lines WHERE company_id = ANY($1)', [companies]);
  await admin.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)', [companies]);
  await admin.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [companies]);
  await admin.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
}
