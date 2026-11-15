/**
 * The oracle's input builders, moved out of oracle.ts unchanged (wave-6 O3, refactor(split)): a case as the
 * calculator's PayrollLineInput. oracle.ts re-exports buildCaseInput, saIdFor and oracleTaxStatus.
 */
import type { EmployeeComponent, PayrollEmployee, PayrollLineInput, TaxStatus } from '@/modules/accounting/services/payroll/payrollTypes';
import { withFringeBenefits } from './fringeInput';
import type { OracleCase } from './oracle';
import { costRfi, withEmployerRetirement } from './rfiInput';

/** A valid 13-digit SA ID number for a date of birth (YYMMDD 5009 0 8 + the Luhn check digit). */
export function saIdFor(dob: string): string {
  const base = `${dob.slice(2, 4)}${dob.slice(5, 7)}${dob.slice(8, 10)}500908`;
  for (let c = 0; c < 10; c += 1) {
    const id = base + c;
    let sum = 0;
    for (let i = 0; i < 13; i += 1) {
      let d = Number(id[12 - i]);
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    if (sum % 10 === 0) return id;
  }
  throw new Error(`no SA ID for ${dob}`);
}

function parseDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad date ${s}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** A fixture's status label as the engine's tax status: only the two it treats differently; every Sage label is an employee. */
export function oracleTaxStatus(label: string): TaxStatus {
  return label === 'independent_contractor' || label === 'director' ? label : 'employee';
}

const numberOf = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** An IRP3(b) percentage or IRP3(c) amount from the case, as the run's directive for the period (DR). */
function oracleDirective(c: OracleCase): Pick<PayrollLineInput, 'regularPayDirective'> {
  const rate = numberOf(c.input.unmodelled?.fixedRateDirectivePercent);
  const amount = numberOf(c.input.unmodelled?.fixedAmountDirective);
  if (rate == null && amount == null) return {};
  const endsOn = `${c.input.taxYear}-02-28`;
  const effectiveDate = `${c.input.taxYear - 1}-03-01`;
  return {
    regularPayDirective: {
      current: rate != null
        ? { id: `${c.id}-directive`, number: null, type: 'fixed_percentage', rate: rate / 100, fixedAmount: null, endsOn, effectiveDate }
        : { id: `${c.id}-directive`, number: null, type: 'fixed_amount', rate: null, fixedAmount: amount!, endsOn, effectiveDate },
      ended: null,
    },
  };
}

/** The calculator's input for a case, exactly what runCase costs (exported so a test can see what reaches it). */
export function buildCaseInput(c: OracleCase): PayrollLineInput {
  const { input } = c;
  const hoursPerWeek = numberOf(input.unmodelled?.ordinaryHoursPerWeek);
  const dayRate = numberOf(input.unmodelled?.dayRate);
  const monthlyHours = numberOf(input.unmodelled?.monthlyHours);
  const basic = input.components.filter(x => x.type === 'earning' && x.code === '3601');
  if (monthlyHours != null && (dayRate != null || basic.length !== 1)) {
    throw new Error(`${c.id}: monthlyHours needs exactly one 3601 earning and no dayRate`);
  }
  const employee: PayrollEmployee = {
    id: c.id,
    companyId: 'oracle',
    employeeNumber: c.id,
    firstName: 'Oracle',
    lastName: 'Case',
    employmentType: input.employee.taxStatus === 'temporary_part_time' ? 'casual' : 'permanent',
    startDate: parseDate(input.employee.startDate),
    ...(input.employee.dateOfBirth ? { dateOfBirth: parseDate(input.employee.dateOfBirth) } : {}),
    // ETI Act s6(b): the oracle's employees hold an ID document (a valid SA ID number for their date of birth); the cases
    // test the incentive's amount, not the document.
    ...(input.employee.dateOfBirth ? { idNumber: saIdFor(input.employee.dateOfBirth) } : {}),
    uifExcluded: input.employee.uifExcluded,
    medicalAidMainMember: input.employee.medicalAidMainMember,
    medicalAidDependantsCount: input.employee.medicalAidDependantsCount,
    s18aReceiptHeld: input.employee.s18aReceiptHeld,
    taxStatus: oracleTaxStatus(input.employee.taxStatus),
    payBasis: dayRate != null ? 'daily' : monthlyHours != null ? 'hourly' : 'monthly',
    hoursPerWeek,
    hoursPerDay: numberOf(input.unmodelled?.hoursPerDay),
    dailyRate: dayRate,
    hourlyRate: monthlyHours != null && monthlyHours > 0 ? basic[0]!.amount / monthlyHours : null,
  };
  const base: EmployeeComponent[] = input.components.map((x, i) => ({
    component: {
      id: `${c.id}-${i}`, name: x.name, sarsSourceCode: x.code, componentType: x.type,
      isTaxable: x.taxable, isUifApplicable: x.uif, isSdlApplicable: x.sdl,
    },
    amount: x.amount,
    ...(monthlyHours != null && x === basic[0] ? { quantity: monthlyHours, quantityUnit: 'hour' as const } : {}),
  }));
  // As a run: fringe benefits applied and employer benefits marked non-cash, then the percent-of-RFI rows costed (RF).
  const components = costRfi(withFringeBenefits(withEmployerRetirement(base, input.unmodelled), input.unmodelled, input.period), input.unmodelled);
  return {
    employee, components, period: input.period, taxYear: input.taxYear,
    annualPayrollEstimate: input.employerAnnualRemuneration,
    ...oracleDirective(c),
  };
}
