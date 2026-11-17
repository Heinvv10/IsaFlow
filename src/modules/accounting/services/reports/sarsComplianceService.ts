/**
 * SARS Compliance Service
 * Submissions CRUD and DB-backed compliance calendar for SA tax obligations.
 */

import { toIsoTimestamp } from '@/lib/dateUtils';
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';


export type { TaxPeriod, ComplianceEvent } from './sarsTaxPeriodsService';
export { getTaxPeriods, getComplianceCalendar } from './sarsTaxPeriodsService';

import type { DbRow } from '@/types/db';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { periodHasReturnVersion } from '@/modules/accounting/services/returns/versionExists';

export interface SARSSubmission {
  id: string;
  formType: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  formData: Record<string, unknown>;
  submissionReference: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  /** 'isv' when IsaFlow sent it to SARS; null when a user recorded the filing (sarsFilingKind). */
  efilingChannel: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapSubmissionRow(row: DbRow): SARSSubmission {
  return {
    id: String(row.id),
    formType: String(row.form_type),
    periodStart: fmtDate(row.period_start),
    periodEnd: fmtDate(row.period_end),
    status: String(row.status),
    formData: (row.form_data as Record<string, unknown>) ?? {},
    submissionReference: row.submission_reference ? String(row.submission_reference) : null,
    submittedAt: row.submitted_at ? toIsoTimestamp(row.submitted_at as Date | string) : null,
    submittedBy: row.submitted_by ? String(row.submitted_by) : null,
    efilingChannel: row.efiling_channel ? String(row.efiling_channel) : null,
    notes: row.notes ? String(row.notes) : null,
    // Timestamps with their time (the detail modal shows it); fmtDate kept only the day ("00:00").
    createdAt: toIsoTimestamp(row.created_at as Date | string) ?? '',
    updatedAt: toIsoTimestamp(row.updated_at as Date | string) ?? '',
  };
}

// ---------------------------------------------------------------------------
// Submissions CRUD
// ---------------------------------------------------------------------------

/** A submission that may not be marked submitted this way. The route answers 409. */
export class SubmissionNotOpenError extends Error {
  // No `readonly code`: no MCP tool reaches markSubmitted, so there is no agent-facing refusal to allowlist.
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionNotOpenError';
  }
}

/**
 * The (company, form, period) draft key, held until the transaction ends. saveDraftSubmission takes it, and so does
 * the ISV path before anything goes to SARS: a filing, a draft save and an ISV submit of one period queue. The key is
 * built from the values as the database reads them (uuid and dates in canonical text), so '2026-1-1' and '2026-01-01'
 * queue on one key, as they name one row; for canonical input it is the string the earlier colour built.
 */
