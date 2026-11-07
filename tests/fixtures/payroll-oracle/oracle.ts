/**
 * Payroll oracle: loads the cases in this directory, costs each one with the pure
 * calculatePayrollLine, and compares to the cent (wave-4 spec §4 O).
 *
 * A case's `expected` comes from an outside source (`source`), never from the engine.
 * Inputs the engine has no field for (Sage tax status, a fixed-rate directive) are kept
 * in the fixture so the gap is visible; they are not passed to the engine.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { EmployeeComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

export const ORACLE_DIR = __dirname;

export const ORACLE_FIELDS = ['paye', 'uifEmployee', 'uifEmployer', 'sdl', 'eti', 'net'] as const;
export type OracleField = typeof ORACLE_FIELDS[number];

const SOURCE_PATTERN = /^(sage|simplepay|both|velocity-register-v2|UNVERIFIED|sars-guide:.+)$/;

export interface OracleComponent {
  code: string;
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
    /** Inputs the calculator cannot take today (recorded, not passed). */
    unmodelled?: Record<string, unknown>;
  };
  /** Only the fields the source gives are asserted. */
  expected: Partial<Record<OracleField, number>>;
  /** Documented rounding only: cents allowed per field, with the reason. */
  tolerance?: Partial<Record<OracleField, { cents: number; reason: string }>>;
}

export interface KnownGap {
  case: string;
  fields: OracleField[];
  reason: string;
  closedBy: string;
}

/** Keys that would carry personal data; no oracle fixture may hold one (corpus-ground-truth masking). */
export const FORBIDDEN_KEYS = ['firstName', 'lastName', 'name_full', 'idNumber', 'taxNumber', 'bankAccount', 'accountNumber', 'branchCode', 'email', 'phone'];

function parseDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad date ${s}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function collectKeys(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) v.forEach(x => collectKeys(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { out.add(k); collectKeys(x, out); }
  }
}

export function loadCases(): OracleCase[] {
  const files = readdirSync(ORACLE_DIR).filter(f => f.endsWith('.json') && f !== 'knownGaps.json').sort();
  return files.map(f => {
    const raw: unknown = JSON.parse(readFileSync(join(ORACLE_DIR, f), 'utf8'));
    const keys = new Set<string>();
    collectKeys(raw, keys);
    const leaked = FORBIDDEN_KEYS.filter(k => keys.has(k));
    if (leaked.length) throw new Error(`${f}: personal-data keys are not allowed in an oracle fixture: ${leaked.join(', ')}`);
    const c = raw as OracleCase;
    if (`${c.id}.json` !== f) throw new Error(`${f}: id "${c.id}" must match the file name`);
    if (!SOURCE_PATTERN.test(c.source)) throw new Error(`${f}: source "${c.source}" is not one of sage | simplepay | both | sars-guide:<ref> | velocity-register-v2 | UNVERIFIED`);
    if (!c.sourceRef || !c.notes) throw new Error(`${f}: sourceRef and notes are required`);
    if (Object.keys(c.expected).length === 0) throw new Error(`${f}: no expected figure`);
    for (const k of Object.keys(c.expected)) {
      if (!(ORACLE_FIELDS as readonly string[]).includes(k)) throw new Error(`${f}: unknown expected field ${k}`);
    }
    for (const [k, t] of Object.entries(c.tolerance ?? {})) {
      if (!t || !t.reason || !(t.cents > 0)) throw new Error(`${f}: tolerance on ${k} needs cents > 0 and a reason`);
    }
    return c;
  });
}

export function loadKnownGaps(): KnownGap[] {
  return JSON.parse(readFileSync(join(ORACLE_DIR, 'knownGaps.json'), 'utf8')) as KnownGap[];
}

export function runCase(c: OracleCase): Record<OracleField, number> {
  const { input } = c;
  const employee: PayrollEmployee = {
    id: c.id,
    companyId: 'oracle',
    employeeNumber: c.id,
    firstName: 'Oracle',
    lastName: 'Case',
    employmentType: 'permanent',
    startDate: parseDate(input.employee.startDate),
    ...(input.employee.dateOfBirth ? { dateOfBirth: parseDate(input.employee.dateOfBirth) } : {}),
    uifExcluded: input.employee.uifExcluded,
    medicalAidMainMember: input.employee.medicalAidMainMember,
    medicalAidDependantsCount: input.employee.medicalAidDependantsCount,
    s18aReceiptHeld: input.employee.s18aReceiptHeld,
  };
  const components: EmployeeComponent[] = input.components.map((x, i) => ({
    component: {
      id: `${c.id}-${i}`, name: x.name, sarsSourceCode: x.code, componentType: x.type,
      isTaxable: x.taxable, isUifApplicable: x.uif, isSdlApplicable: x.sdl,
    },
    amount: x.amount,
  }));
  const r = calculatePayrollLine({
    employee, components, period: input.period, taxYear: input.taxYear,
    annualPayrollEstimate: input.employerAnnualRemuneration,
  });
  return {
    paye: r.paye.monthlyPaye,
    uifEmployee: r.uif.employeeContribution,
    uifEmployer: r.uif.employerContribution,
    sdl: r.sdl,
    eti: r.eti.monthlyEti,
    net: r.netPay,
  };
}

/** The fields of a case that miss its expected figure by more than the documented tolerance. */
export function failingFields(c: OracleCase, actual: Record<OracleField, number>): OracleField[] {
  return ORACLE_FIELDS.filter(f => {
    const want = c.expected[f];
    if (want === undefined) return false;
    const diff = Math.abs(Math.round(actual[f] * 100) - Math.round(want * 100));
    return diff > (c.tolerance?.[f]?.cents ?? 0);
  });
}
