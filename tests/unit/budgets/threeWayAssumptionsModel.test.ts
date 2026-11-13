/**
 * What the Assumptions save sends (budgets P6 spec §13.21): a scenario over a base saves OVERRIDES — its stored
 * overrides plus each changed `Prov` or list, whole — so untouched fields keep following the base; every other
 * version saves the full document. And the form's unit conversions (percent ↔ fraction, rands ↔ cents).
 */
import { describe, expect, it } from 'vitest';
import { buildSaveDoc, displayValue, parseInput, PROV_FIELDS, savesOverrides, setManual } from '@/components/accounting/budgets/threeWay/assumptionsModel';
import { assumptionsView, V1, V2 } from '../components/budgets/threeWay/fixtures';

const field = (path: string) => PROV_FIELDS.find((f) => f.path === path)!;
const scenario = (stored: 'none' | 'overrides' | 'full') => {
  const v = assumptionsView();
  v.version = { ...v.version, id: V2, kind: 'scenario', isPrimary: false, basedOnVersionId: V1 };
  v.chain = [V2, V1];
  if (stored === 'overrides') v.stored = { doc: { schemaVersion: 1, overrides: { workingCapital: { creditorDays: { value: 10, source: 'manual' } } } }, updatedAt: 't1', updatedBy: 'u' };
  if (stored === 'full') v.stored = { doc: v.resolved, updatedAt: 't1', updatedBy: 'u' };
  return v;
};

describe('buildSaveDoc', () => {
  it('an original version saves the full document', () => {
    const v = assumptionsView();
    const edited = setManual(v.resolved, field('workingCapital.debtorDays'), 60);
    expect(savesOverrides(v)).toBe(false);
    expect(buildSaveDoc(v, edited)).toEqual(edited);
  });

  it('a scenario with nothing stored saves only the changed Prov, whole', () => {
    const v = scenario('none');
    const edited = setManual(v.resolved, field('workingCapital.debtorDays'), 90);
    expect(buildSaveDoc(v, edited)).toEqual({ schemaVersion: 1, overrides: { workingCapital: { debtorDays: { value: 90, source: 'manual' } } } });
  });

  it('a scenario keeps its stored overrides and adds the new change', () => {
    const v = scenario('overrides');
    const edited = setManual(v.resolved, field('minimumCash'), 5_000_00);
    expect(buildSaveDoc(v, edited)).toEqual({ schemaVersion: 1, overrides: {
      workingCapital: { creditorDays: { value: 10, source: 'manual' } }, minimumCash: { value: 5_000_00, source: 'manual' } } });
  });

  it('a changed list replaces whole', () => {
    const v = scenario('none');
    const capex = [{ id: 'c1', month: '2026-04', amountExVat: 100_00, vatClaimable: true, description: 'Van' }];
    expect(buildSaveDoc(v, { ...v.resolved, capex })).toEqual({ schemaVersion: 1, overrides: { capex } });
  });

  it('a scenario that stores a full document keeps saving a full document', () => {
    const v = scenario('full');
    const edited = setManual(v.resolved, field('workingCapital.debtorDays'), 90);
    expect(buildSaveDoc(v, edited)).toEqual(edited);
  });

  it('a scenario whose base is gone (chain of one) saves a full document', () => {
    const v = scenario('none');
    v.chain = [V2];
    expect(savesOverrides(v)).toBe(false);
  });
});

describe('form conversions', () => {
  it('percent fields hold a fraction', () => {
    expect(parseInput(field('vat.vatableSalesShare'), '85')).toBe(0.85);
    expect(displayValue(field('vat.vatableSalesShare'), 0.85)).toBe('85');
  });
  it('money fields hold cents', () => {
    expect(parseInput(field('minimumCash'), '1234.56')).toBe(123_456);
    expect(displayValue(field('minimumCash'), 123_456)).toBe('1234.56');
  });
  it('a blank or non-number input is no value (nothing changes)', () => {
    expect(parseInput(field('workingCapital.debtorDays'), '')).toBeNull();
    expect(parseInput(field('workingCapital.debtorDays'), 'abc')).toBeNull();
  });
  it('choices parse to their typed value', () => {
    expect(parseInput(field('vat.refundLagMonths'), '2')).toBe(2);
    expect(parseInput(field('incomeTax.topUpMonthOffset'), '7')).toBe(7);
  });
});

describe('eligiblePayableAccounts (the server rule: leaf liability, would sit in other liabilities, no loan account)', () => {
  const acc = (id: string, over: Record<string, unknown> = {}) => ({
    id, accountCode: id, accountName: `A ${id}`, accountType: 'liability', accountSubtype: undefined as string | undefined,
    parentAccountId: undefined as string | undefined, isActive: true, level: 3, ...over,
  });
  it('keeps a plain leaf liability; drops AP, VAT, payroll, credit card, a loan account, a header, inactive and non-liabilities', async () => {
    const { eligiblePayableAccounts } = await import('@/components/accounting/budgets/threeWay/assumptionsModel');
    const accounts = [
      acc('ok'), acc('ap', { accountSubtype: 'payable' }), acc('vat', { accountSubtype: 'vat_output' }),
      acc('paye', { accountSubtype: 'payroll_liability' }), acc('card', { accountSubtype: 'credit_card' }), acc('loan'),
      acc('head', { level: 2 }), acc('child', { level: 2, parentAccountId: 'head' }), acc('off', { isActive: false }),
      acc('rev', { accountType: 'revenue' }),
    ];
    expect(eligiblePayableAccounts(accounts, new Set(['loan'])).map((a) => a.id)).toEqual(['ok', 'child']);
  });
});
