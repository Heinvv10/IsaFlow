// Adversarial repros for PR #1156 (cashFlowIndirectService), ported from the review's isaflow_dev run to a disposable
// database: one fresh company, every scenario inside BEGIN ... ROLLBACK on one client bound through ALS, so nothing
// persists between cases. B1 (the seeded Long-term Loans) went green with migration 958. B3 (a dividend declared to a GENERIC
// current_liability) stays a KNOWN LIMIT, no dividend liability account is seeded: it is `it.fails`, so it goes
// green-and-loud the day such an account carries a subtype.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertDisposableDb } from '../helpers/assertDisposableDb';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { als } from '@/lib/als';
import { getIndirectCashFlow, type IndirectCashFlow } from '@/modules/accounting/services/reports/cashFlowIndirectService';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));

const CO = randomUUID();
const OTHER_CO = randomUUID();
const LT_LOANS_2210 = randomUUID(); // the seeded "Long-term Loans" (2210), as seed_company_chart_of_accounts creates it (958: long_term_liability)
const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  assertDisposableDb('This test creates and deletes companies and accounts.');
  for (const c of [CO, OTHER_CO]) await pool.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)`, [c, `CF adv ${c.slice(0, 6)}`]);
  // The seeded chart itself, not a hand-made row: this is the account a new company really gets.
  await pool.query('SELECT public.seed_company_chart_of_accounts($1)', [CO]);
  await pool.query(`UPDATE gl_accounts SET id = $1 WHERE company_id = $2 AND account_code = '2210'`, [LT_LOANS_2210, CO]);
}, 60_000);
afterAll(async () => {
  try {
    for (const c of [CO, OTHER_CO]) {
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [c]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [c]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [c]);
      await pool.query('DELETE FROM companies WHERE id = $1', [c]);
    }
  } finally { await pool.end(); }
});

type Ctx = { c: PoolClient; acct: (t: string, s: string | null, nb?: string, parent?: string) => Promise<string>;
  j: (date: string, legs: Array<[string, number, number]>, o?: { status?: string; source?: string; co?: string }) => Promise<string> };

async function inTx<T>(fn: (x: Ctx) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    const acct: Ctx['acct'] = async (t, s, nb, parent) => {
      const id = randomUUID();
      await c.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, parent_account_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, CO, `ADV${id.slice(0, 8)}`, `ADV ${t} ${s}`, t, s,
        nb ?? (['asset', 'expense'].includes(t) ? 'debit' : 'credit'), parent ?? null]);
      return id;
    };
    const j: Ctx['j'] = async (date, legs, o = {}) => {
      const co = o.co ?? CO;
      const e = await c.query(`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by)
        VALUES ($1,$2,$3,'adv1156','draft',$4,$1) RETURNING id`, [co, `ADV-${randomUUID().slice(0, 8)}`, date, o.source ?? 'manual']);
      for (const [a, dr, cr] of legs) await c.query(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,$4,$5)`, [co, e.rows[0].id, a, dr, cr]);
      if ((o.status ?? 'posted') === 'posted') await c.query(`UPDATE gl_journal_entries SET status='posted' WHERE id=$1`, [e.rows[0].id]);
      return e.rows[0].id as string;
    };
    return await als.run({ client: c, userId: CO, companyId: CO, claims: {} } as never, () => fn({ c, acct, j }));
  } finally { await c.query('ROLLBACK'); c.release(); }
}

const line = (r: IndirectCashFlow, label: string) => r.sections.flatMap((s) => s.items).find((i) => i.label === label)?.amount ?? 0;
const sec = (r: IndirectCashFlow, name: string) => r.sections.find((s) => s.section.startsWith(name))!.total;
async function tie(start: string, end: string) {
  const ind = await getIndirectCashFlow(CO, start, end);
  const gl = (await getCashBalance(CO, end)).total;
  const dir = await getCashFlowDirect(CO, start, end);
  return { ind, gl, dir };
}
const P = ['2026-11-01', '2026-11-30'] as const;

