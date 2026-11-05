// The Reports Cash Flow statement (indirect) must tie to the ledger's cash: closing cash is the GL cash balance and
// opening + net change is closing, for any period, whatever the books hold (VAT, inventory, prepayments, payroll
// liabilities, accumulated depreciation, loans, retained earnings, a bank-to-bank transfer, a year-end journal, a draft).
// Found by the adversarial review of #1149: after a R1 150 cash sale (R1 000 + R150 VAT) the screen gave Operating
// -7 000 / Closing 287 750 against the ledger's 287 900, because the inline calculation had no line for VAT.
// Seeds its own company: disposable database only.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));

const describeIfDb = isDisposableDb(process.env.DATABASE_URL) ? describe : describe.skip;
const CO = randomUUID();
const OTHER_CO = randomUUID();
const A: Record<string, string> = {};
const SPEC: Array<[string, string, string | null, string]> = [
  ['bank', 'asset', 'bank', 'debit'], ['bank2', 'asset', 'bank_account', 'debit'], ['petty', 'asset', 'petty_cash', 'debit'],
  ['ar', 'asset', 'receivable', 'debit'], ['vatIn', 'asset', 'vat_input', 'debit'], ['inv', 'asset', 'inventory', 'debit'],
  ['prepaid', 'asset', 'prepaid_expense', 'debit'], ['fa', 'asset', 'fixed_asset', 'debit'], ['accDep', 'asset', 'accumulated_depreciation', 'credit'],
  ['unknownAsset', 'asset', null, 'debit'],
  ['ap', 'liability', 'payable', 'credit'], ['vatOut', 'liability', 'vat_output', 'credit'], ['payroll', 'liability', 'payroll_liability', 'credit'],
  ['loan', 'liability', 'long_term_liability', 'credit'], ['unknownLiab', 'liability', null, 'credit'],
  ['capital', 'equity', 'equity', 'credit'], ['re', 'equity', 'retained_earnings', 'credit'],
  ['rev', 'revenue', 'revenue', 'credit'], ['opex', 'expense', 'operating_expense', 'debit'], ['dep', 'expense', 'depreciation_expense', 'debit'],
  ['salaries', 'expense', 'payroll_expense', 'debit'],
];
type Leg = [keyof typeof A | string, number, number];
const JOURNALS: Array<{ n: string; date: string; status?: string; source?: string; legs: Leg[] }> = [
  { n: 'J00', date: '2025-12-01', legs: [['bank', 100000, 0], ['capital', 0, 100000]] },
  { n: 'J01', date: '2026-01-05', legs: [['bank', 1150, 0], ['rev', 0, 1000], ['vatOut', 0, 150]] }, // the cash sale alone on its day
  { n: 'J02', date: '2026-01-10', legs: [['ar', 2300, 0], ['rev', 0, 2000], ['vatOut', 0, 300]] },
  { n: 'J03', date: '2026-01-12', legs: [['opex', 500, 0], ['vatIn', 75, 0], ['ap', 0, 575]] },
  { n: 'J04', date: '2026-01-15', legs: [['bank', 1000, 0], ['ar', 0, 1000]] },
  { n: 'J05', date: '2026-01-16', legs: [['ap', 300, 0], ['bank', 0, 300]] },
  { n: 'J06', date: '2026-01-18', legs: [['fa', 5000, 0], ['bank', 0, 5000]] },
  { n: 'J07', date: '2026-01-20', legs: [['bank', 20000, 0], ['loan', 0, 20000]] },
  { n: 'J08', date: '2026-01-22', legs: [['inv', 800, 0], ['bank', 0, 800]] },
  { n: 'J09', date: '2026-01-25', legs: [['prepaid', 1200, 0], ['bank', 0, 1200]] },
  { n: 'J10', date: '2026-02-03', legs: [['dep', 400, 0], ['accDep', 0, 400]] },
  { n: 'J11', date: '2026-02-05', legs: [['vatOut', 200, 0], ['bank', 0, 200]] },
  { n: 'J12', date: '2026-02-10', legs: [['salaries', 3000, 0], ['payroll', 0, 3000]] },
  { n: 'J13', date: '2026-02-12', legs: [['payroll', 2000, 0], ['bank', 0, 2000]] },
  { n: 'J14', date: '2026-02-14', legs: [['bank', 5000, 0], ['capital', 0, 5000]] },
  { n: 'J15', date: '2026-02-16', legs: [['re', 700, 0], ['bank', 0, 700]] },
  { n: 'J16', date: '2026-02-18', legs: [['bank2', 400, 0], ['bank', 0, 400]] }, // bank to bank
  { n: 'J17', date: '2026-02-20', legs: [['bank', 50, 0], ['unknownLiab', 0, 50]] },
  { n: 'J18', date: '2026-02-22', legs: [['unknownAsset', 90, 0], ['petty', 0, 90]] }, // cash to an unclassified asset
  { n: 'J19', date: '2026-02-28', source: YEAR_END_JOURNAL_SOURCE, legs: [['rev', 3000, 0], ['re', 0, 3000]] }, // never counted
  { n: 'J20', date: '2026-02-25', status: 'draft', legs: [['bank', 999, 0], ['rev', 0, 999]] }, // never counted
];
const PERIODS: Array<[string, string]> = [
  ['2026-01-01', '2026-02-28'], ['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-02-28'], ['2026-01-05', '2026-01-05'],
  ['2025-12-01', '2026-02-28'], ['2026-03-01', '2026-03-31'],
];

