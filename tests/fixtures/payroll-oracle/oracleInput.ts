/**
 * The oracle's input builders, moved out of oracle.ts unchanged (wave-6 O3, refactor(split)): a case as the
 * calculator's PayrollLineInput. oracle.ts re-exports buildCaseInput, saIdFor and oracleTaxStatus.
 */
import type { EmployeeComponent, PayeYearToDate, PayrollEmployee, PayrollLineInput, TaxStatus } from '@/modules/accounting/services/payroll/payrollTypes';
import { withFringeBenefits } from './fringeInput';
import type { OracleCase, OraclePriorPeriod } from './oracle';
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
    // Only the month reaches the calculator: it has no frequency, period dates or run kind yet (FQc, OC).
    employee, components, period: { year: input.period.year, month: input.period.month }, taxYear: input.taxYear,
    annualPayrollEstimate: input.employerAnnualRemuneration,
    ...(input.priorPeriods ? { ytd: priorYearToDate(input.priorPeriods) } : {}),
    ...oracleDirective(c),
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const sumOf = (xs: readonly number[]): number => round2(xs.reduce((t, x) => t + x, 0));
const RETIREMENT_CODES = ['4001', '4003', '4006'];

/**
 * The earlier periods as the year to date loadPayeYearToDate would return for those stored lines (wave-6 F1), so the
 * engine sees what a real run sees. Each figure is the stored one, summed; the rest are read from the period's
 * components the way the reader reads a line's breakdown (4005 fees, 4001/4003/4006 contributions, taxable 4030
 * donations, SDL-flagged earnings).
 * NAMED LIMITS: `periods` counts a prior with periodicTaxable > 0 (the reader counts pay before deductions, so a prior
 * whose deductions take its periodic pay to nil is no period here); the SDL leviable a prior stored is its SDL pay less
 * its retirement deduction, floored at nil (no donation); no s18A receipt, no 65+ credit and no PAYE-outside-tables
 * prior. uifEmployee, uifLeviable, businessKm, etiRemuneration and etiHours have no year-to-date field yet: they are
 * validated and carried for FQc, OC and RI, not passed.
 */
export function priorYearToDate(priors: readonly OraclePriorPeriod[]): PayeYearToDate {
  const amounts = (p: OraclePriorPeriod, keep: (x: OraclePriorPeriod['components'][number]) => boolean) =>
    p.components.filter(keep).reduce((t, x) => t + x.amount, 0);
  const deduction = (codes: string[]) => (p: OraclePriorPeriod) =>
    amounts(p, x => x.type === 'deduction' && codes.includes(x.code));
  const sdlPay = (p: OraclePriorPeriod) => amounts(p, x => x.type === 'earning' && x.sdl);
  return {
    periods: priors.filter(p => p.periodicTaxable > 0).length,
    retirementCapPeriods: priors.filter(p => p.periodicTaxable > 0 || p.annualPayments > 0).length,
    periodicTaxable: sumOf(priors.map(p => p.periodicTaxable)),
    annualPayments: sumOf(priors.map(p => p.annualPayments)),
    tablePaye: sumOf(priors.map(p => p.paye)),
    medicalCredit: sumOf(priors.map(p => p.medicalCredit)),
    additionalMedicalCredit: 0,
    medicalSchemeFees: sumOf(priors.map(deduction(['4005']))),
    retirementContributions: sumOf(priors.map(deduction(RETIREMENT_CODES))),
    retirementDeduction: sumOf(priors.map(p => p.retirementDeduction)),
    donations: sumOf(priors.map(p => amounts(p, x => x.type === 'deduction' && x.code === '4030' && x.taxable))),
    donationReceipted: 0,
    donationBase: 0,
    donationDeduction: 0,
    sdlApplicable: sumOf(priors.map(sdlPay)),
    sdlLeviable: sumOf(priors.map(p => Math.max(0, sdlPay(p) - p.retirementDeduction))),
    sdlRetirementDeduction: sumOf(priors.map(p => p.retirementDeduction)),
    sdlDonationDeduction: 0,
  };
}
