/**
 * Payroll oracle: loads the cases in this directory, costs each one with the pure
 * calculatePayrollLine, and compares to the cent (wave-4 spec §4 O).
 *
 * A case's `expected` comes from an outside source (`source`), never from the engine.
 * The tax status and the work terms (`taxStatus`; `unmodelled.ordinaryHoursPerWeek`, `hoursPerDay`, `dayRate`) reach the
 * calculator (buildCaseInput, TS-b). `monthlyHours` (ET) reaches it as an hourly employee whose Basic Salary (3601) row
 * records those hours, the way HD stores a run's hours; `ordinaryHoursWage` is what the engine derives from that row.
 * Inputs the engine still has no field for (a fixed-rate directive, fringe terms) stay in `unmodelled` so the gap is
 * visible; they are not passed to it (oracleInputs.test.ts names each one's owner).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { EmployeeComponent, PayrollEmployee, PayrollLineInput, TaxStatus } from '@/modules/accounting/services/payroll/payrollTypes';
import { withFringeBenefits } from './fringeInput';
import { ORACLE_FIELDS, validateCase, type OracleField } from './validate';

export { ORACLE_FIELDS, type OracleField };

export const ORACLE_DIR = __dirname;

export interface OracleComponent {
  code: string;
  /**
   * NAMED LIMIT: `name` is free text and is exempt from the PII key check (validate.ts checks
   * keys, not values), so a personal name written here cannot be detected. Use a generic label.
   */
  name: string;
  type: 'earning' | 'deduction';
  amount: number;
  taxable: boolean;
  uif: boolean;
  sdl: boolean;
}

export interface OracleCase {
  id: string;
  source: string;
  sourceRef: string;
  notes: string;
  input: {
    period: { year: number; month: number };
    taxYear: number;
    employee: {
      dateOfBirth: string | null;
      startDate: string;
      taxStatus: string;
      uifExcluded: boolean;
      medicalAidMainMember: boolean;
      medicalAidDependantsCount: number;
      s18aReceiptHeld: boolean;
    };
    employerAnnualRemuneration: number;
    components: OracleComponent[];
    /** Inputs the calculator takes only in part (the work terms are passed; the rest are recorded, not passed). */
    unmodelled?: Record<string, unknown>;
  };
  /** Only the fields the source gives are asserted. */
  expected: Partial<Record<OracleField, number>>;
  /**
   * Documented rounding only: at most MAX_TOLERANCE_CENTS per field, with the reason. `engineActual`
   * pins the engine's CURRENT figure exactly, so it cannot drift inside the tolerance unnoticed.
   */
  tolerance?: Partial<Record<OracleField, { cents: number; reason: string; engineActual: number }>>;
}

/**
 * A case that misses its source today. `engineActual` is the engine's CURRENT figure for each
 * missed field, asserted exactly: the gap is a pinned amount, so drift inside it is red too.
 */
export interface KnownGap {
  case: string;
  engineActual: Partial<Record<OracleField, number>>;
  reason: string;
  closedBy: string;
}

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

export function loadCases(): OracleCase[] {
  const files = readdirSync(ORACLE_DIR).filter(f => f.endsWith('.json') && f !== 'knownGaps.json').sort();
  return files.map(f => {
    const raw: unknown = JSON.parse(readFileSync(join(ORACLE_DIR, f), 'utf8'));
    validateCase(raw, f);
    return raw as OracleCase;
  });
}

export function loadKnownGaps(): KnownGap[] {
  return JSON.parse(readFileSync(join(ORACLE_DIR, 'knownGaps.json'), 'utf8')) as KnownGap[];
}