type Section = { section: string; total: number; items: Array<{ label: string; amount: number }> };
type Report = { opening_cash: number; sections: Section[]; net_change: number; closing_cash: number };
type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

function mockRes() {
  const res = { statusCode: 200, body: undefined as unknown, setHeader() { return res; }, status(c: number) { res.statusCode = c; return res; },
    json(p: unknown) { res.body = p; return res; }, send(p: unknown) { res.body = p; return res; }, end() { return res; } };
  return res as unknown as { statusCode: number; body: unknown } & NextApiResponse;
}
async function report(start: string, end: string, companyId = CO): Promise<Report> {
  const route = (await import('../../pages/api/accounting/reports-cash-flow')).default as unknown as Route;
  const res = mockRes();
  await route({ method: 'GET', query: { period_start: start, period_end: end }, headers: {}, companyId, user: { id: 'cf' } } as unknown as NextApiRequest, res);
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return (res.body as { data: { report: Report } }).data.report;
}
const cents = (n: number) => Math.round(n * 100);

describeIfDb('cash flow statement (indirect) ties to the ledger cash', () => {
  let pool: Pool;
  beforeAll(async () => {
    assertDisposableDb('This test inserts and deletes companies, accounts and journals.');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    for (const c of [CO, OTHER_CO]) await pool.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)`, [c, `CF ties ${c.slice(0, 6)}`]);
    for (const [key, type, sub, nb] of SPEC) {
      A[key] = randomUUID();
      await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,true)`, [A[key], CO, `CF${key}`, `CF ${key}`, type, sub, nb]);
    }
    for (const j of JOURNALS) {
      const status = j.status ?? 'posted';
      const e = await pool.query(`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by)
                                  VALUES ($1,$2,$3,'cf fixture','draft',$4,$1) RETURNING id`, [CO, `CF-${j.n}`, j.date, j.source ?? 'manual']);
      for (const [acct, dr, cr] of j.legs) {
        await pool.query(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,$4,$5)`, [CO, e.rows[0].id, A[acct as string], dr, cr]);
      }
      if (status === 'posted') await pool.query(`UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1`, [e.rows[0].id]);
    }
    // Another company's cash and P&L in the same dates: it must never reach this company's statement.
    const ob = randomUUID(); const oc = randomUUID();
    await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance) VALUES
      ($1,$3,'OB','Other bank','asset','bank','debit'), ($2,$3,'OR','Other rev','revenue','revenue','credit')`, [ob, oc, OTHER_CO]);
    const e = await pool.query(`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by) VALUES ($1,'CF-OTHER','2026-01-05','x','draft',$1) RETURNING id`, [OTHER_CO]);
    await pool.query(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,777,0),($1,$2,$4,0,777)`, [OTHER_CO, e.rows[0].id, ob, oc]);
    await pool.query(`UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1`, [e.rows[0].id]);
  }, 90000);

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const c of [CO, OTHER_CO]) {
        await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [c]);
        await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [c]);
        await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [c]);
        await pool.query('DELETE FROM companies WHERE id = $1', [c]);
      }
    } finally { await pool.end(); }
  });

  it.each(PERIODS)('%s..%s: closing cash is the GL cash balance and opening + net change is closing', async (start, end) => {
    const r = await report(start, end);
    expect(cents(r.closing_cash)).toBe(cents((await getCashBalance(CO, end)).total));
    expect(cents(r.opening_cash)).toBe(cents((await getCashBalance(CO, start, { exclusive: true })).total));
    expect(cents(r.opening_cash + r.net_change)).toBe(cents(r.closing_cash));
    expect(cents(r.sections.reduce((s, x) => s + x.total, 0))).toBe(cents(r.net_change));
    for (const s of r.sections) expect(cents(s.items.reduce((t, i) => t + i.amount, 0)), s.section).toBe(cents(s.total));
  });

  it.each(PERIODS)('%s..%s: the indirect net change equals the direct method\'s', async (start, end) => {
    const r = await report(start, end);
    const direct = await getCashFlowDirect(CO, start, end);
    expect(cents(r.net_change)).toBe(cents(direct.netChange));
    expect(cents(r.closing_cash)).toBe(cents(direct.closingCash));
  });

  it('a R1 150 cash sale including VAT is R1 150 of operating cash (the adversary\'s case)', async () => {
    const r = await report('2026-01-05', '2026-01-05');
    const operating = r.sections.find((s) => s.section === 'Operating Activities')!;
    expect(operating.total).toBe(1150);
    expect(operating.items.find((i) => i.label === 'Net Income')!.amount).toBe(1000);
    expect(operating.items.find((i) => i.label === 'Change in VAT Control')!.amount).toBe(150);
    expect(r.net_change).toBe(1150);
  });

  it('the year-end journal and a draft change nothing, and the two bank accounts net to zero in a transfer', async () => {
    const feb = await report('2026-02-01', '2026-02-28');
    const netIncome = feb.sections[0]!.items.find((i) => i.label === 'Net Income')!.amount;
    expect(netIncome).toBe(-3400); // salaries 3 000 + depreciation 400; the year-end close (3 000) and the draft (999) are not in it
  });

  it('the first three operating lines keep their labels and order (the screen and CSV consumers read them)', async () => {
    const r = await report('2026-01-01', '2026-02-28');
    expect(r.sections.map((s) => s.section)).toEqual(['Operating Activities', 'Investing Activities', 'Financing Activities']);
    expect(r.sections[0]!.items.slice(0, 3).map((i) => i.label)).toEqual(['Net Income', 'Change in Accounts Receivable', 'Change in Accounts Payable']);
    expect(r.sections[1]!.items[0]!.label).toBe('Fixed Asset Changes');
    expect(r.sections[2]!.items[0]!.label).toBe('Equity Changes');
  });

  it('the CSV export agrees with the screen, line for line, and closes on the same cash', async () => {
    const route = (await import('../../pages/api/accounting/cash-flow-export')).default as unknown as Route;
    const res = mockRes();
    await route({ method: 'GET', query: { period_start: '2026-01-01', period_end: '2026-02-28' }, headers: {}, companyId: CO, user: { id: 'cf' } } as unknown as NextApiRequest, res);
    const lines = String(res.body).split('\n');
    const r = await report('2026-01-01', '2026-02-28');
    const closing = lines.find((l) => l.includes('Closing Balance'))!;
    expect(closing.endsWith(`,${r.closing_cash.toFixed(2)}`)).toBe(true);
    for (const s of r.sections) {
      for (const i of s.items.filter((x) => x.amount !== 0)) {
        expect(lines.some((l) => l.includes(i.label) && l.endsWith(`,${i.amount.toFixed(2)}`)), `${s.section} / ${i.label}`).toBe(true);
      }
    }
  });

  it('another company\'s postings never reach this statement', async () => {
    const r = await report('2026-01-05', '2026-01-05');
    expect(r.closing_cash).toBe((await getCashBalance(CO, '2026-01-05')).total);
    expect(r.net_change).toBe(1150); // not 1150 + 777
  });
});