export async function takeDraftPeriodLock(companyId: string, formType: string, periodStart: string, periodEnd: string): Promise<void> {
  if (!als.getStore()?.client) throw new Error('The draft period lock must be taken inside a request transaction');
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('sars-draft:' || ${companyId}::UUID::TEXT || ':' || ${formType}::TEXT
    || ':' || ${periodStart}::DATE::TEXT || ':' || ${periodEnd}::DATE::TEXT, 0))`;
}

/** The partial unique index of one open draft per company, form and period (migration 999b). */
const ONE_OPEN_DRAFT_INDEX = 'uq_sars_submissions_one_open_draft';

/**
 * Saves the company's open draft for the period: updates it when one exists (keepExistingAs stores its previous
 * form_data under that key of the new one, so nothing the page saved is lost), inserts it otherwise. One open draft per company, form and period, held by an advisory lock on that key
 * and a row lock on the draft, and by the partial unique index of migration 999b: concurrent saves queue, the second
 * sees the first's draft. A second open draft some other writer slipped in is refused by the index: 409
 * (SubmissionNotOpenError), never a 500. A period already filed is not refused; a correction is a new submission.
 */
export async function saveDraftSubmission(
  companyId: string,
  formType: string,
  periodStart: string,
  periodEnd: string,
  formData: Record<string, unknown>,
  userId: string,
  opts: { keepExistingAs?: string } = {},
): Promise<SARSSubmission> {
  log.info('Saving draft submission', { formType, periodStart, periodEnd }, 'sarsComplianceService');

  await takeDraftPeriodLock(companyId, formType, periodStart, periodEnd);
  const open = (await sql`
    SELECT * FROM sars_submissions
    WHERE company_id = ${companyId}::UUID AND form_type = ${formType}
      AND period_start = ${periodStart}::DATE AND period_end = ${periodEnd}::DATE AND status = 'draft'
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    LIMIT 1
    FOR UPDATE
  `) as DbRow[];
  // The figures SARS received are never overwritten: a draft that holds a correlation id has a send in flight.
  if (open[0]?.efiling_correlation_id != null) {
    throw new SubmissionNotOpenError('A send to SARS is in flight for this draft; poll it first.');
  }
  const rows = (open[0]
    ? await sql`
      UPDATE sars_submissions
      SET form_data = ${JSON.stringify(formData)}::jsonb
            || CASE WHEN ${opts.keepExistingAs ?? null}::TEXT IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object(${opts.keepExistingAs ?? ''}::TEXT, form_data) END,
          submitted_by = ${userId}, updated_at = NOW()
      WHERE id = ${String(open[0].id)}::UUID AND company_id = ${companyId}::UUID
      RETURNING *`
    : await sql`
      INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, form_data, submitted_by)
      VALUES (${companyId}::UUID, ${formType}, ${periodStart}, ${periodEnd}, 'draft', ${JSON.stringify(formData)}::jsonb, ${userId})
      RETURNING *`.catch((err: unknown) => {
        const pg = err as { code?: string; constraint?: string };
        if (pg.code === '23505' && pg.constraint === ONE_OPEN_DRAFT_INDEX) {
          throw new SubmissionNotOpenError('Another open draft of this period was saved at the same time. Reload and save again.');
        }
        throw err;
      })) as DbRow[];

  return mapSubmissionRow(rows[0]!);
}

export async function listSubmissions(companyId: string,
  formType?: string
): Promise<SARSSubmission[]> {
  let rows: DbRow[];
  if (formType) {
    rows = (await sql`
      SELECT * FROM sars_submissions
      WHERE company_id = ${companyId}::UUID AND form_type = ${formType}
      ORDER BY created_at DESC
      LIMIT 500
    `) as DbRow[];
  } else {
    rows = (await sql`
      SELECT * FROM sars_submissions
      WHERE company_id = ${companyId}::UUID
      ORDER BY created_at DESC
      LIMIT 500
    `) as DbRow[];
  }
  return rows.map(mapSubmissionRow);
}

export async function getSubmission(companyId: string, id: string): Promise<SARSSubmission | null> {
  const rows = (await sql`
    SELECT * FROM sars_submissions WHERE id = ${id} AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (rows.length === 0) return null;
  return mapSubmissionRow(rows[0]!);
}

/**
 * Marks an OPEN draft submitted (the legacy manual path). Refused (409) for a submission that is not a draft, for one a
 * return version names (re-filing a filed return), and, unless `lifecycle` (markReturnFiled, which is then the
 * caller), for a period that has a return version (any status): that is filed through the lifecycle, with its drift check.
 */
export async function markSubmitted(companyId: string,
  id: string,
  reference: string,
  actorUserId: string,
  opts: { lifecycle?: boolean } = {},
): Promise<SARSSubmission> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  log.info('Marking submission as submitted', { id, reference }, 'sarsComplianceService');

  const current = (await sql`
    SELECT * FROM sars_submissions WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID FOR UPDATE
  `) as DbRow[];
  if (current.length === 0) throw new Error(`Submission ${id} not found`);
  const row = current[0]!;
  if (String(row.status) !== 'draft') {
    throw new SubmissionNotOpenError(`Submission ${id} is ${String(row.status)}, not an open draft.`);
  }
  const named = (await sql`
    SELECT 1 FROM tax_return_versions WHERE company_id = ${companyId}::UUID AND sars_submission_id = ${id}::UUID LIMIT 1
  `) as DbRow[];
  if (named.length > 0) throw new SubmissionNotOpenError('This submission belongs to a return version: file through the return lifecycle.');
  if (!opts.lifecycle && await periodHasReturnVersion(companyId, String(row.form_type), fmtDate(row.period_start), fmtDate(row.period_end))) {
    // Any status: between an amend and the next finalise nothing is live, and the period is still the lifecycle's.
    throw new SubmissionNotOpenError('This period has a return version: file through the return lifecycle.');
  }

  const rows = (await sql`
    UPDATE sars_submissions
    SET status = 'submitted',
        submission_reference = ${reference},
        submitted_at = NOW(),
        -- Who recorded the filing (the calendar names them), not whoever last saved the draft.
        submitted_by = ${actorUserId},
        updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'
    RETURNING *
  `) as DbRow[];

  if (rows.length === 0) throw new SubmissionNotOpenError(`Submission ${id} is no longer an open draft.`);
  return mapSubmissionRow(rows[0]!);
}

export { getComplianceCalendarWithDB } from './sarsComplianceCalendarDb';
