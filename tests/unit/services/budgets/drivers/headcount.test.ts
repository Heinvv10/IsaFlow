/**
 * Decision 7 headcount (P4 spec §2): an employee is one full head in M when
 * start_date <= last day of M and (end_date null or >= first day of M) and not
 * inactive; cost-centre scope splits by allocation % else uses the employee's
 * centre; planned hires add FTE by month range. Results are 2-dp FTE.
 */
import { describe, it, expect } from 'vitest';
import {
  headcountByMonth, type HeadcountEmployee, type HeadcountInput,
} from '@/modules/accounting/services/budgets/drivers/headcount';

const MONTHS = ['2026-03', '2026-04', '2026-05'];

function emp(id: string, startDate: string, over: Partial<HeadcountEmployee> = {}): HeadcountEmployee {
  return { id, startDate, endDate: null, status: 'active', costCentreId: null, ...over };
}

function totals(input: Partial<HeadcountInput>, months = MONTHS): number[] {
  const out = headcountByMonth({ employees: [], allocations: [], hires: [], months, scope: null, ...input });
  return months.map(m => out.get(m)?.total ?? Number.NaN);
}

describe('employment boundaries', () => {
  it('a start on the LAST day of M counts a full head in M', () => {
    expect(totals({ employees: [emp('e1', '2026-04-30')] })).toEqual([0, 1, 1]);
  });

  it('a start on the first day of the next month does not count in M', () => {
    expect(totals({ employees: [emp('e1', '2026-05-01')] })).toEqual([0, 0, 1]);
  });

  it('an end on the FIRST day of M counts a full head in M', () => {
    expect(totals({ employees: [emp('e1', '2020-01-01', { endDate: '2026-04-01' })] })).toEqual([1, 1, 0]);
  });

  it('an end on the last day of the previous month does not count in M', () => {
    expect(totals({ employees: [emp('e1', '2020-01-01', { endDate: '2026-03-31' })] })).toEqual([1, 0, 0]);
  });

  it('leap February: a start on 29 Feb 2028 counts in February', () => {
    expect(totals({ employees: [emp('e1', '2028-02-29')] }, ['2028-01', '2028-02', '2028-03'])).toEqual([0, 1, 1]);
  });

  it('non-leap February ends on the 28th; century years follow the 400 rule', () => {
    expect(totals({ employees: [emp('e1', '2020-01-01', { endDate: '2027-02-28' })] }, ['2027-02', '2027-03'])).toEqual([1, 0]);
    expect(totals({ employees: [emp('e1', '2000-02-29')] }, ['2000-02'])).toEqual([1]);
  });

  it('inactive employees never count; other statuses do', () => {
    const employees = [emp('e1', '2020-01-01', { status: 'inactive' }), emp('e2', '2020-01-01', { status: 'suspended' })];
    expect(totals({ employees })).toEqual([1, 1, 1]);
  });

  it('refuses a malformed date', () => {
    expect(() => totals({ employees: [emp('e1', '2026-4-1')] })).toThrow(RangeError);
  });
});

describe('cost-centre scope', () => {
  const employees = [
    emp('split', '2020-01-01', { costCentreId: 'A' }),
    emp('plainA', '2020-01-01', { costCentreId: 'A' }),
    emp('plainB', '2020-01-01', { costCentreId: 'B' }),
    emp('none', '2020-01-01'),
  ];
  const allocations = [
    { employeeId: 'split', costCentreId: 'A', percentage: 60 },
    { employeeId: 'split', costCentreId: 'B', percentage: 40 },
  ];

  it('allocation rows split the head; otherwise the employee centre takes 1', () => {
    expect(totals({ employees, allocations, scope: 'A' })).toEqual([1.6, 1.6, 1.6]);
    expect(totals({ employees, allocations, scope: 'B' })).toEqual([1.4, 1.4, 1.4]);
  });

  it('company scope counts each active employee once, NULL centre included', () => {
    expect(totals({ employees, allocations, scope: null })).toEqual([4, 4, 4]);
  });

  it('a NULL centre counts only in the company scope', () => {
    expect(totals({ employees: [emp('none', '2020-01-01')], scope: 'A' })).toEqual([0, 0, 0]);
  });

  it('rounds to 2 dp (3 × 33.33% = 1.00)', () => {
    const three = ['x', 'y', 'z'].map(id => emp(id, '2020-01-01'));
    const alloc = three.map(e => ({ employeeId: e.id, costCentreId: 'A', percentage: 33.33 }));
    expect(totals({ employees: three, allocations: alloc, scope: 'A' })).toEqual([1, 1, 1]);
  });
});

describe('planned hires', () => {
  const hires = [
    { costCentreId: 'A', startMonth: '2026-04', endMonth: '2026-04', fte: 0.5 },
    { costCentreId: null, startMonth: '2026-05', endMonth: null, fte: 1 },
  ];

  it('add FTE inside [start, end]; company scope counts every hire', () => {
    const out = headcountByMonth({ employees: [emp('e1', '2020-01-01')], allocations: [], hires, months: MONTHS, scope: null });
    expect(MONTHS.map(m => out.get(m))).toEqual([
      { payroll: 1, hires: 0, total: 1 },
      { payroll: 1, hires: 0.5, total: 1.5 },
      { payroll: 1, hires: 1, total: 2 },
    ]);
  });

  it('cost-centre scope counts only that centre\'s hires', () => {
    expect(totals({ hires, scope: 'A' })).toEqual([0, 0.5, 0]);
    expect(totals({ hires, scope: 'B' })).toEqual([0, 0, 0]);
  });
});
