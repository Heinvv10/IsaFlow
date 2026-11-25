/**
 * The oracle's input builders, moved out of oracle.ts unchanged (wave-6 O3, refactor(split)): a case as the
 * calculator's PayrollLineInput. oracle.ts re-exports buildCaseInput, saIdFor and oracleTaxStatus.
 */
import type {
  EmployeeComponent, LineCadence, PayrollEmployee, PayrollLineInput, PspEntityType, TaxStatus,
} from '@/modules/accounting/services/payroll/payrollTypes';
import type { GarnisheeKind } from '@/modules/accounting/services/payroll/payrollGarnishee';
import { closesPayMonth, periodShareOf } from '@/modules/accounting/services/payroll/payFrequencyPeriods';
import { addEtiMonthParts, NO_ETI_PARTS } from '@/modules/accounting/services/payroll/payrollLineEtiMonth';
import { withFringeBenefits } from './fringeInput';
import { priorEnd, priorYearToDate, sumOf } from './oraclePriors';
import { apportionRecurringRows } from '@/modules/accounting/services/payroll/payrollRecurringShare';
import type { OracleCase, OraclePriorPeriod } from './oracle';
import type { MonthEarlierLines } from '@/modules/accounting/services/payroll/payrollOffCycleMonth';
import { costRfi, withEmployerRetirement } from './rfiInput';
import { hoursAmountCents } from '@/modules/accounting/services/payroll/payrollRunHours';
import { overtimeAmountCents, overtimeHourlyRate } from '@/modules/accounting/services/payroll/payrollRunInputUnits';

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

/**
 * A fixture's status label as the engine's tax status: only those it treats differently; every Sage label is an employee.
 * personal_service_company / personal_service_trust are a PSP of that entity (wave 6 PSP; pspEntityOf).
 */
export function oracleTaxStatus(label: string): TaxStatus {
  if (pspEntityOf(label)) return 'personal_service_provider';
  return label === 'independent_contractor' || label === 'director' ? label : 'employee';
}

/** The PSP entity a fixture's status label names, else null. */
export function pspEntityOf(label: string): PspEntityType | null {
  return label === 'personal_service_company' ? 'company' : label === 'personal_service_trust' ? 'trust' : null;
}

