/**
 * The payroll journal plan's types (moved out of payrollJournalBuilder.ts, unchanged, for the 300-line cap).
 * payrollJournalBuilder re-exports them, so every importer is as before.
 */
import type { LabourSourceBucket } from './payrollLabourComparison';

export interface PayrollJournalPlanLine {
  /** Null only when the account does not exist — the plan then carries a blocker. */
  glAccountId: string | null;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  description: string;
  /** True when the target account is deactivated. Reported, never filtered. */
  inactiveAccount: boolean;
  /** Labour lines: the employee's CC1 cost centre, posted to gl_journal_lines.cc1_id. Null on every other line. */
  cc1Id: string | null;
}

/** Machine-stable code plus prose. Blockers stop the post; advisories do not. */
export interface PayrollJournalNote {
  code: string;
  detail: string;
}

export interface PayrollJournalPlan {
  runId: string;
  status: string;
  periodMonth: number;
  periodYear: number;
  employeeCount: number;
  /** Lines with net above nil: everyone approval actually pays. */
  paidEmployeeCount: number;
  /** The run's lines, counted where paidEmployeeCount is (the header's employee_count can be stale). */
  lineCount: number;
  /** Set when the run has already posted — the poster returns this id unchanged. */
  alreadyPostedJournalId: string | null;
  /** YYYY-MM-DD, last day of the period month. */
  entryDate: string;
  description: string;
  reference: string;
  lines: PayrollJournalPlanLine[];
  totalDebit: number;
  totalCredit: number;
  /** The run header totals the plan was derived from, so a reader can check it. */
  totals: {
    /** The employer's non-cash 3810 medical contribution on the run: booked to labour and 2175, outside gross and net. */
    employerMedical: number;
    gross: number;
    paye: number;
    uif: number;
    sdl: number;
    eti: number;
    /** The ETI booked: max(0, min(eti, paye)). The rest is reported in `eti_beyond_paye`. */
    etiUsed: number;
    net: number;
    employerUif: number;
    otherDeductions: number;
  };
  blockers: PayrollJournalNote[];
  advisories: PayrollJournalNote[];
  /** INTERNAL to the approval gate (payrollLabourComparison): labour per source centre. Not posted, not hashed, not previewed. */
  labourBySourceCentre?: LabourSourceBucket[];
}
