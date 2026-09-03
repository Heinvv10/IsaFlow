// Pure tests for the direct cash-flow classification and apportionment rules.
//
// These need no database: `classifyCashGroup` and `apportionBankLeg` are
// total functions over (account_type, account_subtype, amounts). The tie-out
// to a real ledger is proved separately in
// tests/integration/afs-cash-flow-direct.int.test.ts.

import { describe, it, expect } from 'vitest';
import {
  classifyCashGroup,
  apportionBankLeg,
  type ContraLine,
} from '@/modules/accounting/services/afs/cashFlowClassification';

const contra = (
  accountType: ContraLine['accountType'],
  accountSubtype: string | null,
  amount: number,
): ContraLine => ({ accountType, accountSubtype, amount });

describe('classifyCashGroup', () => {
  it('classifies the subtype spellings production charts actually use', () => {
    // Every one of these fell through to `other_operating` under the previous
    // hard-coded CASE, which only knew 'revenue', 'payroll', 'expense',
    // 'payable', 'cost_of_sales', 'fixed_asset' and 'other_asset'.
    expect(classifyCashGroup('revenue', 'default_revenue')).toBe('cash_received_from_customers');
    expect(classifyCashGroup('revenue', 'sales')).toBe('cash_received_from_customers');
    expect(classifyCashGroup('revenue', 'other_income')).toBe('cash_received_from_customers');
    expect(classifyCashGroup('asset', 'debtors')).toBe('cash_received_from_customers');

    expect(classifyCashGroup('liability', 'payroll_liability')).toBe('cash_paid_to_employees');
    expect(classifyCashGroup('liability', 'payroll_liabilities')).toBe('cash_paid_to_employees');

    // Salaries and wages are paid to employees, not to suppliers. Only the
    // payroll LIABILITY subtypes were recognised, so every salary expense
    // account landed on "Cash paid to suppliers".
    expect(classifyCashGroup('expense', 'salaries')).toBe('cash_paid_to_employees');
    expect(classifyCashGroup('expense', 'wages')).toBe('cash_paid_to_employees');
    expect(classifyCashGroup('expense', 'salaries_and_wages')).toBe('cash_paid_to_employees');
    expect(classifyCashGroup('expense', 'payroll_expense')).toBe('cash_paid_to_employees');
    expect(classifyCashGroup('expense', 'staff_costs')).toBe('cash_paid_to_employees');
    expect(classifyCashGroup('expense', 'employee_benefits')).toBe('cash_paid_to_employees');

    expect(classifyCashGroup('expense', 'operating_expense')).toBe('cash_paid_to_suppliers');
    expect(classifyCashGroup('expense', 'operating_expenses')).toBe('cash_paid_to_suppliers');
    expect(classifyCashGroup('expense', 'admin_expense')).toBe('cash_paid_to_suppliers');
    expect(classifyCashGroup('expense', 'default_expense')).toBe('cash_paid_to_suppliers');
    expect(classifyCashGroup('liability', 'creditors')).toBe('cash_paid_to_suppliers');

    expect(classifyCashGroup('asset', 'fixed_assets')).toBe('investing');
    expect(classifyCashGroup('asset', 'fixed_asset')).toBe('investing');
    expect(classifyCashGroup('asset', 'investments')).toBe('investing');

    expect(classifyCashGroup('liability', 'long_term_liabilities')).toBe('financing');
  });

  it('treats any equity movement as financing regardless of subtype spelling', () => {
    expect(classifyCashGroup('equity', 'share_capital')).toBe('financing');
    expect(classifyCashGroup('equity', 'retained_earnings')).toBe('financing');
    expect(classifyCashGroup('equity', null)).toBe('financing');
    expect(classifyCashGroup('equity', 'something_nobody_has_seen')).toBe('financing');
  });

  it('falls back to operating rather than dropping an unrecognised account', () => {
    // A line that cannot be classified is still cash that moved. Dropping it
    // would break the tie-out to the bank balance.
    expect(classifyCashGroup('asset', null)).toBe('other_operating');
    expect(classifyCashGroup('liability', 'other')).toBe('other_operating');
    expect(classifyCashGroup('expense', 'a_brand_new_importer_token')).toBe('other_operating');
  });
});

