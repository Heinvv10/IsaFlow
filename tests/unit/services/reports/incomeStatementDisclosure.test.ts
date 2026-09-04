// RED phase — written before implementation
/**
 * The income statement is the report that showed Velocity a 96.6% gross margin
 * on fibre construction against a real -1.9%. `fetchIncomeStatementRows` bands
 * an expense with no recognised subtype into operating expenses (the `else`
 * branch beside `canonicalSubtype(subtype) === 'cost_of_sales'`) and discloses
 * nothing — so the number is wrong on the one screen where it is read.
 *
 * `unclassifiedWarning` already exists and ten report APIs return it. The
 * income statement is not one of them. This is the disclosure for that report,
 * computed from the SAME rows and the SAME period the report totals, so it
 * cannot disagree with the figure it sits under.
 */

import { describe, it, expect } from 'vitest';
import {
  buildIncomeStatementSubtypeDisclosure,
  type DisclosureInputRow,
} from '@/modules/accounting/services/reports/incomeStatementDisclosure';

const expenseRow = (over: Partial<DisclosureInputRow> = {}): DisclosureInputRow => ({
  accountCode: '49784351',
  accountName: 'COS - Direct Material',
  accountType: 'expense',
  accountSubtype: null,
  amount: 46923976.23,
  ...over,
});

describe('buildIncomeStatementSubtypeDisclosure — nothing to disclose', () => {
  it('returns null when there are no rows', () => {
    expect(buildIncomeStatementSubtypeDisclosure([])).toBeNull();
  });

  it('returns null when every account has a recognised subtype', () => {
    expect(buildIncomeStatementSubtypeDisclosure([
      expenseRow({ accountSubtype: 'cost_of_sales' }),
      expenseRow({ accountCode: '6000', accountSubtype: 'operating_expenses' }),
      expenseRow({ accountCode: '4000', accountType: 'revenue', accountSubtype: 'revenue' }),
    ])).toBeNull();
  });

  it('returns null when an unclassified account carries no amount', () => {
    expect(buildIncomeStatementSubtypeDisclosure([expenseRow({ amount: 0 })])).toBeNull();
  });
});

describe('buildIncomeStatementSubtypeDisclosure — what it tells the reader', () => {
  it('counts unclassified expense accounts and their amount', () => {
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow(),
      expenseRow({ accountCode: '49784352', accountName: 'COS - Sub-Contractors', amount: 31542856.94 }),
      expenseRow({ accountCode: '6000', accountName: 'Rent', accountSubtype: 'operating_expenses', amount: 100000 }),
    ]);
    expect(d?.expenseAccounts).toBe(2);
    expect(d?.expenseAmount).toBeCloseTo(78466833.17, 2);
  });

  it('states the gross profit exposure as an UPPER BOUND, not a correction', () => {
    // We do not know which of these are cost of sales — only that any that is,
    // is currently below the gross profit line. Asserting a corrected figure
    // would be inventing one.
    const d = buildIncomeStatementSubtypeDisclosure([expenseRow()]);
    expect(d?.costOfSalesExposureAtMost).toBeCloseTo(46923976.23, 2);
    expect(d?.grossProfitOverstatedByAtMost).toBeCloseTo(46923976.23, 2);
    expect(d?.message).toMatch(/up to/i);
    expect(d?.message).toMatch(/gross profit/i);
    expect(d?.message).toMatch(/ceilings on what is unclassified, not corrections/i);
  });

  it('COUNTS revenue towards the gross profit ceiling — this report has no other-income line', () => {
    // gross profit = totalRevenue - totalCostOfSales, and every revenue row
    // lands in totalRevenue. So an unclassified revenue account that is really
    // other income overstates gross profit one-for-one. The first cut excluded
    // it, and a test enshrined the exclusion: on Velocity that understated the
    // stated ceiling by R29,154,786.11 in a cell labelled "at most".
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow({ amount: 1000 }),
      expenseRow({ accountCode: '4310', accountName: 'Interest Received', accountType: 'revenue', amount: 2876.63 }),
    ]);
    expect(d?.grossProfitOverstatedByAtMost).toBeCloseTo(3876.63, 2);
    expect(d?.revenueAccounts).toBe(1);
    expect(d?.revenueAmount).toBeCloseTo(2876.63, 2);
  });

  it('reports an unclassified revenue account as turnover exposure', () => {
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow({ accountCode: '4310', accountName: 'Interest Received', accountType: 'revenue', amount: 2876.63 }),
    ]);
    expect(d?.expenseAccounts).toBe(0);
    expect(d?.grossProfitOverstatedByAtMost).toBeCloseTo(2876.63, 2);
    expect(d?.message).toMatch(/other income|turnover/i);
  });

  it('names the largest accounts, biggest first', () => {
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow({ accountCode: 'SMALL', accountName: 'Casual wages', amount: 2327887.5 }),
      expenseRow({ accountCode: 'BIG', accountName: 'Direct Material', amount: 46923976.23 }),
    ]);
    const codes = (d?.accounts ?? []).map(a => a.accountCode);
    expect(codes[0]).toBe('BIG');
    expect(codes[1]).toBe('SMALL');
  });

  it('caps the named list but says how many are unnamed', () => {
    const many = Array.from({ length: 37 }, (_, i) =>
      expenseRow({ accountCode: `A${i}`, accountName: `Account ${i}`, amount: 1000 - i }));
    const d = buildIncomeStatementSubtypeDisclosure(many);
    expect(d?.accounts.length).toBeLessThanOrEqual(6);
    expect(d?.unnamedAccounts).toBe(37 - (d?.accounts.length ?? 0));
  });
});

