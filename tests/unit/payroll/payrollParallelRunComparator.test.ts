import { describe, it, expect } from 'vitest';
import { compareParallelRun } from '@/modules/accounting/services/payroll/payrollParallelRunComparator';
import type {
  ExternalPayslipRow,
  IsaflowRunLineInput,
} from '@/modules/accounting/services/payroll/payrollParallelRunTypes';

function isaLine(overrides: Partial<IsaflowRunLineInput> = {}): IsaflowRunLineInput {
  return {
    employeeNumber: 'E001',
    employeeName: 'Thandi Mokoena',
    gross: 2500000,
    paye: 395542,
    uifEmployee: 17712,
    uifEmployer: 17712,
    sdl: 25000,
    eti: 0,
    net: 2089034,
    ...overrides,
  };
}

function extRow(overrides: Partial<ExternalPayslipRow> = {}): ExternalPayslipRow {
  return {
    employeeNumber: 'E001',
    employeeName: 'Thandi Mokoena',
    amounts: {
      gross: 2500000,
      paye: 395542,
      uifEmployee: 17712,
      uifEmployer: 17712,
      sdl: 25000,
      eti: 0,
      net: 2089034,
    },
    ...overrides,
  };
}

describe('compareParallelRun', () => {
  it('identical sides match to the cent', () => {
    const report = compareParallelRun([isaLine()], [extRow()]);
    expect(report.employees).toHaveLength(1);
    const emp = report.employees[0]!;
    expect(emp.status).toBe('match');
    expect(emp.maxAbsDiffCents).toBe(0);
    for (const c of emp.components) {
      expect(c.diffCents).toBe(0);
    }
    expect(report.summary.matchToTheCent).toBe(1);
    expect(report.summary.withVariance).toBe(0);
  });

  it('a one-cent PAYE difference is a variance, signed isaflow - external', () => {
    const report = compareParallelRun(
      [isaLine({ paye: 395543 })],
      [extRow()],
    );
    const emp = report.employees[0]!;
    expect(emp.status).toBe('variance');
    const paye = emp.components.find((c) => c.component === 'paye')!;
    expect(paye.diffCents).toBe(1);
    expect(emp.maxAbsDiffCents).toBe(1);
    expect(report.summary.withVariance).toBe(1);
    expect(report.summary.matchToTheCent).toBe(0);
  });

  it('matches employee numbers case-insensitively with trimming', () => {
    const report = compareParallelRun(
      [isaLine({ employeeNumber: ' e001 ' })],
      [extRow({ employeeNumber: 'E001' })],
    );
    expect(report.employees[0]!.status).toBe('match');
  });

  it('matches numeric employee numbers across zero-padding (VIP pads, IsaFlow may not)', () => {
    const report = compareParallelRun(
      [isaLine({ employeeNumber: '1' })],
      [extRow({ employeeNumber: '001' })],
    );
    expect(report.employees[0]!.status).toBe('match');
  });

  it('does NOT strip zero-padding from alphanumeric numbers', () => {
    const report = compareParallelRun(
      [isaLine({ employeeNumber: 'E1' })],
      [extRow({ employeeNumber: 'E001' })],
    );
    expect(report.employees).toHaveLength(2);
    expect(report.summary.missingInIsaflow).toBe(1);
    expect(report.summary.missingInExternal).toBe(1);
  });

  it('employee only in external is missing_in_isaflow', () => {
    const report = compareParallelRun(
      [],
      [extRow({ employeeNumber: 'E099', employeeName: 'Ghost Ext' })],
    );
    const emp = report.employees[0]!;
    expect(emp.status).toBe('missing_in_isaflow');
    expect(emp.employeeName).toBe('Ghost Ext');
    expect(report.summary.missingInIsaflow).toBe(1);
  });

  it('employee only in IsaFlow is missing_in_external', () => {
    const report = compareParallelRun([isaLine({ employeeNumber: 'E098' })], []);
    expect(report.employees[0]!.status).toBe('missing_in_external');
    expect(report.summary.missingInExternal).toBe(1);
  });

  it('only compares components present in the external data', () => {
    const report = compareParallelRun(
      [isaLine()],
      [extRow({ amounts: { gross: 2500000, paye: 395542, net: 2089034 } })],
    );
    const emp = report.employees[0]!;
    expect(emp.status).toBe('match');
    expect(report.componentsCompared.sort()).toEqual(['gross', 'net', 'paye']);
    expect(emp.components.map((c) => c.component).sort()).toEqual(['gross', 'net', 'paye']);
  });

  it('uifTotal compares against IsaFlow employee + employer UIF', () => {
    const report = compareParallelRun(
      [isaLine({ uifEmployee: 17712, uifEmployer: 17712 })],
      [extRow({ amounts: { gross: 2500000, uifTotal: 35424, net: 2089034 } })],
    );
    const emp = report.employees[0]!;
    const uif = emp.components.find((c) => c.component === 'uifTotal')!;
    expect(uif.isaflowCents).toBe(35424);
    expect(uif.diffCents).toBe(0);
    expect(emp.status).toBe('match');
  });

  it('toleranceCents turns a sub-tolerance diff into a match', () => {
    const report = compareParallelRun(
      [isaLine({ net: 2089035 })],
      [extRow()],
      { toleranceCents: 1 },
    );
    expect(report.employees[0]!.status).toBe('match');
    expect(report.toleranceCents).toBe(1);
    // diff is still reported even when tolerated
    const net = report.employees[0]!.components.find((c) => c.component === 'net')!;
    expect(net.diffCents).toBe(1);
  });

  it('summary component totals are full-side grand totals', () => {
    const report = compareParallelRun(
      [isaLine(), isaLine({ employeeNumber: 'E002', gross: 1000000, net: 900000 })],
      [extRow({ amounts: { gross: 2500000, net: 2089034 } })],
    );
    const gross = report.summary.componentTotals.find((c) => c.component === 'gross')!;
    expect(gross.isaflowCents).toBe(3500000);
    expect(gross.externalCents).toBe(2500000);
    expect(gross.diffCents).toBe(1000000);
  });

  it('matchRate is matched-to-the-cent over employees on both sides', () => {
    const report = compareParallelRun(
      [
        isaLine(),
        isaLine({ employeeNumber: 'E002', paye: 100 }),
        isaLine({ employeeNumber: 'E003' }),
      ],
      [
        extRow(),
        extRow({ employeeNumber: 'E002' }),
        // E003 missing externally
      ],
    );
    expect(report.summary.matchRate).toBeCloseTo(0.5, 5);
  });

  it('matchRate is null when no employees are on both sides', () => {
    const report = compareParallelRun([isaLine()], []);
    expect(report.summary.matchRate).toBeNull();
  });

  it('orders rows: missing first, then variances by magnitude desc, then matches', () => {
    const report = compareParallelRun(
      [
        isaLine({ employeeNumber: 'E001' }),                  // match
        isaLine({ employeeNumber: 'E002', net: 2089134 }),    // variance 100c
        isaLine({ employeeNumber: 'E003', net: 2090034 }),    // variance 1000c
        isaLine({ employeeNumber: 'E004' }),                  // missing in external
      ],
      [
        extRow({ employeeNumber: 'E001' }),
        extRow({ employeeNumber: 'E002' }),
        extRow({ employeeNumber: 'E003' }),
        extRow({ employeeNumber: 'E005' }),                   // missing in isaflow
      ],
    );
    expect(report.employees.map((e) => e.status)).toEqual([
      'missing_in_isaflow',
      'missing_in_external',
      'variance',
      'variance',
      'match',
    ]);
    const [, , v1, v2] = report.employees;
    expect(v1!.maxAbsDiffCents).toBe(1000);
    expect(v2!.maxAbsDiffCents).toBe(100);
  });

  it('empty both sides yields an empty, sane report', () => {
    const report = compareParallelRun([], []);
    expect(report.employees).toEqual([]);
    expect(report.summary.matchRate).toBeNull();
    expect(report.summary.employeesIsaflow).toBe(0);
    expect(report.summary.employeesExternal).toBe(0);
  });
});
