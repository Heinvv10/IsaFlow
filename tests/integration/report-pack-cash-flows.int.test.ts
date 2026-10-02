// tests/integration/report-pack-cash-flows.int.test.ts
//
// THE PACK'S CASH FLOWS, AGAINST REAL JOURNALS.
//
// `getReportPackInput` reads the window's operating, investing and financing
// cash flows from the direct-method statement and carries them beside the
// balance-sheet cash the figures resolver reads. Page 8 of the board pack
// bridges one period's closing cash to the next through them, so the claim
// that matters is an identity:
//
//     opening cash + operating + investing + financing = closing cash
//
// where opening cash is the PRIOR window's `cash`. The unit tests stub the
// statement, so that identity had never been checked against a ledger, and
// neither had the tenant scope of the read.
//
// Two companies with different books; non-round amounts, so a sum that is
// right only to the nearest rand fails.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';
import { getReportPackInput } from '@/modules/accounting/services/reports/reportPackDataService';
import { priorPeriod } from '@/modules/accounting/services/reports/priorPeriod';

const DATABASE_URL = process.env.DATABASE_URL;

const FROM = '2026-03-01';
const TO = '2026-08-31';
const PRIOR = priorPeriod(FROM, TO); // 2025-09-01 .. 2026-02-28

interface Book {
  company: string;
  /** Distinguishes the two companies' account and entry ids. */
  tag: string;
  /** Cash put in before the prior window, by a share issue. */
  seed: number;
  /** One cash movement per activity in the PRIOR window. */
  prior: { receipt: number; supplier: number };
  /** The cash movements of the window under test. */
  current: { receipt: number; supplier: number; wages: number; vehicle: number; loanDrawn: number; dividend: number };
}

const A: Book = {
  company: '00000000-0000-0000-0000-0000005c0a01', tag: 'a',
  seed: 250_000.55,
  prior: { receipt: 81_250.4, supplier: 30_100.15 },
  current: { receipt: 412_345.67, supplier: 155_020.31, wages: 98_760.12, vehicle: 64_999.99, loanDrawn: 120_000.5, dividend: 15_000.25 },
};
// Different in every figure, and an order of magnitude larger: if any read
// were not scoped to its company, A's answers would be nowhere near.
const B: Book = {
  company: '00000000-0000-0000-0000-0000005c0b01', tag: 'b',
  seed: 9_000_000.01,
  prior: { receipt: 1_500_000.33, supplier: 700_000.77 },
  current: { receipt: 7_777_777.77, supplier: 3_333_333.33, wages: 1_111_111.11, vehicle: 2_222_222.22, loanDrawn: 4_444_444.44, dividend: 555_555.55 },
};

const cents = (n: number): number => Math.round(n * 100);

function expected(book: Book) {
  const c = book.current;
  return {
    opening: cents(book.seed) + cents(book.prior.receipt) - cents(book.prior.supplier),
    operating: cents(c.receipt) - cents(c.supplier) - cents(c.wages),
    investing: -cents(c.vehicle),
    financing: cents(c.loanDrawn) - cents(c.dividend),
  };
}

// Only on a throwaway database: this seeds whole companies. On a shared one
// (isaflow_dev) the suite skips rather than write to it.
const describeIfDb = isDisposableDb(DATABASE_URL) ? describe : describe.skip;

describeIfDb('the report pack\'s cash flows, read from real journals', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertDisposableDb('This test inserts and deletes companies, accounts and journals.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);
    for (const book of [A, B]) await seed(admin, book);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  describe.each([['company A', A], ['company B', B]])('%s', (_name, book) => {
    it('states each activity\'s cash flow as the ledger has it', async () => {
      const input = await getReportPackInput(book.company, 'Fixture', FROM, TO);
      const want = expected(book);
      expect(cents(input.operatingCashFlow!)).toBe(want.operating);
      expect(cents(input.investingCashFlow!)).toBe(want.investing);
      expect(cents(input.financingCashFlow!)).toBe(want.financing);
      expect(input.cashFlowUnavailable).toBeNull();
    });

    it('foots: the prior window\'s closing cash plus the three flows is this window\'s closing cash', async () => {
      const input = await getReportPackInput(book.company, 'Fixture', FROM, TO);
      const prior = await getReportPackInput(book.company, 'Fixture', PRIOR.start, PRIOR.end);
      const want = expected(book);

      expect(cents(prior.cash)).toBe(want.opening);
      expect(
        cents(prior.cash) + cents(input.operatingCashFlow!) + cents(input.investingCashFlow!) + cents(input.financingCashFlow!),
      ).toBe(cents(input.cash));
      expect(cents(input.cash)).toBe(want.opening + want.operating + want.investing + want.financing);
    });

    it('agrees with the ledger\'s own cash balance at the window end', async () => {
      const input = await getReportPackInput(book.company, 'Fixture', FROM, TO);
      const { rows } = await admin.query(
        `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric AS balance
           FROM gl_journal_lines jl
           JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
           JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE jl.company_id = $1 AND je.status = 'posted' AND je.entry_date <= $2
            AND ga.account_type = 'asset' AND ga.account_subtype IN ('bank', 'petty_cash')`,
        [book.company, TO],
      );
      expect(cents(input.cash)).toBe(cents(Number(rows[0].balance)));
    });

    it('leaves out a draft journal and one dated after the window', async () => {
      // Both are seeded on the bank account for 1 000 000.00 each; either
      // reaching the read would move every figure above by a million.
      const input = await getReportPackInput(book.company, 'Fixture', FROM, TO);
      expect(cents(input.operatingCashFlow!)).toBe(expected(book).operating);
    });
  });

  it('never lets one company\'s journals reach another\'s pack', async () => {
    const a = await getReportPackInput(A.company, 'Fixture', FROM, TO);
    const b = await getReportPackInput(B.company, 'Fixture', FROM, TO);
    expect(cents(a.operatingCashFlow!)).not.toBe(cents(b.operatingCashFlow!));
    // A's figures are A's alone: removing B's books changes nothing for A.
    await admin.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [B.company]);
    await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [B.company]);
    const after = await getReportPackInput(A.company, 'Fixture', FROM, TO);
    expect([after.operatingCashFlow, after.investingCashFlow, after.financingCashFlow, after.cash])
      .toEqual([a.operatingCashFlow, a.investingCashFlow, a.financingCashFlow, a.cash]);
    // And B, with no journals left, states nil flows rather than A's.
    const emptied = await getReportPackInput(B.company, 'Fixture', FROM, TO);
    expect([emptied.operatingCashFlow, emptied.investingCashFlow, emptied.financingCashFlow, emptied.cash])
      .toEqual([0, 0, 0, 0]);
  });
});

