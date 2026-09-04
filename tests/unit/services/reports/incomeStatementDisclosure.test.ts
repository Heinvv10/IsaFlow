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
    expect(d?.grossProfitOverstatedByAtMost).toBeCloseTo(46923976.23, 2);
    expect(d?.message).toMatch(/up to|at most/i);
    expect(d?.message).toMatch(/gross profit/i);
  });

  it('does not count revenue accounts towards the gross profit exposure', () => {
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow({ amount: 1000 }),
      expenseRow({ accountCode: '4310', accountName: 'Interest Received', accountType: 'revenue', amount: 2876.63 }),
    ]);
    expect(d?.grossProfitOverstatedByAtMost).toBeCloseTo(1000, 2);
    expect(d?.revenueAccounts).toBe(1);
    expect(d?.revenueAmount).toBeCloseTo(2876.63, 2);
  });

  it('reports revenue separately, because it overstates turnover not gross profit', () => {
    const d = buildIncomeStatementSubtypeDisclosure([
      expenseRow({ accountCode: '4310', accountName: 'Interest Received', accountType: 'revenue', amount: 2876.63 }),
    ]);
    expect(d?.expenseAccounts).toBe(0);
    expect(d?.grossProfitOverstatedByAtMost).toBe(0);
    expect(d?.message).toMatch(/other income|turnover/i);
    expect(d?.message).not.toMatch(/gross profit/i);
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
    expect(d?.accounts.length).toBeLessThanOrEqual(5);
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
