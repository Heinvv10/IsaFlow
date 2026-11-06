/**
 * The Reports Cash Flow screen (indirect method) listed four kinds of non-cash movement: P&L, receivables,
 * payables and fixed assets / equity. Every other balance-sheet line (VAT control, inventory, prepayments, payroll and
 * other current liabilities, accumulated depreciation, loans, retained earnings) fell through, so after a R1 150 cash
 * sale (R1 000 + R150 VAT) the screen showed Operating -7 000 / Closing 287 750 where the ledger holds 287 900.
 *
 * By double entry, cash moves by the credit-less-debit of every NON-cash line, so the statement ties to cash only
 * if EVERY non-cash account lands in exactly one line. This walks the whole subtype vocabulary to hold that.
 */
import { describe, expect, it } from 'vitest';
import { ALL_RAW_SUBTYPES, isCashEquivalent, type AccountType } from '@/modules/accounting/services/gl/accountSubtypes';
import {
  classifyIndirectLine, isDisposalJournal, placeJournal, INDIRECT_BUCKETS, bucketSection, type IndirectBucket, type JournalLeg,
} from '@/modules/accounting/services/reports/cashFlowIndirectClassification';

const TYPES: AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const subtypes: Array<string | null> = [...ALL_RAW_SUBTYPES, null, '', 'default_expense', 'other', 'something_new'];

describe('every non-cash account lands in exactly one line', () => {
  for (const type of TYPES) {
    it(`${type}: each subtype (known, null, unknown) has a bucket that is a known line with a section`, () => {
      for (const subtype of subtypes) {
        if (isCashEquivalent(type, subtype)) continue; // the cash accounts themselves are the thing being explained
        const bucket = classifyIndirectLine(type, subtype);
        expect(INDIRECT_BUCKETS, `${type}/${String(subtype)}`).toContain(bucket);
        expect(['operating', 'investing', 'financing'], `${type}/${String(subtype)}`).toContain(bucketSection(bucket));
      }
    });
  }
});

describe('what the screen used to leave out', () => {
  const b = (type: AccountType, subtype: string | null): IndirectBucket => classifyIndirectLine(type, subtype);
  it('VAT control accounts (both sides, and the input-claim clearing account) are the VAT line', () => {
    expect(b('liability', 'vat_output')).toBe('vat');
    expect(b('asset', 'vat_input')).toBe('vat');
    expect(b('asset', 'vat_input_late_claim')).toBe('vat');
  });
  it('inventory, prepayments, other current assets and unclassified balance-sheet lines are operating', () => {
    expect(b('asset', 'inventory')).toBe('inventory');
    for (const s of ['prepaid_expense', 'other_current_asset', 'current_asset', null, 'something_new']) {
      expect(b('asset', s), String(s)).toBe('other_operating');
      expect(bucketSection('other_operating')).toBe('operating');
    }
    for (const s of ['payroll_liability', 'current_liability', 'other_current_liability', null, 'something_new']) {
      expect(b('liability', s), String(s)).toBe('other_operating');
    }
  });
  it('accumulated depreciation is the non-cash add-back, in operating', () => {
    expect(b('asset', 'accumulated_depreciation')).toBe('depreciation');
    expect(bucketSection('depreciation')).toBe('operating');
  });
  it('trade receivables and payables keep their own lines', () => {
    expect(b('asset', 'receivable')).toBe('receivable');
    expect(b('liability', 'payable')).toBe('payable');
  });
  it('fixed assets, intangibles and investments are investing', () => {
    for (const s of ['fixed_asset', 'fixed_assets', 'intangible_asset', 'investment', 'non_current_asset']) {
      expect(bucketSection(b('asset', s)), s).toBe('investing');
    }
  });
  it('loans, credit cards, equity and retained earnings are financing', () => {
    expect(b('liability', 'long_term_liability')).toBe('debt');
    expect(b('liability', 'non_current_liability')).toBe('debt');
    expect(b('liability', 'credit_card')).toBe('debt');
    expect(b('equity', 'equity')).toBe('equity');
    expect(b('equity', null)).toBe('equity');
    expect(b('equity', 'retained_earnings')).toBe('retained_earnings');
    for (const bucket of ['debt', 'equity', 'retained_earnings'] as const) expect(bucketSection(bucket)).toBe('financing');
  });
  it('revenue and expense are net income whatever their subtype', () => {
    expect(b('revenue', 'disposal_profit_loss')).toBe('net_income');
    expect(b('expense', 'default_expense')).toBe('net_income');
    expect(b('expense', 'depreciation_expense')).toBe('net_income');
  });
});