// ── fixture helpers ──────────────────────────────────────────────────────────

/** Account ids, unique per company: bank, petty, equity, sales, opex, payroll, vehicle, loan. */
function accounts(book: Book) {
  const id = (n: number) => `00000000-0000-0000-0000-0000005c${book.tag}1${String(n).padStart(2, '0')}`;
  return {
    bank: id(1), petty: id(2), equity: id(3), sales: id(4), opex: id(5), payroll: id(6), vehicle: id(7), loan: id(8),
  };
}

async function seed(admin: Pool, book: Book): Promise<void> {
  const gl = accounts(book);
  await admin.query(
    `INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)`,
    [book.company, `Cash Flow Pack Fixture ${book.tag.toUpperCase()}`],
  );
  await admin.query(
    `INSERT INTO gl_accounts
       (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES
       ($2, $1, 'PC1000', 'Bank',           'asset',     'bank',                'debit',  true),
       ($3, $1, 'PC1010', 'Petty Cash',     'asset',     'petty_cash',          'debit',  true),
       ($4, $1, 'PC3000', 'Share Capital',  'equity',    'equity',              'credit', true),
       ($5, $1, 'PC4000', 'Sales',          'revenue',   'sales',               'credit', true),
       ($6, $1, 'PC5000', 'Operating Exp',  'expense',   'operating_expense',   'debit',  true),
       ($7, $1, 'PC5100', 'Salaries',       'expense',   'payroll_expense',     'debit',  true),
       ($8, $1, 'PC1500', 'Motor Vehicles', 'asset',     'fixed_assets',        'debit',  true),
       ($9, $1, 'PC2500', 'Bank Loan',      'liability', 'long_term_liability', 'credit', true)`,
    [book.company, gl.bank, gl.petty, gl.equity, gl.sales, gl.opex, gl.payroll, gl.vehicle, gl.loan],
  );

  const inflow = (contra: string, amount: number) => [
    { account: gl.bank, debit: amount, credit: 0 }, { account: contra, debit: 0, credit: amount },
  ];
  const outflow = (contra: string, amount: number) => [
    { account: gl.bank, debit: 0, credit: amount }, { account: contra, debit: amount, credit: 0 },
  ];
  const { prior, current } = book;

  // Before the prior window: the share issue that funds the company.
  await postEntry(admin, book, 'seed', '2025-06-30', inflow(gl.equity, book.seed));
  // Prior window.
  await postEntry(admin, book, 'p-receipt', '2025-11-14', inflow(gl.sales, prior.receipt));
  await postEntry(admin, book, 'p-supplier', '2026-02-28', outflow(gl.opex, prior.supplier));
  // The window under test, first and last day included.
  await postEntry(admin, book, 'c-receipt', '2026-03-01', inflow(gl.sales, current.receipt));
  await postEntry(admin, book, 'c-supplier', '2026-04-17', outflow(gl.opex, current.supplier));
  await postEntry(admin, book, 'c-wages', '2026-05-25', outflow(gl.payroll, current.wages));
  await postEntry(admin, book, 'c-vehicle', '2026-06-09', outflow(gl.vehicle, current.vehicle));
  await postEntry(admin, book, 'c-loan', '2026-07-01', inflow(gl.loan, current.loanDrawn));
  await postEntry(admin, book, 'c-dividend', '2026-08-31', outflow(gl.equity, current.dividend));
  // A transfer to petty cash: cash to cash, not a flow, and not a change in cash.
  await postEntry(admin, book, 'c-petty', '2026-07-15', [
    { account: gl.bank, debit: 0, credit: 1_234.56 }, { account: gl.petty, debit: 1_234.56, credit: 0 },
  ]);
  // Neither of these may reach the read: a draft, and a journal after the window.
  await postEntry(admin, book, 'c-draft', '2026-05-05', inflow(gl.sales, 1_000_000), 'draft');
  await postEntry(admin, book, 'c-later', '2026-09-01', inflow(gl.sales, 1_000_000));
}

async function postEntry(
  admin: Pool,
  book: Book,
  name: string,
  entryDate: string,
  legs: Array<{ account: string; debit: number; credit: number }>,
  status: 'posted' | 'draft' = 'posted',
): Promise<void> {
  const { rows } = await admin.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
     VALUES ($1, $2, $3, 'pack cash flow fixture', $4, $5)
     RETURNING id`,
    [book.company, `pcf-${book.tag}-${name}`, entryDate, status, book.company],
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
  await admin.query('DELETE FROM gl_journal_lines WHERE company_id = ANY($1)', [companies]);
  await admin.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)', [companies]);
  await admin.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [companies]);
  await admin.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
}