describeIfDb('PR #1156 adversarial: tie-out', () => {
  it('H1 mixed realistic month (VAT, cash+credit sale, receipt, supplier pay, VAT pay, payroll+PAYE, depreciation, asset buy, loan, dividends, drawings, interbank, FX bank, petty, null-subtype, draft, other co) ties to GL and to the direct method', async () => {
    await inTx(async ({ acct, j }) => {
      const bank = await acct('asset', 'bank'), bankUsd = await acct('asset', 'bank_account'), petty = await acct('asset', 'petty_cash');
      const ar = await acct('asset', 'receivable'), vin = await acct('asset', 'vat_input'), vout = await acct('liability', 'vat_output');
      const ap = await acct('liability', 'payable'), rev = await acct('revenue', 'revenue'), opex = await acct('expense', 'operating_expense');
      const sal = await acct('expense', 'payroll_expense'), paye = await acct('liability', 'payroll_liability'), net = await acct('liability', 'payroll_liability');
      const dep = await acct('expense', 'depreciation_expense'), acc = await acct('asset', 'accumulated_depreciation', 'credit');
      const fa = await acct('asset', 'fixed_asset'), loan = await acct('liability', 'long_term_liability'), divs = await acct('equity', 'dividends', 'debit');
      const draw = await acct('equity', 'drawings', 'debit'), nullA = await acct('asset', null), fx = await acct('revenue', 'other_income');
      await j('2026-11-02', [[bank, 1150, 0], [rev, 0, 1000], [vout, 0, 150]]);
      await j('2026-11-03', [[ar, 2300, 0], [rev, 0, 2000], [vout, 0, 300]]);
      await j('2026-11-04', [[bank, 2300, 0], [ar, 0, 2300]]);
      await j('2026-11-05', [[opex, 1000, 0], [vin, 150, 0], [ap, 0, 1150]]);
      await j('2026-11-06', [[ap, 1150, 0], [bank, 0, 1150]]);
      await j('2026-11-07', [[vout, 300, 0], [vin, 0, 150], [bank, 0, 150]]);
      await j('2026-11-08', [[sal, 10000, 0], [paye, 0, 2000], [net, 0, 8000]]);
      await j('2026-11-09', [[net, 8000, 0], [bank, 0, 8000]]);
      await j('2026-11-10', [[paye, 2000, 0], [bank, 0, 2000]]);
      await j('2026-11-11', [[dep, 500, 0], [acc, 0, 500]]);
      await j('2026-11-12', [[fa, 6000, 0], [vin, 900, 0], [bank, 0, 6900]]);
      await j('2026-11-13', [[bank, 50000, 0], [loan, 0, 50000]]);
      await j('2026-11-14', [[loan, 5000, 0], [bank, 0, 5000]]);
      await j('2026-11-15', [[divs, 3000, 0], [bank, 0, 3000]]);
      await j('2026-11-16', [[draw, 700, 0], [bank, 0, 700]]);
      await j('2026-11-17', [[bankUsd, 4000, 0], [bank, 0, 4000]]);
      await j('2026-11-18', [[bankUsd, 123.45, 0], [fx, 0, 123.45]]); // FX revaluation of the USD bank
      await j('2026-11-19', [[petty, 300, 0], [bank, 0, 300]]);
      await j('2026-11-20', [[opex, 80, 0], [petty, 0, 80]]);
      await j('2026-11-21', [[nullA, 90, 0], [petty, 0, 90]]);
      await j('2026-11-22', [[bank, 999, 0], [rev, 0, 999]], { status: 'draft' });
      const { ind, gl, dir } = await tie(...P);
      expect(ind.closingCash).toBe(gl);
      expect(ind.closingCash).toBeCloseTo(dir.closingCash, 2);
      expect(ind.openingCash + ind.netChange).toBeCloseTo(ind.closingCash, 2);
      expect(line(ind, 'Change in VAT Control')).toBe(150 + 300 - 150 - 900 - 300 + 150);
      expect(line(ind, 'Depreciation and Amortisation (non-cash)')).toBe(500);
      expect(line(ind, 'Change in Loans and Borrowings')).toBe(45000);
      expect(line(ind, 'Fixed Asset Changes')).toBe(-6000);
    });
  });

  it('H2 a period crossing the FY boundary with a year-end closing journal and a reversed journal still ties', async () => {
    await inTx(async ({ acct, j, c }) => {
      const bank = await acct('asset', 'bank'), rev = await acct('revenue', 'revenue'), re = await acct('equity', 'retained_earnings');
      await j('2027-02-15', [[bank, 400, 0], [rev, 0, 400]]);
      await j('2027-02-28', [[rev, 400, 0], [re, 0, 400]], { source: YEAR_END_JOURNAL_SOURCE });
      const orig = await j('2026-12-05', [[bank, 777, 0], [rev, 0, 777]]);
      const rv = await j('2026-12-06', [[rev, 777, 0], [bank, 0, 777]]);
      await c.query(`UPDATE gl_journal_entries SET reversal_of_id=$1 WHERE id=$2`, [orig, rv]);
      for (const [s, e] of [['2026-12-01', '2027-02-28'], ['2027-02-01', '2027-03-31'], ['2026-12-05', '2026-12-05']] as const) {
        const { ind, gl, dir } = await tie(s, e);
        expect(ind.closingCash, `${s}..${e}`).toBe(gl);
        expect(ind.closingCash).toBeCloseTo(dir.closingCash, 2);
      }
    });
  });

  it('H3 another company\'s posted cash in the same dates never reaches this statement', async () => {
    await inTx(async ({ c }) => {
      const before = await getIndirectCashFlow(CO, ...P);
      const other = OTHER_CO;
      const ob = randomUUID(), orv = randomUUID();
      await c.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance) VALUES
        ($1,$3,'ADVOB','x','asset','bank','debit'),($2,$3,'ADVOR','x','revenue','revenue','credit')`, [ob, orv, other]);
      const e = await c.query(`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by) VALUES ($1,'ADV-O','2026-11-05','x','draft',$1) RETURNING id`, [other]);
      await c.query(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,777,0),($1,$2,$4,0,777)`, [other, e.rows[0].id, ob, orv]);
      await c.query(`UPDATE gl_journal_entries SET status='posted' WHERE id=$1`, [e.rows[0].id]);
      expect(await getIndirectCashFlow(CO, ...P)).toEqual(before);
    });
  });
});