describe('the current portion of debt is a loan, and no ordinary current liability is', () => {
  it('a flagged account with no line of its own is financing, in every generic spelling', () => {
    for (const sub of ['current_liability', 'other_current_liability', null]) {
      expect(classifyIndirectLine('liability', sub, true), String(sub)).toBe('debt');
    }
    expect(bucketSection('debt')).toBe('financing');
  });
  it('without the flag, ordinary current liabilities stay operating', () => {
    for (const sub of ['current_liability', 'other_current_liability', 'payroll_liability', null, 'something_new']) {
      expect(classifyIndirectLine('liability', sub), String(sub)).toBe('other_operating');
    }
  });
  it('a loan naming a trade payable or VAT control does not move that line', () => {
    expect(classifyIndirectLine('liability', 'payable', true)).toBe('payable');
    expect(classifyIndirectLine('liability', 'vat_output', true)).toBe('vat');
  });
});

describe('only the cash a journal moved is an investing or financing flow', () => {
  const leg = (accountType: AccountType, subtype: string, creditLessDebit: number): JournalLeg => ({ accountType, subtype, creditLessDebit });
  const FA = (n: number) => leg('asset', 'fixed_asset', n);
  const LOAN = (n: number) => leg('liability', 'long_term_liability', n);
  const lines = (legs: JournalLeg[], netCash: number) => {
    const out: Partial<Record<IndirectBucket, number>> = {};
    for (const { bucket, amount } of placeJournal(legs, netCash)) out[bucket] = (out[bucket] ?? 0) + amount;
    return Object.fromEntries(Object.entries(out).filter(([, amount]) => amount !== 0));
  };

  it('a R10 000 asset on R2 000 cash and an R8 000 loan is a R2 000 investing outflow and nothing else', () => {
    expect(lines([FA(-10000), LOAN(8000)], -2000)).toEqual({ investing: -2000 });
  });
  it('the part of an asset bought on account stays in payables, offset in non_cash', () => {
    expect(lines([FA(-10000), leg('liability', 'payable', 8000)], -2000)).toEqual({ investing: -2000, payable: 8000, non_cash: -8000 });
  });
  it('input VAT paid in cash on a part-financed asset stays operating and takes its share of the cash', () => {
    expect(lines([FA(-10000), leg('asset', 'vat_input', -1500), LOAN(8000)], -3500)).toEqual({ vat: -1500, investing: -2000 });
  });
  it('a loan drawn larger than the asset it paid for is financing only for the cash received', () => {
    expect(lines([FA(-10000), LOAN(13000)], 3000)).toEqual({ debt: 3000 });
  });
  it('a disposal is investing for the proceeds; the rest offsets net income and the depreciation release', () => {
    expect(lines([FA(9000), leg('asset', 'accumulated_depreciation', -4000), leg('revenue', 'other_income', 1000)], 6000))
      .toEqual({ investing: 6000, net_income: 1000, depreciation: -4000, non_cash: 3000 });
  });
  it('a loan repayment with interest is financing for the principal, net income for the interest', () => {
    expect(lines([LOAN(-1000), leg('expense', 'finance_cost', -100)], -1100)).toEqual({ debt: -1000, net_income: -100 });
  });
  it('wholly cash-funded legs show in full, both sections', () => {
    expect(lines([FA(-4000), LOAN(-1000)], -5000)).toEqual({ investing: -4000, debt: -1000 });
    expect(lines([FA(9000), LOAN(1000)], 10000)).toEqual({ investing: 9000, debt: 1000 });
  });
  it('investing and financing legs competing for too little cash each take a pro-rata share, in whole cents', () => {
    expect(lines([FA(-4000), LOAN(-1000), leg('liability', 'payable', 2000)], -3000))
      .toEqual({ investing: -2400, debt: -600, payable: 2000, non_cash: -2000 });
    const placed = lines([FA(-100), LOAN(-200), leg('liability', 'payable', 200)], -100);
    expect(placed.investing).toBe(-33.33);
    expect(placed.debt).toBe(-66.67);
  });
  it('no cash moved: an asset on a loan, on account, or for shares, and an impairment, is no such flow', () => {
    expect(lines([FA(-10000), LOAN(10000)], 0)).toEqual({});
    expect(lines([FA(-2000), leg('liability', 'payable', 2000)], 0)).toEqual({ payable: 2000, non_cash: -2000 });
    expect(lines([leg('asset', 'intangible_asset', -500), leg('equity', 'equity', 500)], 0)).toEqual({});
    expect(lines([leg('expense', 'operating_expense', -300), FA(300)], 0)).toEqual({ net_income: -300, non_cash: 300 });
  });
  it('a current-portion repayment is financing; the reclass from long-term moves nothing', () => {
    const cp = (n: number): JournalLeg => ({ ...leg('liability', 'current_liability', n), isLoanCurrentPortion: true });
    expect(lines([cp(-1000)], -1000)).toEqual({ debt: -1000 });
    expect(lines([LOAN(-5000), cp(5000)], 0)).toEqual({});
  });
  it('operating lines never move and every journal places exactly its legs, in any mix of accounts and cash', () => {
    let seed = 1156;
    const next = (n: number) => { seed = (seed * 48271) % 2147483647; return seed % n; };
    const kinds: Array<[AccountType, string]> = [
      ['asset', 'fixed_asset'], ['asset', 'investment'], ['liability', 'long_term_liability'], ['equity', 'equity'], ['equity', 'retained_earnings'],
      ['asset', 'receivable'], ['liability', 'payable'], ['asset', 'vat_input'], ['revenue', 'revenue'], ['expense', 'operating_expense'],
    ];
    for (let run = 0; run < 2000; run++) {
      const legs = Array.from({ length: 1 + next(6) }, () => {
        const [type, sub] = kinds[next(kinds.length)]!;
        return leg(type, sub, (next(2_000_001) - 1_000_000) / 100);
      });
      const netCash = Math.round(legs.reduce((sum, l) => sum + l.creditLessDebit, 0) * 100) / 100;
      const placed = placeJournal(legs, netCash);
      const total = (rows: Array<{ amount: number }>) => Math.round(rows.reduce((sum, r) => sum + r.amount, 0) * 100);
      expect(total(placed)).toBe(Math.round(netCash * 100));
      // Investing and financing together never exceed the cash, and never run against it.
      const flows = placed.filter((p) => bucketSection(p.bucket) !== 'operating');
      for (const f of flows) expect(Math.sign(f.amount)).toBe(Math.sign(netCash));
      expect(Math.abs(total(flows))).toBeLessThanOrEqual(Math.abs(Math.round(netCash * 100)) + flows.length);
    }
  });
});

