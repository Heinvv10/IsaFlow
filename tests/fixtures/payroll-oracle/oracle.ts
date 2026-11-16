/**
 * Payroll oracle: loads the cases in this directory, costs each one with the pure
 * calculatePayrollLine, and compares to the cent (wave-4 spec §4 O).
 *
 * A case's `expected` comes from an outside source (`source`), never from the engine.
 * The tax status and the work terms (`taxStatus`; `unmodelled.ordinaryHoursPerWeek`, `hoursPerDay`, `dayRate`) reach the
 * calculator (buildCaseInput, TS-b), and so does a regular-pay directive (`unmodelled.fixedRateDirectivePercent`,
 * `fixedAmountDirective`; DR). `monthlyHours` (ET) reaches it as an hourly employee whose Basic Salary (3601) row
 * records those hours, the way HD stores a run's hours; `ordinaryHoursWage` is what the engine derives from that row.
 * Inputs the engine still has no field for (fringe terms) stay in `unmodelled` so the gap is
 * visible; they are not passed to it (oracleInputs.test.ts names each one's owner).
 *
 * Wave 6 (O3): `input.period` may say its `frequency`, `periodStart`/`periodEnd` and `runKind`, and
 * `input.priorPeriods` lists the tax year's earlier periods with the figures their lines stored. The calculator
 * has no field for the first three yet (FQc, OC wire them; until then such a case runs as a monthly regular line
 * and sits on knownGaps.json). The priors reach it as the year to date (oracleInput.ts priorYearToDate).
 * An UNVERIFIED case is on knownGaps.json (the engine differs from the hand computation in its notes) or on
 * unverified.json (the engine equals it), never on both and never on neither.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { buildCaseInput } from './oracleInput';
import { ORACLE_FIELDS, validateCase, type FREQUENCIES, type OracleField, type PRIOR_FIGURES, type RUN_KINDS } from './validate';

export { ORACLE_FIELDS, type OracleField };
export { buildCaseInput, oracleTaxStatus, saIdFor } from './oracleInput';

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
    period: {
      year: number; month: number;
      frequency?: typeof FREQUENCIES[number]; periodStart?: string; periodEnd?: string; runKind?: typeof RUN_KINDS[number];
    };
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
    /** The tax year's earlier periods (wave-6 F1), oldest first; absent = this is the first. */
    priorPeriods?: OraclePriorPeriod[];
  };
  /** Only the fields the source gives are asserted. */
  expected: Partial<Record<OracleField, number>>;
  /**
   * Documented rounding only: at most MAX_TOLERANCE_CENTS per field, with the reason. `engineActual`
   * pins the engine's CURRENT figure exactly, so it cannot drift inside the tolerance unnoticed.
   */
  tolerance?: Partial<Record<OracleField, { cents: number; reason: string; engineActual: number }>>;
}

/** An earlier period: its inputs and the figures its line stored (validate.ts PRIOR_FIGURES). */
export type OraclePriorPeriod = {
  periodStart: string;
  frequency: typeof FREQUENCIES[number];
  runKind: typeof RUN_KINDS[number];
  components: OracleComponent[];
} & Record<typeof PRIOR_FIGURES[number], number>;

/** An UNVERIFIED case the engine matches: why no source is cited, and what would verify it (spec §1.6). */
export interface UnverifiedEntry {
  case: string;
  reason: string;
  wouldVerify: string;
}

/** The list files in this directory: never loaded as cases (F22). */
export const LIST_FILES = ['knownGaps.json', 'unverified.json'] as const;

/**
 * A case that misses its source today. `engineActual` is the engine's CURRENT figure for each
 * missed field, asserted exactly: the gap is a pinned amount, so drift inside it is red too.
 */
export interface KnownGap {
  case: string;
  engineActual: Partial<Record<OracleField, number>>;
  reason: string;
  closedBy: string;
  /** A vendor-parity gap that no wave-6 PR closes (its closedBy says when it would close); exempt from CLOSER. */
  parity?: true;
}

/** A gap's closer: the wave-6 PR that closes it, or a PR number. */
export const CLOSER = /^(UF|FQc|OC|PSP|DBF|RI|GA|#\d+)\b/;

export function loadCases(): OracleCase[] {
  const files = readdirSync(ORACLE_DIR).filter(f => f.endsWith('.json') && !(LIST_FILES as readonly string[]).includes(f)).sort();
  return files.map(f => {
    const raw: unknown = JSON.parse(readFileSync(join(ORACLE_DIR, f), 'utf8'));
    validateCase(raw, f);
    return raw as OracleCase;
  });
}

export function loadKnownGaps(): KnownGap[] {
  return JSON.parse(readFileSync(join(ORACLE_DIR, 'knownGaps.json'), 'utf8')) as KnownGap[];
}

export function loadUnverified(): UnverifiedEntry[] {
  return JSON.parse(readFileSync(join(ORACLE_DIR, 'unverified.json'), 'utf8')) as UnverifiedEntry[];
}

/**
 * Problems with the two lists: unknown cases, duplicates, empty entries, and an UNVERIFIED case on neither list or on
 * both. An unverified.json entry is not a gap, so caseProblems holds its engine figure to `expected` exactly.
 */
export function gapListProblems(cases: readonly OracleCase[], gaps: readonly KnownGap[], unverified: readonly UnverifiedEntry[] = []): string[] {
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
    else if (g.parity !== true && !CLOSER.test(g.closedBy)) problems.push(`${g.case}: closedBy must start with a closing PR (UF, FQc, OC, PSP, DBF, RI, GA or #n) or the gap be parity: true`);
  }
  const unverifiedIds = new Set<string>();
  for (const u of unverified) {
    const c = byId.get(u.case);
    if (!c) problems.push(`${u.case}: on unverified.json but has no fixture`);
    else if (c.source !== 'UNVERIFIED') problems.push(`${u.case}: on unverified.json but its source is ${c.source}`);
    if (unverifiedIds.has(u.case)) problems.push(`${u.case}: listed twice on unverified.json`);
    if (seen.has(u.case)) problems.push(`${u.case}: on both knownGaps.json and unverified.json`);
    unverifiedIds.add(u.case);
    if (!u.reason || u.reason.length < 20) problems.push(`${u.case}: unverified reason missing`);
    if (!u.wouldVerify || u.wouldVerify.length < 20) problems.push(`${u.case}: unverified wouldVerify missing`);
  }
  for (const c of cases) {
    if (c.source === 'UNVERIFIED' && !seen.has(c.id) && !unverifiedIds.has(c.id)) {
      problems.push(`${c.id}: source UNVERIFIED must be on knownGaps.json (engine differs) or unverified.json (engine matches)`);
    }
  }
  return problems;
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