describe('apportionBankLeg', () => {
  it('distributes the bank leg exactly once across several contra lines', () => {
    // The defect this replaces summed the BANK amount once per contra line,
    // so this entry reported 1000 twice.
    const allocations = apportionBankLeg(1000, [
      contra('revenue', 'sales', -600),
      contra('revenue', 'other_income', -400),
    ]);

    const total = allocations.reduce((s, a) => s + a.amount, 0);
    expect(total).toBeCloseTo(1000, 6);
    expect(allocations.every((a) => a.cashGroup === 'cash_received_from_customers')).toBe(true);
  });

  it('splits a leg across contra lines in different groups, in proportion', () => {
    const allocations = apportionBankLeg(-500, [
      contra('expense', 'operating_expense', 200),
      contra('liability', 'payroll_liability', 300),
    ]);

    const byGroup = new Map(allocations.map((a) => [a.cashGroup, a.amount]));
    expect(byGroup.get('cash_paid_to_suppliers')).toBeCloseTo(-200, 6);
    expect(byGroup.get('cash_paid_to_employees')).toBeCloseTo(-300, 6);
    expect(allocations.reduce((s, a) => s + a.amount, 0)).toBeCloseTo(-500, 6);
  });

  it('ignores cash-equivalent contras when weighting the split', () => {
    // Bank pays 1000: 600 settles an expense, 400 moves to petty cash. The
    // transfer is not a cash flow, so the whole leg is weighted against the
    // expense. Including the petty-cash contra would report -600 suppliers
    // and -400 other, double-counting the transfer against its own leg.
    const allocations = apportionBankLeg(-1000, [
      contra('expense', 'operating_expense', 600),
      contra('asset', 'petty_cash', 400),
    ]);

    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.cashGroup).toBe('cash_paid_to_suppliers');
    expect(allocations[0]?.amount).toBeCloseTo(-1000, 6);
  });

  it('keeps a pure cash-to-cash transfer in the statement so the total still ties', () => {
    // No classifiable contra at all. The leg must still be reported, because
    // its opposite leg carries the opposite sign and the pair nets to zero.
    const allocations = apportionBankLeg(-400, [contra('asset', 'bank', 400)]);

    expect(allocations).toEqual([{ cashGroup: 'other_operating', amount: -400 }]);
  });

  it('reports a leg with no contra lines rather than discarding it', () => {
    const allocations = apportionBankLeg(250, []);
    expect(allocations).toEqual([{ cashGroup: 'other_operating', amount: 250 }]);
  });

  it('apportions a payroll payment by the signed contra amounts, not their magnitudes', () => {
    // Bank pays 70,000 net: salaries of 100,000 less 30,000 withheld as PAYE
    // and pension liabilities. The contras carry MIXED SIGNS, and weighting by
    // |amount| gets this badly wrong: it splits the 70,000 across all three in
    // the ratio 100:20:10, putting -53,846.15 on the salaries line rather than
    // the -100,000 that was actually incurred, and reporting the withheld
    // amounts as further outflows instead of the inflows they are.
    //
    // It is insidious because the pieces still sum to the bank leg either way,
    // so closing cash ties out and the pre-export blocker passes regardless.
    const allocations = apportionBankLeg(-70000, [
      contra('expense', 'operating_expense', 100000),
      contra('liability', 'payroll_liability', -20000),
      contra('liability', 'payroll_liability', -10000),
    ]);

    const byGroup = new Map<string, number>();
    for (const a of allocations) {
      byGroup.set(a.cashGroup, (byGroup.get(a.cashGroup) ?? 0) + a.amount);
    }

    expect(byGroup.get('cash_paid_to_suppliers')).toBeCloseTo(-100000, 6);
    expect(byGroup.get('cash_paid_to_employees')).toBeCloseTo(30000, 6);
    expect(allocations.reduce((s, a) => s + a.amount, 0)).toBeCloseTo(-70000, 6);
  });

  it('keeps a contra on the correct side of the statement across sections', () => {
    // Bank pays 100,000: a loan repayment of 120,000 net of 20,000 interest
    // received. Magnitude weighting reports 85,714 financing and 14,286
    // operating; the real movement is 120,000 financing against a 20,000
    // operating inflow.
    const allocations = apportionBankLeg(-100000, [
      contra('liability', 'long_term_liability', 120000),
      contra('revenue', 'other_income', -20000),
    ]);

    const byGroup = new Map(allocations.map((a) => [a.cashGroup, a.amount]));
    expect(byGroup.get('financing')).toBeCloseTo(-120000, 6);
    expect(byGroup.get('cash_received_from_customers')).toBeCloseTo(20000, 6);
    expect(allocations.reduce((s, a) => s + a.amount, 0)).toBeCloseTo(-100000, 6);
  });

  it('falls back to operating when the contras net to zero', () => {
    // A reclassification between two accounts nets to nothing, so there is no
    // proportion to divide by. The leg must still be reported or the tie-out
    // breaks.
    const allocations = apportionBankLeg(500, [
      contra('expense', 'operating_expense', 400),
      contra('expense', 'operating_expense', -400),
    ]);

    expect(allocations.reduce((s, a) => s + a.amount, 0)).toBeCloseTo(500, 6);
    expect(allocations.every((a) => Number.isFinite(a.amount))).toBe(true);
  });

  it('does not divide by zero when every contra line is zero-valued', () => {
    const allocations = apportionBankLeg(750, [contra('expense', 'operating_expense', 0)]);

    expect(allocations.reduce((s, a) => s + a.amount, 0)).toBeCloseTo(750, 6);
    expect(allocations.every((a) => Number.isFinite(a.amount))).toBe(true);
  });
});
