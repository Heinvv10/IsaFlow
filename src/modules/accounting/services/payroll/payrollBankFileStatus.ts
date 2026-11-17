/**
 * Salary bank files (wave 6 BF): what a run's files say, the refusal every bank-file write raises, and the warning a
 * reopen gives (spec 0a.17, grill F18). Read-only.
 *
 * A file pays ONE approval of its run: it records the header's COALESCE(approved_at, approval_grandfathered_at) when
 * generated (run_approved_at). A reopen clears that time, so a file is `stale` once its run is no longer final at
 * that same approval. Judged from the header, never from a write at reopen, so a reopen by an older release (which
 * knows nothing of bank files) still leaves the file stale.
 *
 * Confirm records only that the bank accepted the file ("payment confirmed"); nothing here or in the writers sets
 * the run `paid`, so the run stays reopenable. Reopening a run whose file is confirmed is allowed, with the
 * BANK_FILE_CONFIRMED warning: the bank has paid, and any correction must be paid separately.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { hasFeature } from '@/modules/admin/services/featureFlagService';

/** The platform switch (spec rule 20): generation is refused while it is off for the company. */
export const SALARY_BANK_FILE_FLAG = 'payroll_salary_bank_file';

export type BankFileRefusalReason =
  | 'FEATURE_DISABLED' | 'NOT_FOUND' | 'NOT_FINAL' | 'BANK_HAS_PAID' | 'FILE_EXISTS' | 'INVALID_ACTION_DATE'
  | 'NO_PAYING_ACCOUNT' | 'EMPLOYEES_NOT_PAYABLE' | 'NOT_GENERATED' | 'UNSETTLED_FILE' | 'BANK_DETAILS_CHANGED'
  | 'RUN_CHANGED_SINCE_APPROVAL' | 'NOT_SENT_REQUIRED' | 'JOURNAL_NOT_POSTED';

const STATUS: Record<BankFileRefusalReason, 400 | 403 | 404 | 409> = {
  FEATURE_DISABLED: 403, NOT_FOUND: 404, INVALID_ACTION_DATE: 400, NOT_FINAL: 409, BANK_HAS_PAID: 409, FILE_EXISTS: 409,
  NO_PAYING_ACCOUNT: 409, EMPLOYEES_NOT_PAYABLE: 409, NOT_GENERATED: 409, UNSETTLED_FILE: 409,
  BANK_DETAILS_CHANGED: 409, RUN_CHANGED_SINCE_APPROVAL: 409, NOT_SENT_REQUIRED: 400, JOURNAL_NOT_POSTED: 409,
};

/** Raised before any write of the request; the route answers it with `status` and `reason`. */
export class PayrollBankFileRefusal extends Error {
  readonly code = 'PAYROLL_BANK_FILE_REFUSED';
  readonly status: 400 | 403 | 404 | 409;
  constructor(
    readonly reason: BankFileRefusalReason, message: string, readonly problems: string[] = [],
    /** UNSETTLED_FILE: the earlier file a person must settle first. */
    readonly file?: { id: string; sha256: string; totalCents: number; actionDate: string },
  ) {
    super(message);
    this.name = 'PayrollBankFileRefusal';
    this.status = STATUS[reason];
  }
}

export type BankFileStatus = 'generated' | 'confirmed' | 'voided';

export interface PayrollBankFile {
  id: string;
  status: BankFileStatus;
  layout: string;
  sha256: string;
  lineCount: number;
  totalCents: number;
  actionDate: string;
  createdAt: string;
  confirmedAt: string | null;
  voidedAt: string | null;
  /** The run was reopened since this file was made: it pays an approval that has ended. */
  stale: boolean;
  /**
   * A confirmed file of an earlier approval while the run is approved again (review #1524 D-3): the run's current net
   * less what the bank paid, in cents. Positive = still to pay separately; negative = overpaid. Null otherwise.
   */
  differenceCents: number | null;
}

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/** Every file of the run, newest first; [] for a run not in this company. */
export async function listRunBankFiles(companyId: string, runId: string): Promise<PayrollBankFile[]> {
  const rows = (await sql`
    SELECT f.id, f.status, f.layout, f.sha256, f.line_count, f.total_cents::text AS total_cents, f.action_date::text AS action_date,
           f.created_at, f.confirmed_at, f.voided_at,
           NOT COALESCE(h.status IN ('approved', 'paid') AND f.run_approved_at = COALESCE(h.approved_at, h.approval_grandfathered_at), false) AS stale,
           CASE WHEN f.status = 'confirmed' AND h.status IN ('approved', 'paid')
                 AND f.run_approved_at IS DISTINCT FROM COALESCE(h.approved_at, h.approval_grandfathered_at)
                THEN (round(h.total_net * 100)::bigint - f.total_cents)::text END AS difference_cents
      FROM payroll_bank_files f
      JOIN payroll_run_headers h ON h.id = f.run_id AND h.company_id = f.company_id
     WHERE f.company_id = ${companyId}::uuid AND f.run_id = ${runId}::uuid
     ORDER BY f.created_at DESC, f.id
  `) as DbRow[];
  return rows.map((r) => ({
    id: String(r.id), status: r.status as BankFileStatus, layout: String(r.layout), sha256: String(r.sha256),
    lineCount: Number(r.line_count), totalCents: Number(r.total_cents), actionDate: String(r.action_date),
    createdAt: iso(r.created_at)!, confirmedAt: iso(r.confirmed_at), voidedAt: iso(r.voided_at), stale: r.stale === true,
    differenceCents: r.difference_cents == null ? null : Number(r.difference_cents),
  }));
}

export interface RunBankFileState {
  /** Whether this company may generate (the platform switch). */
  enabled: boolean;
  files: PayrollBankFile[];
  /** A file of this run was confirmed: the bank has paid it. */
  paymentConfirmed: boolean;
}

/** GET bank-file: the switch and the run's files. */
export async function readRunBankFileState(companyId: string, runId: string): Promise<RunBankFileState> {
  const [enabled, files] = await Promise.all([hasFeature(companyId, SALARY_BANK_FILE_FLAG), listRunBankFiles(companyId, runId)]);
  return { enabled, files, paymentConfirmed: files.some((f) => f.status === 'confirmed') };
}

export interface ReopenWarning {
  code: 'BANK_FILE_CONFIRMED' | 'BANK_FILE_GENERATED';
  message: string;
}

/** The warnings a reopen of this run returns (called once, from payrollRunReopen). */
export async function bankFileReopenWarnings(companyId: string, runId: string): Promise<{ warnings: ReopenWarning[] }> {
  const files = await listRunBankFiles(companyId, runId);
  const warnings: ReopenWarning[] = [];
  if (files.some((f) => f.status === 'confirmed')) {
    warnings.push({
      code: 'BANK_FILE_CONFIRMED',
      message: 'The bank has paid this run: its salary bank file was confirmed. Reopening does not reverse that payment; '
        + 'pay any difference separately. No new bank file can be made for this run.',
    });
  }
  if (files.some((f) => f.status === 'generated')) {
    warnings.push({
      code: 'BANK_FILE_GENERATED',
      message: 'A salary bank file was generated for this run before it was reopened. If it was uploaded and the bank paid it, '
        + 'record that the bank accepted it; if it was never sent, void it saying so. No new file can be made until then.',
    });
  }
  return { warnings };
}