/** Problems with the gap list itself: unknown cases, duplicates, empty entries, UNVERIFIED cases off the list. */
export function gapListProblems(cases: readonly OracleCase[], gaps: readonly KnownGap[]): string[] {
  const problems: string[] = [];
  const byId = new Map(cases.map(c => [c.id, c]));
  const seen = new Set<string>();
  for (const g of gaps) {
    const c = byId.get(g.case);
    if (!c) problems.push(`${g.case}: on knownGaps but has no fixture`);
    if (seen.has(g.case)) problems.push(`${g.case}: listed twice`);
    seen.add(g.case);
    const fields = Object.keys(g.engineActual ?? {});
    if (fields.length === 0) problems.push(`${g.case}: engineActual is empty`);
    for (const f of fields) {
      if (!(ORACLE_FIELDS as readonly string[]).includes(f)) problems.push(`${g.case}: unknown field ${f}`);
      else if (c && c.expected[f as OracleField] === undefined) problems.push(`${g.case}: ${f} is not an asserted field`);
      if (typeof g.engineActual[f as OracleField] !== 'number') problems.push(`${g.case}: engineActual.${f} must be a number`);
    }
    if (!g.reason || g.reason.length < 20) problems.push(`${g.case}: reason missing`);
    if (!g.closedBy || g.closedBy.length < 5) problems.push(`${g.case}: closedBy missing`);
  }
  for (const c of cases) {
    if (c.source === 'UNVERIFIED' && !seen.has(c.id)) problems.push(`${c.id}: source UNVERIFIED is allowed only on a known gap`);
  }
  return problems;
}

/** A fixture's status label as the engine's tax status: only the two it treats differently; every Sage label is an employee. */
export function oracleTaxStatus(label: string): TaxStatus {
  return label === 'independent_contractor' || label === 'director' ? label : 'employee';
}

const numberOf = (v: unknown): number | null => (typeof v === 'number' ? v : null);

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
  const components = withFringeBenefits(base, input.unmodelled, input.period);
  return {
    employee, components, period: input.period, taxYear: input.taxYear,
    annualPayrollEstimate: input.employerAnnualRemuneration,
  };
}

export function runCase(c: OracleCase): Record<OracleField, number> {
  const r = calculatePayrollLine(buildCaseInput(c));
  return {
    paye: r.paye.monthlyPaye,
    uifEmployee: r.uif.employeeContribution,
    uifEmployer: r.uif.employerContribution,
    sdl: r.sdl,
    eti: r.eti.monthlyEti,
    net: r.netPay,
  };
}

const cents = (n: number) => Math.round(n * 100);

/** The fields of a case that miss its expected figure by more than the documented tolerance. */
export function failingFields(c: OracleCase, actual: Record<OracleField, number>): OracleField[] {
  return ORACLE_FIELDS.filter(f => {
    const want = c.expected[f];
    if (want === undefined) return false;
    return Math.abs(cents(actual[f]) - cents(want)) > (c.tolerance?.[f]?.cents ?? 0);
  });
}

/**
 * Everything wrong with one case against the gap list, as messages (empty = as expected):
 * a non-gap case must pass every asserted field; a gap case must miss exactly its listed
 * fields, each at exactly its pinned engineActual, and pass the rest.
 */
export function caseProblems(c: OracleCase, gap: KnownGap | undefined): string[] {
  let actual: Record<OracleField, number>;
  try {
    actual = runCase(c);
  } catch (err) {
    return [`${c.id}: the engine threw: ${err instanceof Error ? err.message : String(err)}`];
  }
  const failing = failingFields(c, actual);
  const listed = Object.keys(gap?.engineActual ?? {}) as OracleField[];
  const out: string[] = [];
  for (const f of failing.filter(x => !listed.includes(x))) {
    out.push(`${c.id}.${f}: engine ${actual[f]}, ${c.source} ${c.expected[f]} (a new miss: fix the engine or the fixture)`);
  }
  for (const f of listed.filter(x => !failing.includes(x))) {
    out.push(`${c.id}.${f}: listed on knownGaps but now matches its source (${actual[f]}): remove it from knownGaps.json`);
  }
  for (const f of listed.filter(x => failing.includes(x))) {
    if (cents(actual[f]) !== cents(gap!.engineActual[f]!)) {
      out.push(`${c.id}.${f}: engine moved inside a known gap: ${actual[f]}, pinned engineActual ${gap!.engineActual[f]}`);
    }
  }
  for (const f of ORACLE_FIELDS) {
    const t = c.tolerance?.[f];
    if (t && cents(actual[f]) !== cents(t.engineActual)) {
      out.push(`${c.id}.${f}: engine moved inside its tolerance: ${actual[f]}, pinned engineActual ${t.engineActual}`);
    }
  }
  return out;
}