const numberOf = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** The case's garnishee orders (GA): kind and monthly amount, open-ended, in the order listed. */
function oracleGarnishees(c: OracleCase): Pick<PayrollLineInput, 'garnisheeOrders'> {
  const raw = c.input.unmodelled?.garnisheeOrders;
  if (!Array.isArray(raw)) return {};
  return {
    garnisheeOrders: raw.map((o: { kind: GarnisheeKind; monthlyAmount: number }, i) => ({
      id: `${c.id}-garnishee-${i}`, kind: o.kind, reference: `${c.id}-${i}`, creditorName: 'Oracle creditor',
      instalment: o.monthlyAmount, balance: null, priority: i, createdAt: '2026-01-01T00:00:00Z',
    })),
  };
}

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
    ...(input.employee.endDate ? { endDate: parseDate(input.employee.endDate) } : {}),
    ...(input.employee.dateOfBirth ? { dateOfBirth: parseDate(input.employee.dateOfBirth) } : {}),
    // ETI Act s6(b): the oracle's employees hold an ID document (a valid SA ID number for their date of birth); the cases
    // test the incentive's amount, not the document.
    ...(input.employee.dateOfBirth ? { idNumber: saIdFor(input.employee.dateOfBirth) } : {}),
    uifExcluded: input.employee.uifExcluded,
    medicalAidMainMember: input.employee.medicalAidMainMember,
    medicalAidDependantsCount: input.employee.medicalAidDependantsCount,
    s18aReceiptHeld: input.employee.s18aReceiptHeld,
    taxStatus: oracleTaxStatus(input.employee.taxStatus),
    pspEntityType: pspEntityOf(input.employee.taxStatus),
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
    // W29: a dated row is a recurring assignment (getEmployeeComponents reads its window); undated rows are as before.
    ...(x.effectiveFrom !== undefined ? { isRecurring: true, effectiveFrom: x.effectiveFrom, effectiveTo: x.effectiveTo ?? null } : {}),
  }));
  // As a run reads them (payrollRecurringShareRead): a row starting or ending inside employment at its share, before fringe and RFI.
  const period = { year: input.period.year, month: input.period.month, ...(input.period.periodStart && input.period.periodEnd ? { start: input.period.periodStart, end: input.period.periodEnd } : {}) };
  const read = apportionRecurringRows(base, { ...employee, payFrequency: input.period.frequency ?? 'monthly' }, period);
  // As a run: fringe benefits applied and employer benefits marked non-cash, then the percent-of-RFI rows costed (RF).
  const components = [...costRfi(withFringeBenefits(withEmployerRetirement(read, input.unmodelled), input.unmodelled, input.period), input.unmodelled),
    ...runInputUnitRows(c, employee, basicInForce(c, basic))];
  const cadence = caseCadence(c, employee);
  const monthEarlier = caseMonthEarlier(c);
  return {
    // A weekly or fortnightly case's frequency and dates reach the calculator (FQc); a bonus or termination case's month (OC).
    employee, components, taxYear: input.taxYear,
    period: { year: input.period.year, month: input.period.month, ...(cadence ? { start: cadence.periodStart, end: cadence.periodEnd } : {}) },
    annualPayrollEstimate: input.employerAnnualRemuneration,
    ...(input.priorPeriods ? { ytd: priorYearToDate(input.priorPeriods, employee) } : {}),
    ...(cadence ? { cadence } : {}),
    ...(monthEarlier ? { monthEarlier } : {}),
    ...oracleDirective(c),
    ...oracleGarnishees(c),
  };
}

/**
 * A bonus or termination case's month (OC), as payrollOffCycleMonthRead builds it from the stored lines: the priors paid
 * in the case's month (spec F1: the month's regular line), their UIF remuneration (`uifLeviable`, the figure the line
 * levied; at or below the ceiling the same as the remuneration) and their earnings.
 * NAMED LIMIT: a prior stores no ETI figure, so the month's earlier ETI is nil; no off-cycle case is ETI-eligible today
 * (the integration suite w6-oc-off-cycle proves the ETI difference on real lines).
 */
function caseMonthEarlier(c: OracleCase): MonthEarlierLines | undefined {
  const { period } = c.input;
  if (period.runKind !== 'bonus' && period.runKind !== 'termination') return undefined;
  if ((period.frequency ?? 'monthly') !== 'monthly') throw new Error(`${c.id}: an off-cycle case is monthly (OC)`);
  const month = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const sameMonth = (c.input.priorPeriods ?? []).filter(p => priorEnd(p).slice(0, 7) === month);
  if (sameMonth.length === 0) throw new Error(`${c.id}: an off-cycle case carries its month's regular line as a prior (spec F1)`);
  return {
    uifRemuneration: sumOf(sameMonth.map(p => p.uifLeviable)),
    eti: 0,
    etiComponents: sameMonth.flatMap((p, k) => p.components.filter(x => x.type === 'earning').map((x, i) => ({
      component: {
        id: `${c.id}-prior${k}-${i}`, name: x.name, sarsSourceCode: x.code, componentType: x.type,
        isTaxable: x.taxable, isUifApplicable: x.uif, isSdlApplicable: x.sdl,
      },
      amount: x.amount,
    }))),
  };
}

/**
 * A weekly or fortnightly case's cadence (FQc), as the run service builds it: the UIF remuneration of the priors paid in
 * the case's month (a prior's pay date is its period end), and the month's ETI parts when the case closes its month.
 * `unmodelled.periodFraction`, where a case states it, must be the share the dates give (payFrequencyPeriods).
 */
