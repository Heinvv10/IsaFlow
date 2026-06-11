import { describe, it, expect } from 'vitest';
import { compareParallelRun } from '@/modules/accounting/services/payroll/payrollParallelRunComparator';
import { buildParallelRunComparisonCsv } from '@/modules/accounting/services/payroll/payrollParallelRunCsv';

describe('buildParallelRunComparisonCsv', () => {
  it('renders one row per employee per component plus totals, rand amounts', () => {
    const report = compareParallelRun(
      [{
        employeeNumber: 'E001', employeeName: 'Mokoena, Thandi',
        gross: 2500000, paye: 395542, uifEmployee: 17712, uifEmployer: 17712,
        sdl: 25000, eti: 0, net: 2089035,
      }],
      [{
        employeeNumber: 'E001', employeeName: 'Mokoena, Thandi',
        amounts: { gross: 2500000, paye: 395542, net: 2089034 },
      }],
    );
    const csv = buildParallelRunComparisonCsv(report);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('employee_number,employee_name,status,component,isaflow,external,diff');
    // 3 compared components for the employee + 3 total rows
    expect(lines).toHaveLength(7);
    expect(csv).toContain('E001,"Mokoena, Thandi",variance,Net Pay,20890.35,20890.34,0.01');
    expect(csv).toContain('TOTAL,,,Gross,25000.00,25000.00,0.00');
  });

  it('leaves missing-side amounts blank', () => {
    const report = compareParallelRun(
      [],
      [{ employeeNumber: 'E009', employeeName: 'Ghost', amounts: { net: 100000 } }],
    );
    const csv = buildParallelRunComparisonCsv(report);
    expect(csv).toContain('E009,Ghost,missing_in_isaflow,Net Pay,,1000.00,');
  });
});
