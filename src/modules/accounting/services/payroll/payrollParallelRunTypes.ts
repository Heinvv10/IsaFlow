/**
 * Parallel-run comparison types (Dotbiz Workstream C).
 *
 * IsaFlow payroll run vs an imported external (Sage/VIP) payslip dataset for
 * the same period. ALL amounts are integer CENTS so "match to the cent" is
 * exact integer equality — no float drift anywhere in the engine.
 */

export type ComparisonComponentKey =
  | 'gross'
  | 'paye'
  | 'uifEmployee'
  | 'uifEmployer'
  | 'uifTotal'
  | 'sdl'
  | 'eti'
  | 'net';

export const COMPONENT_LABELS: Record<ComparisonComponentKey, string> = {
  gross: 'Gross',
  paye: 'PAYE',
  uifEmployee: 'UIF (Employee)',
  uifEmployer: 'UIF (Employer)',
  uifTotal: 'UIF (Total)',
  sdl: 'SDL',
  eti: 'ETI',
  net: 'Net Pay',
};

/** One row parsed from the external CSV. Absent columns stay undefined. */
export interface ExternalPayslipRow {
  employeeNumber: string;
  employeeName: string | null;
  amounts: Partial<Record<ComparisonComponentKey, number>>;
}

export interface CsvParseError {
  /** 1-based line number in the source file; 0 for file-level errors. */
  line: number;
  message: string;
}

export interface ExternalCsvParseResult {
  rows: ExternalPayslipRow[];
  errors: CsvParseError[];
  componentsPresent: ComparisonComponentKey[];
}

/** An IsaFlow payroll run line reduced to the comparable components, in cents. */
export interface IsaflowRunLineInput {
  employeeNumber: string;
  employeeName: string;
  gross: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
  net: number;
}

export type EmployeeComparisonStatus =
  | 'match'
  | 'variance'
  | 'missing_in_isaflow'
  | 'missing_in_external';

export interface ComponentComparison {
  component: ComparisonComponentKey;
  isaflowCents: number | null;
  externalCents: number | null;
  /** isaflow − external; null when either side is missing. */
  diffCents: number | null;
}

export interface EmployeeComparison {
  employeeNumber: string;
  employeeName: string;
  status: EmployeeComparisonStatus;
  components: ComponentComparison[];
  maxAbsDiffCents: number;
}

export interface ComparisonSummary {
  employeesIsaflow: number;
  employeesExternal: number;
  /** Employees present on both sides. */
  matchedBothSides: number;
  matchToTheCent: number;
  withVariance: number;
  missingInIsaflow: number;
  missingInExternal: number;
  /** matchToTheCent / matchedBothSides; null when nothing overlaps. */
  matchRate: number | null;
  /** Grand totals per compared component over each FULL side. */
  componentTotals: ComponentComparison[];
}

export interface ParallelRunComparisonReport {
  componentsCompared: ComparisonComponentKey[];
  toleranceCents: number;
  summary: ComparisonSummary;
  employees: EmployeeComparison[];
}