describe('buildIncomeStatementSubtypeDisclosure — agrees with the classifier', () => {
  it('treats an unrecognised spelling exactly as the report does', () => {
    // canonicalSubtype('other') is null, so fetchIncomeStatementRows puts this
    // in operating expenses. The disclosure must see the same thing.
    const d = buildIncomeStatementSubtypeDisclosure([expenseRow({ accountSubtype: 'other' })]);
    expect(d?.expenseAccounts).toBe(1);
  });

  it('accepts the alias spellings the report accepts', () => {
    for (const spelling of ['cogs', 'Cost of Sales', 'cost-of-sales']) {
      expect(buildIncomeStatementSubtypeDisclosure([expenseRow({ accountSubtype: spelling })])).toBeNull();
    }
  });

  it('treats the empty string as unclassified, as the report does', () => {
    expect(buildIncomeStatementSubtypeDisclosure([expenseRow({ accountSubtype: '' })])?.expenseAccounts).toBe(1);
  });
});

// ── A credit-balance expense account (blind review, HIGH) ────────────────────

describe('buildIncomeStatementSubtypeDisclosure — expenses that carry a credit', () => {
  // fetchIncomeStatementRows signs expenses debit-credit, so a reversal, rebate
  // or recovery arrives NEGATIVE and REDUCES operating expenses. Reclassifying
  // such an account to cost of sales RAISES gross profit — the only possible
  // error direction is understatement. Calling that "overstated by up to R5,000"
  // states the opposite of the fact, on the one number the feature exists for.
  // Brightsphere carries this shape live: 35409454 Legal Expenses, -R1,084,773.56.
  it('never claims gross profit is overstated by a credit-balance expense', () => {
    const d = buildIncomeStatementSubtypeDisclosure([expenseRow({ amount: -5000 })]);
    expect(d?.grossProfitOverstatedByAtMost).toBe(0);
    expect(d?.message ?? '').not.toMatch(/overstated by up to R5,000\.00/);
  });

  it('bounds gross profit by the DEBIT balances only', () => {
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow({ accountCode: 'DR', amount: 5000 }),
      expenseRow({ accountCode: 'CR', amount: -1000 }),
    ]);
    // Reclassifying DR alone moves R5,000 above the line. The credit account
    // cannot add to an overstatement, so the bound is 5000, not 6000.
    expect(d?.grossProfitOverstatedByAtMost).toBeCloseTo(5000, 2);
  });

  it('reports the amount actually sitting in operating expenses, signed', () => {
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow({ accountCode: 'DR', amount: 5000 }),
      expenseRow({ accountCode: 'CR', amount: -1000 }),
    ]);
    // R4,000 is what the report shows for these two. R6,000 is not a figure
    // anywhere on it.
    expect(d?.expenseAmount).toBeCloseTo(4000, 2);
  });

  it('still discloses an all-credit set — the accounts are unclassified either way', () => {
    const d = buildIncomeStatementSubtypeDisclosure([expenseRow({ amount: -5000 })]);
    expect(d).not.toBeNull();
    expect(d?.expenseAccounts).toBe(1);
    expect(d?.expenseAmount).toBeCloseTo(-5000, 2);
  });
});

describe('buildIncomeStatementSubtypeDisclosure — the named list', () => {
  // Slicing across both types can name five revenue accounts under a headline
  // about gross profit, leaving nothing that supports it.
  it('names expense accounts even when revenue accounts are larger', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) =>
        expenseRow({ accountCode: `R${i}`, accountName: `Revenue ${i}`, accountType: 'revenue' as const, amount: 1000000 - i })),
      expenseRow({ accountCode: 'E1', accountName: 'Small expense', amount: 50 }),
    ];
    const d = buildIncomeStatementSubtypeDisclosure(rows);
    expect(d?.accounts.some(a => a.accountType === 'expense')).toBe(true);
    expect(d?.accounts.map(a => a.accountCode)).toContain('E1');
  });
});

// ── The platform's own "unclassified" markers (adversarial review, F1) ───────

