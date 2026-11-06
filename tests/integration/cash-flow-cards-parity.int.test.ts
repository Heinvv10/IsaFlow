// The adversarial review's credit-card (B5) and indirect-vs-direct section parity (B4) repros.
import { describe, expect, it, vi } from 'vitest';
import { CO, LT_LOANS_2210, describeIfDb, inTx, installCompanies, sec, tie, P } from './helpers/cashFlowAdversarialFixture';
import { getIndirectCashFlow } from '@/modules/accounting/services/reports/cashFlowIndirectService';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';


vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));

installCompanies();

describeIfDb('cash flow cards and indirect/direct parity (B4, B5)', () => {
  it('B5 a credit card spelled with a bank subtype (a LIABILITY): spend and payoff in ONE period, both methods agree section by section', async () => {
    await inTx(async ({ acct, j }) => {
      const bank = await acct('asset', 'bank'), card = await acct('liability', 'bank_account'), opex = await acct('expense', 'operating_expense');
      await j('2026-11-03', [[opex, 800, 0], [card, 0, 800]]);   // spend on the card: no cash
      await j('2026-11-20', [[card, 800, 0], [bank, 0, 800]]);   // paid off from the bank
      const { ind, dir } = await tie(...P);
      expect({ op: sec(ind, 'Operating'), inv: sec(ind, 'Investing'), fin: sec(ind, 'Financing') })
        .toEqual({ op: dir.operatingTotal, inv: dir.investingTotal, fin: dir.financingTotal });
      expect(sec(ind, 'Financing')).toBe(-800);
      // and the payoff alone, in its own period, is a financing outflow on both
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
      const card = await acct('liability', 'bank_account'), opex = await acct('expense', 'operating_expense');
      await j('2026-11-17', [[opex, 800, 0], [card, 0, 800]]);   // a card: spend and payoff in the same period
      await j('2026-11-18', [[card, 800, 0], [bank, 0, 800]]);
      const { ind, dir } = await tie(...P);
      expect({ op: sec(ind, 'Operating'), inv: sec(ind, 'Investing'), fin: sec(ind, 'Financing') })
        .toEqual({ op: dir.operatingTotal, inv: dir.investingTotal, fin: dir.financingTotal });
    });
  });
});
