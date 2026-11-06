// The indirect and direct methods are two presentations of one cash flow: on every journal they must give the same
// operating / investing / financing totals. Only cash that actually moved through the cash accounts is an investing or
// financing flow (IAS 7.6, 7.16-17; a part of a transaction settled without cash is non-cash, 7.43).
// Repros from the adversarial review of #1176: journals with legs running both ways (bought partly on account, a loan repaid
// from the proceeds in the same journal) where the direct method gave every leg its whole amount.
import { describe, expect, it, vi } from 'vitest';
import { getCashFlowReconciliation } from '@/modules/accounting/services/afs/cashFlowReconciliationService';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import { CO, OTHER_CO, describeIfDb, inTx, installCompanies, sec, tie, P, type Ctx } from './helpers/cashFlowAdversarialFixture';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));

installCompanies();

/**
 * Both statements for the period, with what must hold on SOUND books checked independently of how they are built:
 * nothing is left unexplained, and the closing cash is the opening cash plus the statement's own three sections (summed
 * here, not read from `netChange`) and the ledger's cash (`getCashBalance`, not the statement's `closingCash`).
 * `fault` marks the one-off cases that post a ledger fault on purpose.
 */
async function totals(start = P[0], end = P[1], { fault = false } = {}) {
  const { ind, dir, gl } = await tie(start, end);
  const t = {
    ind: { op: sec(ind, 'Operating'), inv: sec(ind, 'Investing'), fin: sec(ind, 'Financing') },
    dir: { op: dir.operatingTotal, inv: dir.investingTotal, fin: dir.financingTotal },
    ind_full: ind, dir_full: dir, gl,
  };
  if (!fault) {
    const cents = (n: number) => Math.round(n * 100);
    expect(ind.unexplainedDifference).toBe(0);
    expect(dir.unexplainedDifference).toBe(0);
    expect(cents(ind.openingCash + t.ind.op + t.ind.inv + t.ind.fin)).toBe(cents(gl));
    expect(cents(dir.openingCash + t.dir.op + t.dir.inv + t.dir.fin)).toBe(cents(gl));
  }
  return t;
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

  it('a journal whose cash and legs do not match (a line added to a POSTED journal, the balance trigger fires on the status change only): the mismatch is the Unexplained Difference in BOTH methods', async () => {
    await inTx(async (x) => {
      const bank = await x.acct('asset', 'bank'), other = await x.acct('asset', 'bank'), rev = await x.acct('revenue', 'revenue');
      const add = (je: string, account: string, debit: number, credit: number) => x.c.query(
        `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,$4,$5)`, [CO, je, account, debit, credit]);
      // cash legs only, one-sided: the ledger holds 250 of cash no leg explains
      await add(await x.j('2026-11-15', [[bank, 250, 0], [other, 0, 250]]), bank, 250, 0);
      // a receipt of 100 with 130 of revenue: 30 of leg no cash explains
      await add(await x.j('2026-11-16', [[bank, 100, 0], [rev, 0, 100]]), rev, 0, 30);
      const t = await totals(P[0], P[1], { fault: true });
      expect(t.gl).toBe(350);
      expect(t.dir_full.unexplainedDifference).toBe(220); // 250 cash with no leg, less 30 of leg with no cash
      expect(t.ind_full.unexplainedDifference).toBe(220);
      expect(near(t.dir)).toEqual(near(t.ind));
      expect(t.dir_full.closingCash).toBe(350);
      expect(t.ind_full.closingCash).toBe(350);
    });
  });

  // The adversarial review's probes A, B and D: a posted journal that no longer balances. Each method puts what its legs place in
  // the sections and the rest of the ledger's cash in Unexplained Difference: the same figures in both, never absorbed into operating.
  it.each([
    ['A: a 250 bank debit added to a posted 500 receipt', 500, 250, 750],
    ['B: only the bank line of a 100 receipt left (its revenue line deleted)', 0, 100, 100],
    ['D: a 250 revenue credit added to a posted 500 receipt', 750, -250, 500],
  ] as const)('%s', async (name, operating, unexplained, ledgerCash) => {
    await inTx(async (x) => {
      const bank = await x.acct('asset', 'bank'), rev = await x.acct('revenue', 'revenue');
      const gap = (je: string, account: string, debit: number, credit: number) => x.c.query(
        `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,$4,$5)`, [CO, je, account, debit, credit]);
      if (name.startsWith('A')) await gap(await x.j('2026-11-12', [[bank, 500, 0], [rev, 0, 500]]), bank, 250, 0);
      if (name.startsWith('B')) {
        const je = await x.j('2026-11-12', [[bank, 100, 0], [rev, 0, 100]]);
        await x.c.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2', [je, rev]);
      }
      if (name.startsWith('D')) await gap(await x.j('2026-11-12', [[bank, 500, 0], [rev, 0, 500]]), rev, 0, 250);
      const t = await totals(P[0], P[1], { fault: true });
      expect({ op: t.ind.op, unexplained: t.ind_full.unexplainedDifference, close: t.ind_full.closingCash }).toEqual({ op: operating, unexplained, close: ledgerCash });
      expect({ op: t.dir.op, unexplained: t.dir_full.unexplainedDifference, close: t.dir_full.closingCash }).toEqual({ op: operating, unexplained, close: ledgerCash });
    });
  });

  it('an unbalanced journal with NO cash leg (a stray 100 revenue credit on a receivable/revenue journal): both methods show +100 operating and -100 unexplained', async () => {
    await inTx(async (x) => {
      const ar = await x.acct('asset', 'receivable'), rev = await x.acct('revenue', 'revenue');
      const je = await x.j('2026-11-12', [[ar, 500, 0], [rev, 0, 500]]);
      await x.c.query(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,0,100)`, [CO, je, rev]);
      const t = await totals(P[0], P[1], { fault: true });
      expect(t.gl).toBe(0);
      expect({ op: t.ind.op, unexplained: t.ind_full.unexplainedDifference }).toEqual({ op: 100, unexplained: -100 });
      expect({ op: t.dir.op, unexplained: t.dir_full.unexplainedDifference }).toEqual({ op: 100, unexplained: -100 });
    });
  });

  it('probe L: a 10 cash sale, an accrual (expense 100 / payables 100) and a stray payables credit of 50 on the accrual: both methods 60 operating, -50 unexplained, closing 10', async () => {
    await inTx(async (x) => {
      const bank = await x.acct('asset', 'bank'), rev = await x.acct('revenue', 'revenue'), opex = await x.acct('expense', 'operating_expense'), ap = await x.acct('liability', 'payable');
      await x.j('2026-11-02', [[bank, 10, 0], [rev, 0, 10]]);
      const je = await x.j('2026-11-12', [[opex, 100, 0], [ap, 0, 100]]);
      await x.c.query(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,0,50)`, [CO, je, ap]);
      const t = await totals(P[0], P[1], { fault: true });
      for (const [method, op, unexplained, close] of [['indirect', t.ind.op, t.ind_full.unexplainedDifference, t.ind_full.closingCash], ['direct', t.dir.op, t.dir_full.unexplainedDifference, t.dir_full.closingCash]] as const) {
        expect({ method, op, unexplained, close }).toEqual({ method, op: 60, unexplained: -50, close: 10 });
      }
    });
  });

  it('probe M: a cent of cash shared 0.005/0.005 over two operating groups, three times: the lines are whole cents, add to their section, and the statement foots and closes on the ledger', async () => {
    await inTx(async (x) => {
      const bank = await x.acct('asset', 'bank'), opex = await x.acct('expense', 'operating_expense'), sal = await x.acct('expense', 'payroll_expense'), fa = await x.acct('asset', 'fixed_asset');
      for (const day of ['14', '15', '16']) await x.j(`2026-11-${day}`, [[opex, 1, 0], [sal, 1, 0], [fa, 0, 1.99], [bank, 0, 0.01]]);
      const t = await totals();
      const cents = (n: number) => Math.round(n * 100);
      expect(near(t.ind)).toEqual({ op: -0.03, inv: 0, fin: 0 });
      expect(near(t.dir)).toEqual({ op: -0.03, inv: 0, fin: 0 });
      expect(cents(t.dir_full.operatingItems.reduce((a, i) => a + i.amount, 0))).toBe(-3);
      for (const i of t.dir_full.operatingItems) expect(Math.abs(i.amount * 100 - cents(i.amount))).toBeLessThan(1e-6);
      expect(t.dir_full.closingCash).toBe(-0.03);
    });
  });

  it('a cash leg on the year-end closing journal (a ledger fault) is ignored by both methods: the direct statement closes on the ledger and shows the gap, the reconciliation flags it', async () => {
    await inTx(async (x) => {
      const bank = await x.acct('asset', 'bank'), re = await x.acct('equity', 'retained_earnings');
      await x.j('2026-11-30', [[bank, 400, 0], [re, 0, 400]], { source: YEAR_END_JOURNAL_SOURCE });
      const t = await totals(P[0], P[1], { fault: true });
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

  it('every cash spelling is cash and only this company\'s journals count', async () => {
    await inTx(async (x) => {
      const rev = await x.acct('revenue', 'revenue');
      for (const spelling of ['bank', 'bank_account', 'cash', 'petty_cash']) {
        const cashAccount = await x.acct('asset', spelling);
        await x.j('2026-11-15', [[cashAccount, 100, 0], [rev, 0, 100]]);
      }
      // another company's cash journal, in the same period, must not reach this company's statements
      const theirs = (await x.c.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance)
        VALUES ($1,'TH-1','Their bank','asset','bank','debit'), ($1,'TH-2','Their sales','revenue','revenue','credit') RETURNING id`, [OTHER_CO])).rows.map((r) => r.id as string);
      await x.j('2026-11-15', [[theirs[0]!, 9999, 0], [theirs[1]!, 0, 9999]], { co: OTHER_CO });
      const t = await totals();
      expect(near(t.ind)).toEqual({ op: 400, inv: 0, fin: 0 });
      expect(near(t.dir)).toEqual({ op: 400, inv: 0, fin: 0 });
      expect(t.gl).toBe(400);
    });
  });
});
