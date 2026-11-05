// Adversarial repros for the cash flow statement (cashFlowIndirectService), ported from the review's isaflow_dev run to a
// disposable database: the tie to the ledger's cash (H1-H3, L1-L3), account flags that must not matter (A1) and the response
// shape (S1). The disposal repros are in cash-flow-disposals.int.test.ts, cards and parity in cash-flow-cards-parity.int.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getIndirectCashFlow } from '@/modules/accounting/services/reports/cashFlowIndirectService';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';
import { getCashFlowReconciliation } from '@/modules/accounting/services/afs/cashFlowReconciliationService';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import { CO, OTHER_CO, describeIfDb, inTx, installCompanies, line, sec, tie, P, pool } from './helpers/cashFlowAdversarialFixture';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));

installCompanies();

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

  it('L1b the AFS reconciliation FLAGS a ledger whose cash the journals do not explain (the check that used to be a tautology)', async () => {
    await inTx(async ({ acct, j }) => {
      const bank = await acct('asset', 'bank'), re = await acct('equity', 'retained_earnings'), rev = await acct('revenue', 'revenue');
      await j('2026-11-05', [[bank, 100, 0], [rev, 0, 100]]);
      await j('2026-11-30', [[bank, 1234, 0], [re, 0, 1234]], { source: YEAR_END_JOURNAL_SOURCE });
      const rec = await getCashFlowReconciliation(CO, ...P);
      expect(rec.bankBalance).toBe(1334);
      expect(rec.indirectClosing).toBe(100); // what the journals' movements reach
      expect(rec.isReconciled).toBe(false);
      expect(rec.variance).toBeCloseTo(1234, 2);
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
      expect(ind.sections.find((x) => x.section === 'Unexplained Difference')!.total).toBe(250);
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
