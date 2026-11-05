// The indirect and direct methods are two presentations of one cash flow: on every journal they must give the same
// operating / investing / financing totals. Only cash that actually moved through the cash accounts is an investing or
// financing flow (IAS 7.6, 7.16-17; a part of a transaction settled without cash is non-cash, 7.43).
// Repros from the adversarial review of #1176: journals with legs running both ways (bought partly on account, a loan repaid
// from the proceeds in the same journal) where the direct method gave every leg its whole amount.
import { describe, expect, it, vi } from 'vitest';
import { getCashFlowReconciliation } from '@/modules/accounting/services/afs/cashFlowReconciliationService';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import { CO, describeIfDb, inTx, installCompanies, sec, tie, P, type Ctx } from './helpers/cashFlowAdversarialFixture';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));

installCompanies();

async function totals(start = P[0], end = P[1]) {
  const { ind, dir } = await tie(start, end);
  return {
    ind: { op: sec(ind, 'Operating'), inv: sec(ind, 'Investing'), fin: sec(ind, 'Financing') },
    dir: { op: dir.operatingTotal, inv: dir.investingTotal, fin: dir.financingTotal },
    ind_full: ind, dir_full: dir,
  };
}
const near = (o: { op: number; inv: number; fin: number }) => ({ op: Math.round(o.op * 100) / 100 || 0, inv: Math.round(o.inv * 100) / 100 || 0, fin: Math.round(o.fin * 100) / 100 || 0 });

/** The three accounts nearly every case needs. */
async function kit({ acct }: Pick<Ctx, 'acct'>) {
  return { bank: await acct('asset', 'bank'), fa: await acct('asset', 'fixed_asset'), acc: await acct('asset', 'accumulated_depreciation', 'credit'), gain: await acct('revenue', 'disposal_profit_loss') };
}