describeIfDb('PR #1156 adversarial: classification', () => {
  it('B1 loan drawdown on the SEEDED "Long-term Loans" account (2210, subtype long_term_liability since 958) belongs in Financing, not Operating', async () => {
    await inTx(async ({ acct, j }) => {
      const bank = await acct('asset', 'bank');
      await j('2026-11-10', [[bank, 50000, 0], [LT_LOANS_2210, 0, 50000]]);
      const { ind } = await tie(...P);
      expect(sec(ind, 'Financing'), JSON.stringify(ind.sections)).toBe(50000);
      expect(sec(ind, 'Operating')).toBe(0);
    });
  });

  it('B2 asset disposal: proceeds in Investing, depreciation add-back not driven negative by the disposal', async () => {
    await inTx(async ({ acct, j }) => {
      const bank = await acct('asset', 'bank'), fa = await acct('asset', 'fixed_asset'), acc = await acct('asset', 'accumulated_depreciation', 'credit');
      const gain = await acct('revenue', 'disposal_profit_loss');
      // cost 10 000, accumulated depreciation 4 000, sold for 7 000 -> gain 1 000
      await j('2026-11-15', [[bank, 7000, 0], [acc, 4000, 0], [fa, 0, 10000], [gain, 0, 1000]], { source: 'auto_asset_disposal' });
      const { ind, dir } = await tie(...P);
      void dir;
      expect(sec(ind, 'Investing'), JSON.stringify(ind.sections)).toBe(7000);
      expect(line(ind, 'Depreciation and Amortisation (non-cash)')).toBeGreaterThanOrEqual(0);
      expect(sec(ind, 'Operating')).toBe(0);
    });
  });

  it.fails('B3 dividend declared to a current liability, paid next month: the payment is Financing', async () => {
    await inTx(async ({ acct, j }) => {
      const bank = await acct('asset', 'bank'), divs = await acct('equity', 'dividends', 'debit'), payable = await acct('liability', 'current_liability');
      await j('2026-10-20', [[divs, 3000, 0], [payable, 0, 3000]]);
      await j('2026-11-10', [[payable, 3000, 0], [bank, 0, 3000]]);
      const { ind, dir } = await tie(...P);
      expect(sec(ind, 'Financing'), JSON.stringify(ind.sections) + ' direct fin=' + dir.financingTotal).toBe(-3000);
    });
  });

  it('B2b a disposal at a LOSS: proceeds in Investing, the loss out of Operating, both methods the same', async () => {
    await inTx(async ({ acct, j }) => {
      const bank = await acct('asset', 'bank'), fa = await acct('asset', 'fixed_asset'), acc = await acct('asset', 'accumulated_depreciation', 'credit');
      const pl = await acct('revenue', 'disposal_profit_loss');
      // cost 10 000, accumulated depreciation 4 000, sold for 5 000 -> loss 1 000
      await j('2026-11-15', [[bank, 5000, 0], [acc, 4000, 0], [pl, 1000, 0], [fa, 0, 10000]], { source: 'auto_asset_disposal' });
      const { ind, dir } = await tie(...P);
      expect({ op: sec(ind, 'Operating'), inv: sec(ind, 'Investing'), fin: sec(ind, 'Financing') }).toEqual({ op: 0, inv: 5000, fin: 0 });
      expect({ op: dir.operatingTotal, inv: dir.investingTotal }).toEqual({ op: 0, inv: 5000 });
      expect(line(ind, '(Gain) / Loss on Disposal of Assets')).toBe(1000);
    });
  });

  it('B2c ordinary depreciation is still added back in Operating next to a disposal', async () => {
    await inTx(async ({ acct, j }) => {
      const bank = await acct('asset', 'bank'), fa = await acct('asset', 'fixed_asset'), acc = await acct('asset', 'accumulated_depreciation', 'credit');
      const gain = await acct('revenue', 'disposal_profit_loss'), dep = await acct('expense', 'depreciation_expense');
      await j('2026-11-01', [[dep, 500, 0], [acc, 0, 500]]);
      await j('2026-11-15', [[bank, 7000, 0], [acc, 4000, 0], [fa, 0, 10000], [gain, 0, 1000]], { source: 'auto_asset_disposal' });
      const { ind } = await tie(...P);
      expect(line(ind, 'Depreciation and Amortisation (non-cash)')).toBe(500);
      expect(sec(ind, 'Investing')).toBe(7000);
      expect(sec(ind, 'Operating')).toBe(7000 + 0 - 7000 + 0 + (-500 + 500) + 0); // net income 500 (gain 1000 - dep 500) + 500 add-back - 1000 gain = 0
    });
  });

  it('B5 a credit card spelled with a bank subtype (a LIABILITY) is Financing in both methods', async () => {
    await inTx(async ({ acct, j }) => {
      const bank = await acct('asset', 'bank'), card = await acct('liability', 'bank_account'), opex = await acct('expense', 'operating_expense');
      await j('2026-11-03', [[opex, 800, 0], [card, 0, 800]]);   // spend on the card: no cash
      await j('2026-11-20', [[card, 800, 0], [bank, 0, 800]]);   // paid off from the bank
      // The spend accrues a card liability (Financing, with credit cards), the expense is in net income (Operating).
      const spend = await getIndirectCashFlow(CO, '2026-11-03', '2026-11-03');
      expect(line(spend, 'Change in Loans and Borrowings')).toBe(800);
      expect(line(spend, 'Net Income')).toBe(-800);
      expect(line(spend, 'Change in Other Operating Assets and Liabilities')).toBe(0);
      // and the repayment alone, in its own month, is a financing outflow on both
      const later = await getIndirectCashFlow(CO, '2026-11-20', '2026-11-20');
      const laterDir = await getCashFlowDirect(CO, '2026-11-20', '2026-11-20');
      expect(sec(later, 'Financing')).toBe(-800);
      expect(laterDir.financingTotal).toBe(-800);
    });
  });

  it('B4 indirect section totals agree with the direct method section totals (same period, same books)', async () => {
    await inTx(async ({ acct, j }) => {
      const bank = await acct('asset', 'bank'), fa = await acct('asset', 'fixed_asset'), acc = await acct('asset', 'accumulated_depreciation', 'credit');
      const gain = await acct('revenue', 'disposal_profit_loss');
      await j('2026-11-15', [[bank, 7000, 0], [acc, 4000, 0], [fa, 0, 10000], [gain, 0, 1000]]);
      await j('2026-11-16', [[bank, 20000, 0], [LT_LOANS_2210, 0, 20000]]);
      const { ind, dir } = await tie(...P);
      expect({ op: sec(ind, 'Operating'), inv: sec(ind, 'Investing'), fin: sec(ind, 'Financing') })
        .toEqual({ op: dir.operatingTotal, inv: dir.investingTotal, fin: dir.financingTotal });
    });
  });
});