describe('disposal journals (the review\'s B2/H)', () => {
  const out = (legs: JournalLeg[], netCash: number, disposal: boolean) => {
    const by: Record<string, number> = {};
    for (const { bucket, amount } of placeJournal(legs, netCash, disposal)) by[bucket] = Math.round(((by[bucket] ?? 0) + amount) * 100) / 100;
    return by;
  };
  // cost 10 000, accumulated depreciation 4 000 released, proceeds 7 000, gain 1 000 (credits positive)
  const legs: JournalLeg[] = [
    { accountType: 'asset', subtype: 'fixed_asset', creditLessDebit: 10000 },
    { accountType: 'asset', subtype: 'accumulated_depreciation', creditLessDebit: -4000 },
    { accountType: 'revenue', subtype: 'disposal_profit_loss', creditLessDebit: 1000 },
  ];
  it('in a disposal journal investing is the proceeds, the gain is taken back out of operating, the add-back is untouched', () => {
    expect(out(legs, 7000, true)).toEqual({ investing: 7000, net_income: 1000, disposal_adjustment: -1000 });
  });
  it('the same legs as an ordinary journal send accumulated depreciation to the add-back (netted), not to investing', () => {
    const by = out([{ accountType: 'asset', subtype: 'accumulated_depreciation', creditLessDebit: -500 }, { accountType: 'asset', subtype: 'accumulated_depreciation', creditLessDebit: 500 }], 0, false);
    expect(by).toEqual({ depreciation: 0 });
  });
  it('a disposal on credit has no cash, so none of it is investing', () => {
    const by = out(legs, 0, true);
    expect(by.investing).toBeUndefined();
    expect(by.non_cash).toBe(7000);
  });
  it('isDisposalJournal: by source (a reversal copies it) or by a disposal gain/loss leg only', () => {
    expect(isDisposalJournal('auto_asset_disposal', [])).toBe(true);
    expect(isDisposalJournal('manual', legs)).toBe(true);
    expect(isDisposalJournal('manual', [legs[1]!])).toBe(false);
  });
  it('a liability spelled bank or cash is a credit card: debt', () => {
    for (const s of ['bank', 'bank_account', 'cash', 'petty_cash']) expect(classifyIndirectLine('liability', s), s).toBe('debt');
  });
});
