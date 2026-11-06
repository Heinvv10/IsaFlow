/**
 * `journalSections` is the one rule both cash flow methods follow per journal: investing and financing are only the cash
 * that moved through the cash accounts (IAS 7.43: the part settled on account or by a loan is non-cash), the rest of the
 * journal's cash is operating. Legs are credit less debit; `netCash` is debit less credit on the cash accounts.
 */
import { describe, expect, it } from 'vitest';
import { journalSections, placeJournal, type JournalLeg } from '@/modules/accounting/services/reports/cashFlowIndirectClassification';

const leg = (accountType: JournalLeg['accountType'], subtype: string | null, debit: number, credit: number): JournalLeg =>
  ({ accountType, subtype, creditLessDebit: credit - debit });
const fa = (d: number, c: number) => leg('asset', 'fixed_asset', d, c);
const sections = (s: ReturnType<typeof journalSections>) => ({ op: s.operating, inv: s.investing, fin: s.financing });

describe('journalSections', () => {
  it('an asset bought part for cash, part on account with VAT: only the cash is investing', () => {
    const legs = [fa(10000, 0), leg('asset', 'vat_input', 1500, 0), leg('liability', 'payable', 0, 6500)];
    expect(sections(journalSections(legs, -5000))).toEqual({ op: 0, inv: -5000, fin: 0 });
  });

  it('a disposal whose proceeds repay a loan in the same journal: the repayment is not cash', () => {
    const legs = [leg('liability', 'long_term_liability', 5000, 0), leg('asset', 'accumulated_depreciation', 4000, 0), fa(0, 10000), leg('revenue', 'disposal_profit_loss', 0, 1000)];
    expect(sections(journalSections(legs, 2000, true))).toEqual({ op: 0, inv: 2000, fin: 0 });
  });

  it('a loan drawn and repaid in other journals keeps its gross flows', () => {
    expect(sections(journalSections([leg('liability', 'long_term_liability', 0, 7000)], 7000))).toEqual({ op: 0, inv: 0, fin: 7000 });
    expect(sections(journalSections([leg('liability', 'long_term_liability', 5000, 0)], -5000))).toEqual({ op: 0, inv: 0, fin: -5000 });
  });

  it('the three sections always add to the journal\'s cash and equal what placeJournal places', () => {
    // balanced journals: the non-cash legs (credit less debit) add up to the cash (debit less credit)
    const bought = [fa(10000, 0), leg('liability', 'long_term_liability', 0, 8000), leg('expense', 'operating_expense', 300, 0), leg('asset', 'receivable', 0, 400)];
    const onLoan = [fa(10000, 0), leg('liability', 'long_term_liability', 0, 10000)];
    for (const [legs, netCash] of [[bought, -1900], [onLoan, 0]] as const) {
      const s = journalSections(legs, netCash);
      expect(s.operating + s.investing + s.financing).toBeCloseTo(netCash, 2);
      const placedOperating = placeJournal(legs, netCash).filter((p) => !['investing', 'debt', 'equity', 'retained_earnings'].includes(p.bucket)).reduce((a, p) => a + p.amount, 0);
      expect(s.operating).toBeCloseTo(placedOperating, 2);
    }
  });

  it('the operating legs exclude investing and financing legs, a disposal\'s gain and its released accumulated depreciation', () => {
    const legs = [fa(0, 10000), leg('asset', 'accumulated_depreciation', 4000, 0), leg('revenue', 'disposal_profit_loss', 0, 1000), leg('liability', 'vat_output', 0, 750), leg('equity', 'equity', 0, 1)];
    expect(journalSections(legs, 5750, true).operatingLegs.map((l) => l.subtype)).toEqual(['vat_output']);
    // outside a disposal accumulated depreciation is an operating add-back
    expect(journalSections([leg('asset', 'accumulated_depreciation', 0, 300)], 300).operatingLegs.map((l) => l.subtype)).toEqual(['accumulated_depreciation']);
  });
});
