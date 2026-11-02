/**
 * One employee's labour as debit lines, by the pay run's rule — what a SARS
 * directive paid outside payroll now posts (follow-up A of PR #1065): the
 * allocations split it, the mapping picks each account, a taggable centre is
 * the line's CC1, any other centre posts untagged on its account.
 */
import { describe, it, expect } from 'vitest';
import { employeeLabourLines, type EmployeeLabourSplit } from '@/modules/accounting/services/payroll/payrollCostCentreTags';

const split = (over: Partial<EmployeeLabourSplit>): EmployeeLabourSplit => ({
  employeeId: 'e1', costCentreId: null, allocations: [], mappings: {}, taggable: new Set(), advisory: null, ...over,
});
const view = (s: EmployeeLabourSplit, amount: number) =>
  employeeLabourLines(s, amount, 'acct-5200', 'SARS directive 1 — W — gross lump sum').map((l) => [l.glAccountId, l.cc1Id ?? null, l.debit, l.credit]);

describe('employeeLabourLines', () => {
  it('no centre: the whole amount on the default account, untagged (as before)', () => {
    expect(view(split({}), 1000)).toEqual([['acct-5200', null, 1000, 0]]);
  });

  it('own centre, mapped and taggable: its account and its CC1', () => {
    expect(view(split({ costCentreId: 'A', mappings: { A: 'acct-5210' }, taggable: new Set(['A']) }), 1000)).toEqual([['acct-5210', 'A', 1000, 0]]);
  });

  it('allocations split it to the cent; unmapped keeps CC1 on the default; untaggable posts untagged', () => {
    const s = split({
      costCentreId: 'IGNORED',
      allocations: [{ costCentreId: 'A', percentage: 33.33 }, { costCentreId: 'B', percentage: 33.33 }, { costCentreId: 'OLD', percentage: 33.34 }],
      mappings: { A: 'acct-5210', OLD: 'acct-5210' },
      taggable: new Set(['A', 'B']),
    });
    const lines = view(s, 100.01);
    expect(lines).toEqual([['acct-5210', 'A', 33.33, 0], ['acct-5210', null, 33.35, 0], ['acct-5200', 'B', 33.33, 0]]);
    expect(lines.reduce((t, l) => t + Math.round(Number(l[2]) * 100), 0)).toBe(10001);
  });

  it('an untagged line carries no cc1Id key at all (JournalLineInput.cc1Id is optional)', () => {
    const [line] = employeeLabourLines(split({}), 10, 'acct-5200', 'd');
    expect(line).not.toHaveProperty('cc1Id');
  });
});
