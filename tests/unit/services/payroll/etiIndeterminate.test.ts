/**
 * ETI: "we could not determine eligibility" must not look like "not eligible".
 *
 * The silent nil: payrollCalculator guarded `calculateEti` with
 * `employee.dateOfBirth && employee.startDate` and, when either was missing,
 * substituted a hardcoded `{ isEligible: false, monthlyEti: 0 }`. That is
 * indistinguishable from a real determination of ineligibility, and it is what
 * every production run has been doing: all 11 payroll_employees rows have a NULL
 * date_of_birth, so calculateEti has never once been called and total_eti is
 * 0.00 on all 87 runs. Nobody was ever told.
 *
 * The engine may not guess. Unknown stays unknown, no ETI is claimed, and the
 * run still calculates — but a warning names the employee and the missing field.
 */

import { describe, it, expect } from 'vitest';
import { calculateEti, resolveEtiForEmployee } from '@/modules/accounting/services/payroll/etiEngine';
import { validateEti } from '@/modules/accounting/services/payroll/validationEngine';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { PayrollLineInput, PayrollComponent } from '@/modules/accounting/services/payroll/payrollTypes';
import type { PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const TAX_YEAR = 2026;
const PERIOD_DATE = new Date(2026, 2, 28);
/** 24 years old at PERIOD_DATE, 6 months employed, R3,000/month → clearly eligible. */
const DOB = new Date(2002, 0, 15);
const START = new Date(2025, 9, 1);

const determinable = {
  dateOfBirth: DOB,
  employmentStartDate: START,
  periodDate: PERIOD_DATE,
  monthlyRemuneration: 3000,
  isUifExcluded: false,
};

function employee(over: Partial<PayrollEmployee> = {}): PayrollEmployee {
  return {
    id: 'emp-1',
    firstName: 'Thandi',
    lastName: 'Mokoena',
    dateOfBirth: DOB,
    startDate: START,
    uifExcluded: false,
    ...over,
  } as unknown as PayrollEmployee;
}

describe('calculateEti — a real determination is marked determinable', () => {
  it('marks an eligible result determinable with no missing inputs', () => {
    const r = calculateEti(determinable, TAX_YEAR);
    expect(r.isEligible).toBe(true);
    expect(r.isDeterminable).toBe(true);
    expect(r.missingInputs).toEqual([]);
    expect(r.monthlyEti).toBeGreaterThan(0);
  });

  it('marks a genuinely INELIGIBLE result determinable, with a reason', () => {
    // 50 years old — outside the 18-35 band. A real determination, not a gap.
    const r = calculateEti(
      { ...determinable, dateOfBirth: new Date(1976, 0, 15) },
      TAX_YEAR,
    );
    expect(r.isEligible).toBe(false);
    expect(r.isDeterminable).toBe(true);
    expect(r.missingInputs).toEqual([]);
    expect(r.ineligibilityReason).toBeTruthy();
    expect(r.monthlyEti).toBe(0);
  });

  it('marks every ineligibility branch determinable', () => {
    const branches = [
      { ...determinable, dateOfBirth: new Date(2012, 0, 15) },        // too young
      { ...determinable, isUifExcluded: true },                        // UIF-excluded
      { ...determinable, monthlyRemuneration: 90_000 },                // over ceiling
      { ...determinable, employmentStartDate: new Date(2020, 0, 1) },  // window expired
    ];
    for (const input of branches) {
      const r = calculateEti(input, TAX_YEAR);
      expect(r.isEligible).toBe(false);
      expect(r.isDeterminable).toBe(true);
      expect(r.missingInputs).toEqual([]);
      expect(r.ineligibilityReason).toBeTruthy();
    }
  });
});

describe('resolveEtiForEmployee — an absent input is indeterminate, not ineligible', () => {
  it('reports indeterminate when date_of_birth is missing', () => {
    const r = resolveEtiForEmployee(
      { ...determinable, dateOfBirth: null }, TAX_YEAR,
    );
    expect(r.isDeterminable).toBe(false);
    expect(r.missingInputs).toEqual(['date_of_birth']);
    // No claim is made on unknown data.
    expect(r.monthlyEti).toBe(0);
    expect(r.isEligible).toBe(false);
    // A REASON would assert a determination that was never made.
    expect(r.ineligibilityReason).toBeUndefined();
  });

  it('reports indeterminate when employment_start_date is missing', () => {
    const r = resolveEtiForEmployee(
      { ...determinable, employmentStartDate: undefined }, TAX_YEAR,
    );
    expect(r.isDeterminable).toBe(false);
    expect(r.missingInputs).toEqual(['employment_start_date']);
    expect(r.monthlyEti).toBe(0);
  });

  it('lists BOTH missing inputs when both are absent — the production shape', () => {
    const r = resolveEtiForEmployee(
      { ...determinable, dateOfBirth: null, employmentStartDate: null }, TAX_YEAR,
    );
    expect(r.isDeterminable).toBe(false);
    expect([...r.missingInputs].sort()).toEqual(['date_of_birth', 'employment_start_date']);
  });

  it('delegates to calculateEti when every input is present', () => {
    const viaResolve = resolveEtiForEmployee(determinable, TAX_YEAR);
    const direct = calculateEti(determinable, TAX_YEAR);
    expect(viaResolve).toEqual(direct);
    expect(viaResolve.isDeterminable).toBe(true);
  });

  it('never invents a date of birth or guesses eligibility', () => {
    const r = resolveEtiForEmployee(
      { ...determinable, dateOfBirth: null }, TAX_YEAR,
    );
    // employmentYear/monthsEmployed must not be fabricated from a default DOB.
    expect(r.employmentYear).toBeNull();
    expect(r.isEligible).toBe(false);
  });
});

describe('validateEti — the warning a human sees before approving', () => {
  it('raises a WARNING (never an error) naming the employee and the missing field', () => {
    const eti = resolveEtiForEmployee({ ...determinable, dateOfBirth: null }, TAX_YEAR);
    const results = validateEti(employee({ dateOfBirth: undefined }), eti);

    expect(results).toHaveLength(1);
    const w = results[0]!;
    expect(w.code).toBe('ETI_INDETERMINATE');
    // Requirement: warn, never block. An 'error' would stop people being paid.
    expect(w.severity).toBe('warning');
    expect(w.message).toContain('Thandi Mokoena');
    expect(w.message).toContain('date of birth');
    expect(w.field).toBe('dateOfBirth');
    expect(w.deepLink).toContain('emp-1');
  });

  it('names both fields when both are missing', () => {
    const eti = resolveEtiForEmployee(
      { ...determinable, dateOfBirth: null, employmentStartDate: null }, TAX_YEAR,
    );
    const w = validateEti(employee(), eti)[0]!;
    expect(w.message).toContain('date of birth');
    expect(w.message).toContain('start date');
  });

  it('says nothing when ETI was genuinely determined — eligible or not', () => {
    expect(validateEti(employee(), calculateEti(determinable, TAX_YEAR))).toEqual([]);
    const ineligible = calculateEti(
      { ...determinable, dateOfBirth: new Date(1976, 0, 15) }, TAX_YEAR,
    );
    expect(validateEti(employee(), ineligible)).toEqual([]);
  });
});

describe('calculatePayrollLine — the wiring that produced the production silent nil', () => {
  const component: PayrollComponent = {
    id: 'comp-1', name: 'Basic Salary', sarsSourceCode: '3601',
    componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true,
  };

  function lineInput(over: Partial<PayrollEmployee>): PayrollLineInput {
    return {
      employee: {
        id: 'emp-1', companyId: 'co-1', employeeNumber: 'E001',
        firstName: 'Thandi', lastName: 'Mokoena',
        idNumber: '0201155009087', taxNumber: '1234567890',
        employmentType: 'permanent',
        startDate: START, dateOfBirth: DOB,
        uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0,
        ...over,
      } as PayrollEmployee,
      components: [{ component, amount: 3000 }],
      period: { month: 3, year: 2026 },
      taxYear: TAX_YEAR,
      annualPayrollEstimate: 1_000_000,
    };
  }

  it('reports indeterminate ETI when the employee has no date of birth', () => {
    // This is the exact production shape: all 11 payroll_employees rows.
    const line = calculatePayrollLine(lineInput({ dateOfBirth: undefined }));
    expect(line.eti.isDeterminable).toBe(false);
    expect(line.eti.missingInputs).toEqual(['date_of_birth']);
    expect(line.eti.monthlyEti).toBe(0);
    // ...and the run still calculates the employee's pay normally.
    expect(line.grossPay).toBeCloseTo(3000, 2);
    expect(line.netPay).toBeGreaterThan(0);
  });

  it('reports a real determination when both dates are present', () => {
    const line = calculatePayrollLine(lineInput({}));
    expect(line.eti.isDeterminable).toBe(true);
    expect(line.eti.missingInputs).toEqual([]);
  });

  it('raises exactly one warning for the run when the DOB is absent', () => {
    const input = lineInput({ dateOfBirth: undefined });
    const line = calculatePayrollLine(input);
    const warnings = validateEti(input.employee, line.eti);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('warning');
    expect(warnings[0]!.message).toContain('Thandi Mokoena');
  });
});