describeIfDb('cash flow: the indirect and direct methods agree on every journal', () => {
  it('asset bought for 10 000 + 1 500 VAT, 6 500 on account, 5 000 paid: only the 5 000 paid is cash (investing), on both', async () => {
    await inTx(async (x) => {
      const k = await kit(x); const vin = await x.acct('asset', 'vat_input'), ap = await x.acct('liability', 'payable');
      await x.j('2026-11-15', [[k.fa, 10000, 0], [vin, 1500, 0], [ap, 0, 6500], [k.bank, 0, 5000]]);
      const t = await totals();
      expect(near(t.ind)).toEqual({ op: 0, inv: -5000, fin: 0 });
      expect(near(t.dir)).toEqual({ op: 0, inv: -5000, fin: 0 });
    });
  });

  it('a disposal whose proceeds repay a loan inside the same journal: the repayment never passed the bank (non-cash), on both', async () => {
    await inTx(async (x) => {
      const k = await kit(x); const loan = await x.acct('liability', 'long_term_liability');
      await x.j('2026-11-15', [[k.bank, 2000, 0], [loan, 5000, 0], [k.acc, 4000, 0], [k.fa, 0, 10000], [k.gain, 0, 1000]], { source: 'auto_asset_disposal' });
      const t = await totals();
      expect(near(t.ind)).toEqual({ op: 0, inv: 2000, fin: 0 });
      expect(near(t.dir)).toEqual({ op: 0, inv: 2000, fin: 0 });
    });
  });

  it('the same disposal when the proceeds go through the bank first and the loan is repaid in a second journal: gross, on both', async () => {
    await inTx(async (x) => {
      const k = await kit(x); const loan = await x.acct('liability', 'long_term_liability');
      await x.j('2026-11-15', [[k.bank, 7000, 0], [k.acc, 4000, 0], [k.fa, 0, 10000], [k.gain, 0, 1000]], { source: 'auto_asset_disposal' });
      await x.j('2026-11-16', [[loan, 5000, 0], [k.bank, 0, 5000]]);
      const t = await totals();
      expect(near(t.ind)).toEqual({ op: 0, inv: 7000, fin: -5000 });
      expect(near(t.dir)).toEqual({ op: 0, inv: 7000, fin: -5000 });
    });
  });

  it('an asset of 10 000 bought with 2 000 cash and an 8 000 loan: 2 000 investing and no financing, on both', async () => {
    await inTx(async (x) => {
      const k = await kit(x); const loan = await x.acct('liability', 'long_term_liability');
      await x.j('2026-11-15', [[k.fa, 10000, 0], [loan, 0, 8000], [k.bank, 0, 2000]]);
      const t = await totals();
      expect(near(t.ind)).toEqual({ op: 0, inv: -2000, fin: 0 });
      expect(near(t.dir)).toEqual({ op: 0, inv: -2000, fin: 0 });
    });
  });

  it('a sale part paid in cash, part on account keeps its operating lines (cash received from customers 500)', async () => {
    await inTx(async (x) => {
      const bank = await x.acct('asset', 'bank'), ar = await x.acct('asset', 'receivable'), rev = await x.acct('revenue', 'revenue');
      await x.j('2026-11-15', [[bank, 500, 0], [ar, 500, 0], [rev, 0, 1000]]);
      const t = await totals();
      expect(near(t.ind)).toEqual({ op: 500, inv: 0, fin: 0 });
      expect(near(t.dir)).toEqual({ op: 500, inv: 0, fin: 0 });
      expect(t.dir_full.operatingItems).toEqual([expect.objectContaining({ cashGroup: 'cash_received_from_customers', amount: 500 })]);
    });
  });

  it('a loan repayment debiting the seeded current-portion account (2215) is financing on both, not operating on one', async () => {
    await inTx(async (x) => {
      const bank = await x.acct('asset', 'bank');
      const id = (await x.c.query(
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_system_account)
         VALUES ($1,'2215','Current portion of long-term debt','liability','current_liability','credit',true) RETURNING id`, [CO])).rows[0].id as string;
      await x.j('2026-11-15', [[id, 1000, 0], [bank, 0, 1000]]);
      const t = await totals();
      expect(near(t.ind)).toEqual({ op: 0, inv: 0, fin: -1000 });
      expect(near(t.dir)).toEqual({ op: 0, inv: 0, fin: -1000 });
    });
  });

  it('a transfer between two bank accounts and a cash leg with no other leg move nothing between sections', async () => {
    await inTx(async (x) => {
      const a = await x.acct('asset', 'bank'), b = await x.acct('asset', 'bank');
      await x.j('2026-11-15', [[a, 300, 0], [b, 0, 300]]);
      const t = await totals();
      expect(near(t.ind)).toEqual({ op: 0, inv: 0, fin: 0 });
      expect(near(t.dir)).toEqual({ op: 0, inv: 0, fin: 0 });
    });
  });

  it('the direct statement closes on the ledger cash', async () => {
    await inTx(async (x) => {
      const k = await kit(x); const vin = await x.acct('asset', 'vat_input'), ap = await x.acct('liability', 'payable');
      await x.j('2026-11-15', [[k.fa, 10000, 0], [vin, 1500, 0], [ap, 0, 6500], [k.bank, 0, 5000]]);
      const { dir, gl } = await tie(...P);
      expect(dir.closingCash).toBe(gl);
    });
  });

  it('a payroll run (legs of mixed sign) keeps its operating lines: employees -70 000, not a magnitude-weighted split', async () => {
    await inTx(async (x) => {
      const bank = await x.acct('asset', 'bank'), salary = await x.acct('expense', 'payroll_expense'), paye = await x.acct('liability', 'payroll_liability');
      await x.j('2026-11-15', [[salary, 100000, 0], [paye, 0, 30000], [bank, 0, 70000]]);
      const t = await totals();
      expect(near(t.ind)).toEqual({ op: -70000, inv: 0, fin: 0 });
      expect(near(t.dir)).toEqual({ op: -70000, inv: 0, fin: 0 });
      expect(t.dir_full.operatingItems).toEqual([expect.objectContaining({ cashGroup: 'cash_paid_to_employees', amount: -70000 })]);
    });
  });

  it('a supplier paid and an asset bought in one journal: suppliers -2 000, investing -5 000', async () => {
    await inTx(async (x) => {
      const k = await kit(x), opex = await x.acct('expense', 'operating_expense');
      await x.j('2026-11-15', [[k.fa, 5000, 0], [opex, 2000, 0], [k.bank, 0, 7000]]);
      const t = await totals();
      expect(near(t.dir)).toEqual({ op: -2000, inv: -5000, fin: 0 });
      expect(t.dir_full.operatingItems).toEqual([expect.objectContaining({ cashGroup: 'cash_paid_to_suppliers', amount: -2000 })]);
      expect(near(t.ind)).toEqual(near(t.dir));
    });
  });

  it('a one-sided cash journal (a ledger fault) is kept by the direct statement as other operating, and it closes on the ledger cash', async () => {
    await inTx(async (x) => {
      const bank = await x.acct('asset', 'bank'), other = await x.acct('asset', 'bank');
      // The balance trigger fires on the status change only: a line added to a POSTED journal leaves it unbalanced, here with cash legs only.
      const je = await x.j('2026-11-15', [[bank, 250, 0], [other, 0, 250]]);
      await x.c.query(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,250,0)`, [CO, je, bank]);
      const { dir, gl } = await tie(...P);
      expect(gl).toBe(250);
      expect(dir.operatingItems).toEqual([expect.objectContaining({ cashGroup: 'other_operating', amount: 250 })]);
      expect(dir.unexplainedDifference).toBe(0);
      expect(dir.closingCash).toBe(gl);
    });
  });

  it('a cash leg on the year-end closing journal (a ledger fault) is ignored by both methods: the direct statement closes on the ledger and shows the gap, the reconciliation flags it', async () => {
    await inTx(async (x) => {
      const bank = await x.acct('asset', 'bank'), re = await x.acct('equity', 'retained_earnings');
      await x.j('2026-11-30', [[bank, 400, 0], [re, 0, 400]], { source: YEAR_END_JOURNAL_SOURCE });
      const t = await totals();
      expect(near(t.ind)).toEqual({ op: 0, inv: 0, fin: 0 });
      expect(near(t.dir)).toEqual({ op: 0, inv: 0, fin: 0 });
      expect(t.dir_full.unexplainedDifference).toBe(400);
      expect(t.dir_full.closingCash).toBe(400);
      expect(t.ind_full.unexplainedDifference).toBe(400);
      const rec = await getCashFlowReconciliation(CO, ...P);
      expect(rec.bankBalance).toBe(400);
      expect(rec.isReconciled).toBe(false);
    });
  });
});
