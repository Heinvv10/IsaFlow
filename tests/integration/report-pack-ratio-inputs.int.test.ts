// tests/integration/report-pack-ratio-inputs.int.test.ts
//
// THE PACK'S INTEREST, TAX, EMPLOYEE COST AND HEAD COUNT, AGAINST REAL ROWS.
//
// `getReportPackInput` takes these from `readLedgerRatioInputs`: a head count
// off `payroll_employees` as at the window end, and the period's revenue and
// expense movement grouped by account type and subtype, folded by the income
// statement's classifier. The unit tests stub the database, so neither query
// had been checked against a ledger: not the tenant scope, not the account
// type predicate, not who counts as employed on a date.
//
// Two companies whose figures differ in every amount and by an order of
// magnitude: a read not scoped to its company is nowhere near.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';
import { getReportPackInput } from '@/modules/accounting/services/reports/reportPackDataService';
import { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';
import { readHeadCounts } from '@/modules/accounting/services/reports/extendedRatioInputs';

const DATABASE_URL = process.env.DATABASE_URL;
const FROM = '2026-03-01';
const TO = '2026-08-31';

interface Book {
  company: string;
  tag: string;
  sales: number; interest: number; interestEarned: number; wages: number; tax: number; bankCharges: number;
  /** Employed from 2024 with no end date. The rows around them are in `seed`. */
  staff: number;
}

const A: Book = {
  company: '00000000-0000-0000-0000-0000005d0a01', tag: 'a',
  sales: 900_000.4, interest: 31_250.75, interestEarned: 4_100.1, wages: 210_500.35, tax: 48_600.2, bankCharges: 4_200.15, staff: 7,
};
const B: Book = {
  company: '00000000-0000-0000-0000-0000005d0b01', tag: 'b',
  sales: 44_000_000.9, interest: 2_750_000.55, interestEarned: 610_000.45, wages: 9_300_000.05, tax: 3_100_000.6, bankCharges: 88_000.8, staff: 143,
};

const cents = (n: number | undefined): number => Math.round((n ?? Number.NaN) * 100);

function carried(input: Awaited<ReturnType<typeof getReportPackInput>>) {
  return {
    interest: cents(input.interestExpense), interestEarned: cents(input.interestIncome),
    wages: cents(input.employeeCosts), tax: cents(input.taxExpense), staff: input.employeeCount,
  };
}
const seeded = (b: Book) => ({
  interest: cents(b.interest), interestEarned: cents(b.interestEarned), wages: cents(b.wages),
  // At 31 August: the long-standing staff, the June hire and the one who leaves in October.
  tax: cents(b.tax), staff: b.staff + 2,
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

  it.each([['company A', A], ['company B', B]])('%s carries its own interest, tax, employee cost and head count', async (_n, book) => {
    const input = await getReportPackInput(book.company, 'Fixture', FROM, TO);
    expect(carried(input)).toEqual(seeded(book));
    expect(input.ratioInputsUnavailable).toBeUndefined();
  });

  it('prints interest cover off them: operating profit over interest expense', async () => {
    const input = await getReportPackInput(A.company, 'Fixture', FROM, TO);
    const ratios = buildReportPack('management', input, FROM, TO)
      .sections.find((s) => s.type === 'ratios')!.data as Record<string, number | null>;
    expect(ratios.interestCoverage).toBe(Math.round((input.operatingProfit! / A.interest) * 100) / 100);
    expect(ratios.revenuePerEmployee).toBe(Math.round((input.revenue / (A.staff + 2)) * 100) / 100);
  });

  it('leaves out a draft journal and one dated after the window', async () => {
    // Seeded: a draft and a later journal of 5 000 000.00 on each of the
    // interest, interest-earned, salaries and tax accounts.
    expect(carried(await getReportPackInput(A.company, 'Fixture', FROM, TO))).toEqual(seeded(A));
  });

  it('reads the window, not the ledger to date', async () => {
    // 1 111.11 was posted to interest, salaries and tax on 28 February.
    const prior = await getReportPackInput(A.company, 'Fixture', '2025-09-01', '2026-02-28');
    expect([cents(prior.interestExpense), cents(prior.employeeCosts), cents(prior.taxExpense)]).toEqual([111_111, 111_111, 111_111]);
    expect(carried(await getReportPackInput(A.company, 'Fixture', FROM, TO))).toEqual(seeded(A));
  });

  it('does not call bank charges interest, though both are finance cost on the statement', async () => {
    const input = await getReportPackInput(A.company, 'Fixture', FROM, TO);
    expect(cents(input.interestExpense)).toBe(cents(A.interest));
    // The statement's other-expense line holds all three; interest is one of them.
    expect(cents(input.otherExpenses)).toBe(cents(A.interest) + cents(A.bankCharges) + cents(A.tax));
  });

  it('reads nothing off a balance-sheet account carrying the same subtype', async () => {
    // Seeded: an ASSET with subtype raw_materials, a LIABILITY with subtype
    // tax (a VAT control account) and a LIABILITY with subtype salaries, each
    // moved by 777 777.77 in the window.
    const input = await getReportPackInput(A.company, 'Fixture', FROM, TO);
    expect(cents(input.taxExpense)).toBe(cents(A.tax));
    expect(cents(input.employeeCosts)).toBe(cents(A.wages));
    expect(input.directMaterialCosts).toBeUndefined();
  });

  it('reconciles: net profit with the tax put back is the statement\'s profit before tax', async () => {
    const input = await getReportPackInput(A.company, 'Fixture', FROM, TO);
    const beforeTax = cents(input.operatingProfit) - cents(A.interest) - cents(A.bankCharges);
    expect(cents(input.netProfit) + cents(input.taxExpense)).toBe(beforeTax);
    const ratios = buildReportPack('management', input, FROM, TO)
      .sections.find((s) => s.type === 'ratios')!.data as Record<string, number | null>;
    expect(ratios.effectiveTaxRate).toBe(Math.round((cents(A.tax) / beforeTax) * 10000) / 100);
  });

  describe('head count is who was employed on the day', () => {
    const count = async (asAt: string) => (await readHeadCounts(A.company, [asAt]))[0];

    it('at the window end: the long-standing staff, the mid-period hire, and one who left after it', async () => {
      expect(await count(TO)).toBe(A.staff + 2);
    });
    it('before the mid-period hire started, she is not counted', async () => {
      expect(await count('2026-05-31')).toBe(A.staff + 1);
    });
    it('a hire after the window is counted from her start date and not before', async () => {
      expect(await count('2026-09-14')).toBe(A.staff + 2);
      expect(await count('2026-09-15')).toBe(A.staff + 3);
    });
    it('a leaver is counted up to the day before the end date', async () => {
      expect(await count('2026-10-30')).toBe(A.staff + 3);
      expect(await count('2026-10-31')).toBe(A.staff + 2);
      expect(await count('2025-12-30')).toBe(A.staff + 2);
      expect(await count('2025-12-31')).toBe(A.staff + 1);
    });
    it('an inactive row with no end date is counted on no date', async () => {
      expect(await count('2024-06-30')).toBe(A.staff + 2); // the two later leavers, not the inactive row
    });
    it('nobody is counted before anyone started', async () => {
      expect(await count('2023-12-31')).toBe(0);
    });
    it('several dates come back in the order asked, from one query', async () => {
      expect(await readHeadCounts(A.company, [TO, '2023-12-31', '2026-09-15', '2026-05-31']))
        .toEqual([A.staff + 2, 0, A.staff + 3, A.staff + 1]);
    });
    it('the comparative window has its own head count', async () => {
      const prior = await getReportPackInput(A.company, 'Fixture', '2025-09-01', '2026-02-28');
      expect(prior.employeeCount).toBe(A.staff + 1); // the October 2026 leaver; not the June hire
    });
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
      .toEqual({ interest: 0, interestEarned: 0, wages: 0, tax: 0, staff: 0 });
  });
});

// ── fixture helpers ──────────────────────────────────────────────────────────

function accounts(book: Book) {
  const id = (n: number) => `00000000-0000-0000-0000-0000005d${book.tag}1${String(n).padStart(2, '0')}`;
  return {
    bank: id(1), sales: id(2), interest: id(3), interestEarned: id(4), wages: id(5), tax: id(6),
    bankCharges: id(7), stock: id(8), vat: id(9), salariesPayable: id(10),
  };
}

async function seed(admin: Pool, book: Book): Promise<void> {
  const gl = accounts(book);
  await admin.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)`,
    [book.company, `Ratio Inputs Pack Fixture ${book.tag.toUpperCase()}`]);
  await admin.query(
    `INSERT INTO gl_accounts
       (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES
       ($2,  $1, 'PR1000', 'Bank',             'asset',     'bank',             'debit',  true),
       ($3,  $1, 'PR4000', 'Sales',            'revenue',   'sales',            'credit', true),
       ($4,  $1, 'PR6000', 'Loan Interest',    'expense',   'interest_expense', 'debit',  true),
       ($5,  $1, 'PR4500', 'Interest Earned',  'revenue',   'interest_income',  'credit', true),
       ($6,  $1, 'PR5100', 'Salaries',         'expense',   'salaries',         'debit',  true),
       ($7,  $1, 'PR7000', 'Income Tax',       'expense',   'income_tax',       'debit',  true),
       ($8,  $1, 'PR6100', 'Bank Charges',     'expense',   'bank_charges',     'debit',  true),
       ($9,  $1, 'PR1300', 'Raw Materials',    'asset',     'raw_materials',    'debit',  true),
       ($10, $1, 'PR2200', 'VAT Control',      'liability', 'tax',              'credit', true),
       ($11, $1, 'PR2300', 'Salaries Payable', 'liability', 'salaries',         'credit', true)`,
    [book.company, gl.bank, gl.sales, gl.interest, gl.interestEarned, gl.wages, gl.tax,
      gl.bankCharges, gl.stock, gl.vat, gl.salariesPayable],
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
  await postEntry(admin, book, 'charges', '2026-07-10', paid(gl.bankCharges, book.bankCharges));
  await postEntry(admin, book, 'tax', TO, paid(gl.tax, book.tax));
  // The day before the window: the prior window's, not this one's.
  for (const account of [gl.interest, gl.wages, gl.tax]) {
    await postEntry(admin, book, `before-${account.slice(-2)}`, '2026-02-28', paid(account, 1_111.11));
  }
  // Balance-sheet accounts that carry an income-statement subtype.
  await postEntry(admin, book, 'stock', '2026-06-01', paid(gl.stock, 777_777.77));
  await postEntry(admin, book, 'vat', '2026-06-02', paid(gl.vat, 777_777.77));
  await postEntry(admin, book, 'payable', '2026-06-03', paid(gl.salariesPayable, 777_777.77));
  // Neither may reach the read.
  for (const account of [gl.interest, gl.interestEarned, gl.wages, gl.tax]) {
    const legs = account === gl.interestEarned ? received(account, 5_000_000) : paid(account, 5_000_000);
    await postEntry(admin, book, `draft-${account.slice(-2)}`, '2026-05-05', legs, 'draft');
    await postEntry(admin, book, `later-${account.slice(-2)}`, '2026-09-01', legs);
  }

  let n = 0;
  const employ = async (start: string, end: string | null, status: string) => {
    n += 1;
    await admin.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, end_date, status, medical_aid_main_member)
       VALUES ($1, $2, 'Fixture', $3, $4, $5, $6, true)`,
      [book.company, `PR-${n}`, `Employee ${n}`, start, end, status],
    );
  };
  for (let i = 0; i < book.staff; i += 1) await employ('2024-01-01', null, 'active');
  await employ('2024-01-01', '2025-12-31', 'terminated'); // left before both windows ended
  await employ('2026-06-01', null, 'active');             // hired in the window
  await employ('2026-09-15', null, 'active');             // hired after it
  await employ('2024-01-01', '2026-10-31', 'terminated'); // left after it: employed at its end
  await employ('2024-01-01', null, 'inactive');           // no end date, not active: counted nowhere
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