describeIfDb('PR #1156 adversarial: account flags that must not matter', () => {
  it('A1 deactivated accounts (a cash account and a non-cash one) still count: the picker flag says nothing about whether an account holds money', async () => {
    await inTx(async ({ acct, j, c }) => {
      const bank = await acct('asset', 'bank'), oldBank = await acct('asset', 'bank'), rev = await acct('revenue', 'revenue'), oldLoan = await acct('liability', 'long_term_liability');
      await j('2026-11-04', [[bank, 100, 0], [rev, 0, 100]]);
      await j('2026-11-05', [[oldBank, 900, 0], [oldLoan, 0, 900]]);
      await c.query('UPDATE gl_accounts SET is_active = false WHERE id = ANY($1::uuid[])', [[oldBank, oldLoan]]);
      const { ind, gl } = await tie(...P);
      expect(ind.closingCash).toBe(gl);
      expect(ind.unexplainedDifference).toBe(0);
      expect(line(ind, 'Change in Loans and Borrowings')).toBe(900);
    });
  });
});

describeIfDb('PR #1156 adversarial: by-construction tie assumptions', () => {
  it('L1 a year_end-sourced journal that touches cash: closing must still equal GL cash', async () => {
    await inTx(async ({ acct, j }) => {
      const bank = await acct('asset', 'bank'), re = await acct('equity', 'retained_earnings');
      await j('2026-11-30', [[bank, 1234, 0], [re, 0, 1234]], { source: YEAR_END_JOURNAL_SOURCE });
      const { ind, gl } = await tie(...P);
      expect(ind.closingCash).toBe(gl);
      expect(ind.unexplainedDifference).toBe(1234);
      const u = ind.sections.find((s) => s.section === 'Unexplained Difference')!;
      expect(u.items).toEqual([expect.objectContaining({ amount: 1234, label: expect.stringMatching(/^Unexplained difference/) })]);
      expect(ind.openingCash + ind.netChange).toBeCloseTo(ind.closingCash, 2);
    });
  });

  it('L2 a posted journal that does not balance (line added after posting): closing must still equal GL cash', async () => {
    await inTx(async ({ acct, j, c }) => {
      const bank = await acct('asset', 'bank'), rev = await acct('revenue', 'revenue');
      const id = await j('2026-11-12', [[bank, 500, 0], [rev, 0, 500]]);
      await c.query(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,250,0)`, [CO, id, bank]);
      const { ind, gl } = await tie(...P);
      expect(ind.closingCash).toBe(gl);
      expect(ind.unexplainedDifference).toBe(250);
      expect(ind.openingCash + ind.netChange).toBeCloseTo(ind.closingCash, 2);
    });
  });

  it('L3 a cash account whose subtype is spelled "Bank" (case) is cash to canonicalSubtype but not to the SQL', async () => {
    await inTx(async ({ acct, j }) => {
      const bankCap = await acct('asset', 'Bank'), rev = await acct('revenue', 'revenue');
      await j('2026-11-12', [[bankCap, 500, 0], [rev, 0, 500]]);
      const { ind, gl } = await tie(...P);
      expect(ind.closingCash).toBe(gl);
      expect(line(ind, 'Change in Other Operating Assets and Liabilities'), 'cash spelled Bank shown as an operating movement').toBe(0);
    });
  });
});

describeIfDb('PR #1156 adversarial: response shape', () => {
  it('S1 route keeps report.{period_start,period_end,opening_cash,sections[{section,items[{label,amount}],total}],net_change,closing_cash}; CSV keeps its header and summary rows', async () => {
    await inTx(async () => {
      const mk = () => { const r = { statusCode: 200, body: undefined as unknown, setHeader() { return r; }, status(c: number) { r.statusCode = c; return r; }, json(p: unknown) { r.body = p; return r; }, send(p: unknown) { r.body = p; return r; }, end() { return r; } }; return r; };
      const route = (await import('../../pages/api/accounting/reports-cash-flow')).default as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>;
      const res = mk();
      await route({ method: 'GET', query: { period_start: P[0], period_end: P[1] }, headers: {}, companyId: CO, user: { id: CO } } as never, res as never);
      const rep = (res.body as { data: { report: Record<string, unknown> } }).data.report;
      expect(Object.keys(rep).sort()).toEqual(['closing_cash', 'net_change', 'opening_cash', 'period_end', 'period_start', 'sections']);
      const secs = rep.sections as Array<{ section: string; items: Array<{ label: string }> }>;
      expect(secs.map((s) => s.section)).toEqual(['Operating Activities', 'Investing Activities', 'Financing Activities']);
      expect(secs[0].items.slice(0, 3).map((i) => i.label)).toEqual(['Net Income', 'Change in Accounts Receivable', 'Change in Accounts Payable']);
      const exp = (await import('../../pages/api/accounting/cash-flow-export')).default as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>;
      const r2 = mk();
      await exp({ method: 'GET', query: { period_start: P[0], period_end: P[1] }, headers: {}, companyId: CO } as never, r2 as never);
      const csv = String(r2.body).split('\n');
      expect(csv[0]).toBe('Section,Description,Amount');
      expect(csv).toContain('"Operating Activities","Total Operating Activities",' + (rep.sections as Array<{ total: number }>)[0].total.toFixed(2));
      expect(csv.slice(-3).map((l) => l.split(',')[1])).toEqual(['"Net Cash Flow"', '"Opening Balance"', '"Closing Balance"']);
    });
  });
});