describe('buildIncomeStatementSubtypeDisclosure — platform default subtypes', () => {
  // canonicalSubtype('default_expense') === 'operating_expense', so the
  // canonicalSubtype-is-null test reads the platform's own "nobody classified
  // this" marker as a classification. Brightsphere's 5001 Cost of Goods Sold
  // is a SYSTEM account with default_expense holding R574,253.66, on the
  // company whose income statement prints 100.0% margin against R0.00 CoS.
  it("flags default_expense — an account named Cost of Goods Sold was invisible", () => {
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow({
        accountCode: '5001', accountName: 'Cost of Goods Sold',
        accountSubtype: 'default_expense', amount: 574253.66,
      }),
    ]);
    expect(d).not.toBeNull();
    expect(d?.expenseAccounts).toBe(1);
    expect(d?.grossProfitOverstatedByAtMost).toBeCloseTo(574253.66, 2);
    expect(d?.accounts[0]?.reason).toBe('platform_default');
  });

  it('flags default_revenue', () => {
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow({ accountCode: '4001', accountName: 'Product Sales', accountType: 'revenue',
                   accountSubtype: 'default_revenue', amount: 12410997.9 }),
    ]);
    expect(d?.revenueAccounts).toBe(1);
    expect(d?.accounts[0]?.reason).toBe('platform_default');
  });

  it('does not flag a real classification that merely resolves to the same band', () => {
    // operating_expenses is a CHOICE; default_expense is the absence of one.
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow({ accountSubtype: 'operating_expenses', amount: 1000 }),
    ]);
    expect(d).toBeNull();
  });
});

// ── Other income inside turnover (adversarial review, F3) ───────────────────

describe('buildIncomeStatementSubtypeDisclosure — other income has nowhere to go', () => {
  // fetchIncomeStatementRows pushes EVERY revenue row into revenue[]. There is
  // no other-income line, so a correctly-classified other_income account is
  // certainly inside turnover and certainly inside gross profit. Nothing is
  // conjectural about it, and canonicalSubtype recognises it, so the
  // unclassified test passes straight over it.
  it('flags a RECOGNISED other_income revenue account', () => {
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow({ accountCode: '4300', accountName: 'Other Income', accountType: 'revenue',
                   accountSubtype: 'other_income', amount: 53787.07 }),
    ]);
    expect(d).not.toBeNull();
    expect(d?.accounts[0]?.reason).toBe('other_income_in_turnover');
  });

  it('counts it as a CERTAIN floor, not a conjectural ceiling', () => {
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow({ accountCode: '4300', accountType: 'revenue', accountSubtype: 'other_income', amount: 53787.07 }),
    ]);
    expect(d?.grossProfitOverstatedByAtLeast).toBeCloseTo(53787.07, 2);
    expect(d?.grossProfitOverstatedByAtMost).toBeCloseTo(53787.07, 2);
    expect(d?.message).toMatch(/already in gross profit/i);
  });

  it('keeps the floor below the ceiling when both kinds are present', () => {
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow({ accountCode: '4300', accountType: 'revenue', accountSubtype: 'other_income', amount: 20000 }),
      expenseRow({ accountCode: '5000', amount: 100000 }),
    ]);
    expect(d?.grossProfitOverstatedByAtLeast).toBeCloseTo(20000, 2);
    expect(d?.costOfSalesExposureAtMost).toBeCloseTo(100000, 2);
    expect(d?.grossProfitOverstatedByAtMost).toBeCloseTo(120000, 2);
    expect(d?.message).toMatch(/already in gross profit/i);
    expect(d?.message).toMatch(/could belong above the line as cost of sales/i);
  });

  it('does not treat other_income on an EXPENSE account as turnover', () => {
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow({ accountSubtype: 'other_income', amount: 1000 }),
    ]);
    // Nonsense data. `other_income` resolves to a real band and the row lands
    // in operating expenses, so there is nothing to disclose — what must NOT
    // happen is it counting towards the certain floor, which describes revenue
    // sitting in turnover.
    expect(d?.grossProfitOverstatedByAtLeast ?? 0).toBe(0);
  });
});

describe('buildIncomeStatementSubtypeDisclosure — naming across reasons', () => {
  it('names at least one account of each reason present', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) =>
        expenseRow({ accountCode: `N${i}`, accountName: `Unclassified ${i}`, amount: 9000000 - i })),
      expenseRow({ accountCode: 'PD', accountName: 'Cost of Goods Sold', accountSubtype: 'default_expense', amount: 50 }),
      expenseRow({ accountCode: 'OI', accountName: 'Other Income', accountType: 'revenue',
                   accountSubtype: 'other_income', amount: 10 }),
    ];
    const d = buildIncomeStatementSubtypeDisclosure(rows);
    const reasons = new Set((d?.accounts ?? []).map(a => a.reason));
    expect(reasons.has('no_subtype')).toBe(true);
    expect(reasons.has('platform_default')).toBe(true);
    expect(reasons.has('other_income_in_turnover')).toBe(true);
  });
});
