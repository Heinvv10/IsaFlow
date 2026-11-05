// The adversarial review's disposal repros (B2, B2b, B2c, H) and the two known limits for liabilities with no subtype (B1, B3,
// `it.fails`: they read as current, on the balance sheet too; the data fix is the chart's subtype, migration 958 for the seeded 2210).
import { describe, expect, it, vi } from 'vitest';
import { CO, LT_LOANS_2210, describeIfDb, inTx, installCompanies, line, sec, tie, P } from './helpers/cashFlowAdversarialFixture';
import { getIndirectCashFlow, type IndirectCashFlow } from '@/modules/accounting/services/reports/cashFlowIndirectService';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';


vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));

installCompanies();

describeIfDb('cash flow disposals (the review\'s B1/B2/B3 and H)', () => {
  it.fails('B1 (known limit: a liability with no subtype is current) loan drawdown on the SEEDED "Long-term Loans" account (2210, subtype NULL) belongs in Financing, not Operating', async () => {
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

  it.fails('B3 (known limit) dividend declared to a current liability, paid next month: the payment is Financing', async () => {
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

  describe('accumulated depreciation moves to Investing only in a disposal journal (H)', () => {
    const parity = (ind: IndirectCashFlow, dir: Awaited<ReturnType<typeof getCashFlowDirect>>) =>
      expect({ op: sec(ind, 'Operating'), inv: sec(ind, 'Investing'), fin: sec(ind, 'Financing') }).toEqual({ op: dir.operatingTotal, inv: dir.investingTotal, fin: dir.financingTotal });

    it('a depreciation charge and its reversal net to nothing: no made-up Operating +X / Investing -X', async () => {
      await inTx(async ({ acct, j }) => {
        const dep = await acct('expense', 'depreciation_expense'), acc = await acct('asset', 'accumulated_depreciation', 'credit');
        await j('2026-11-03', [[dep, 500, 0], [acc, 0, 500]]);
        await j('2026-11-04', [[acc, 500, 0], [dep, 0, 500]]);
        const { ind, dir } = await tie(...P);
        expect(sec(ind, 'Investing')).toBe(0);
        expect(line(ind, 'Depreciation and Amortisation (non-cash)')).toBe(0);
        parity(ind, dir);
      });
    });

    it('a reclass between two accumulated-depreciation accounts moves nothing', async () => {
      await inTx(async ({ acct, j }) => {
        const a1 = await acct('asset', 'accumulated_depreciation', 'credit'), a2 = await acct('asset', 'accumulated_depreciation', 'credit');
        await j('2026-11-05', [[a1, 300, 0], [a2, 0, 300]]);
        const { ind } = await tie(...P);
        expect(sec(ind, 'Investing')).toBe(0);
        expect(sec(ind, 'Operating')).toBe(0);
      });
    });

    it('a disposal reversed ALONE in the next month: Investing -7000 on both methods (the reversal copies the disposal source)', async () => {
      await inTx(async ({ acct, j }) => {
        const bank = await acct('asset', 'bank'), fa = await acct('asset', 'fixed_asset'), acc = await acct('asset', 'accumulated_depreciation', 'credit');
        const gain = await acct('revenue', 'disposal_profit_loss');
        await j('2026-11-15', [[bank, 7000, 0], [acc, 4000, 0], [fa, 0, 10000], [gain, 0, 1000]], { source: 'auto_asset_disposal' });
        await j('2026-12-02', [[bank, 0, 7000], [acc, 0, 4000], [fa, 10000, 0], [gain, 1000, 0]], { source: 'auto_asset_disposal' });
        const ind = await getIndirectCashFlow(CO, '2026-12-01', '2026-12-31');
        const dir = await getCashFlowDirect(CO, '2026-12-01', '2026-12-31');
        expect(sec(ind, 'Investing')).toBe(-7000);
        expect(dir.investingTotal).toBe(-7000);
        parity(ind, dir);
      });
    });

    it('a disposal and its reversal in the same period net to zero, with no Unexplained Difference', async () => {
      await inTx(async ({ acct, j }) => {
        const bank = await acct('asset', 'bank'), fa = await acct('asset', 'fixed_asset'), acc = await acct('asset', 'accumulated_depreciation', 'credit');
        const gain = await acct('revenue', 'disposal_profit_loss');
        await j('2026-11-15', [[bank, 7000, 0], [acc, 4000, 0], [fa, 0, 10000], [gain, 0, 1000]], { source: 'auto_asset_disposal' });
        await j('2026-11-16', [[bank, 0, 7000], [acc, 0, 4000], [fa, 10000, 0], [gain, 1000, 0]], { source: 'auto_asset_disposal' });
        const { ind, dir } = await tie(...P);
        expect(sec(ind, 'Investing')).toBe(0);
        expect(ind.unexplainedDifference).toBe(0);
        parity(ind, dir);
      });
    });

    it('a disposal on credit (no cash) shows nothing in Investing: the sale is a non-cash item', async () => {
      await inTx(async ({ acct, j }) => {
        const ar = await acct('asset', 'receivable'), fa = await acct('asset', 'fixed_asset'), acc = await acct('asset', 'accumulated_depreciation', 'credit');
        const gain = await acct('revenue', 'disposal_profit_loss');
        await j('2026-11-15', [[ar, 7000, 0], [acc, 4000, 0], [fa, 0, 10000], [gain, 0, 1000]], { source: 'auto_asset_disposal' });
        const { ind } = await tie(...P);
        expect(sec(ind, 'Investing')).toBe(0);
        expect(ind.unexplainedDifference).toBe(0);
      });
    });
  });
});