function caseCadence(c: OracleCase, employee: PayrollEmployee): LineCadence | undefined {
  const { period } = c.input;
  const frequency = period.frequency ?? 'monthly';
  if (frequency === 'monthly') return undefined;
  if (!period.periodStart || !period.periodEnd) throw new Error(`${c.id}: a ${frequency} case needs its period dates`);
  const stated = numberOf(c.input.unmodelled?.periodFraction);
  const share = periodShareOf(frequency, { start: period.periodStart, end: period.periodEnd }, employee.startDate, employee.endDate);
  if (stated != null && stated !== share) throw new Error(`${c.id}: periodFraction ${stated} is not the dates' share ${share}`);
  const month = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const sameMonth = (c.input.priorPeriods ?? []).filter(p => priorEnd(p).slice(0, 7) === month);
  return {
    frequency, periodStart: period.periodStart, periodEnd: period.periodEnd,
    uifMonthToDate: sumOf(sameMonth.map(p => p.uifLeviable)),
    etiMonthToDate: closesPayMonth(frequency, period.periodEnd)
      ? sameMonth.reduce((t, p) => addEtiMonthParts(t, {
        remuneration: p.etiRemuneration, wageCents: 0, ordinaryHours: p.etiHours, overtimeHours: 0,
      }), NO_ETI_PARTS)
      : null,
  };
}

/**
 * The monthly basic overtime is priced on, as production's monthlyBasicOf reads it (payrollRunUnitsRead): the recurring
 * 3601 rows in force on the period's last day, at their full amounts (review #1901 L3: not the first row, which after a
 * W29 split is the row that ended).
 */
function basicInForce(c: OracleCase, basic: OracleCase['input']['components']): number {
  const { period } = c.input;
  const last = period.periodEnd ?? `${period.year}-${String(period.month).padStart(2, '0')}-${String(new Date(period.year, period.month, 0).getDate()).padStart(2, '0')}`;
  return basic.filter(x => x.effectiveFrom === undefined || (x.effectiveFrom <= last && (x.effectiveTo == null || x.effectiveTo >= last)))
    .reduce((t, x) => t + x.amount, 0);
}

/**
 * RI: overtime (`overtimeHours` at `overtimeMultiplier`) and reimbursive travel (`businessKm` at `reimbursiveRatePerKm`) as the
 * run stores them: a 3607 hours row priced on the server (payrollRunInputUnits.overtimeAmountCents) and a km row on a 3702 earning.
 */
function runInputUnitRows(c: OracleCase, employee: PayrollEmployee, monthlyBasic: number): EmployeeComponent[] {
  const u = c.input.unmodelled;
  const rows: EmployeeComponent[] = [];
  const hours = numberOf(u?.overtimeHours);
  const multiplier = numberOf(u?.overtimeMultiplier);
  if (hours != null && multiplier != null) {
    const rate = overtimeHourlyRate(employee, monthlyBasic);
    if (rate == null) throw new Error(`${c.id}: overtime needs an hourly rate`);
    rows.push({ component: { id: `${c.id}-overtime`, name: 'Overtime', sarsSourceCode: '3607', componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true },
      amount: overtimeAmountCents(hours, rate, multiplier) / 100, quantity: hours, quantityUnit: 'hour', rateMultiplier: multiplier });
  }
  const km = numberOf(u?.businessKm);
  const perKm = numberOf(u?.reimbursiveRatePerKm);
  if (km != null && perKm != null) {
    rows.push({ component: { id: `${c.id}-travel`, name: 'Travel reimbursement', sarsSourceCode: '3702', componentType: 'earning', isTaxable: false, isUifApplicable: false, isSdlApplicable: false },
      amount: hoursAmountCents(km, perKm) / 100, quantity: km, quantityUnit: 'km' });
  }
  return rows;
}

export { priorYearToDate };
