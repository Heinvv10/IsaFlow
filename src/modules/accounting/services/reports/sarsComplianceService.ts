/**
 * SARS Compliance Service
 * Submissions CRUD and DB-backed compliance calendar for SA tax obligations.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { getComplianceCalendar } from './sarsTaxPeriodsService';


export type { TaxPeriod, ComplianceEvent } from './sarsTaxPeriodsService';
export { getTaxPeriods, getComplianceCalendar } from './sarsTaxPeriodsService';

import type { ComplianceEvent } from './sarsTaxPeriodsService';
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
    submittedAt: row.submitted_at ? String(row.submitted_at) : null,
    submittedBy: row.submitted_by ? String(row.submitted_by) : null,
    notes: row.notes ? String(row.notes) : null,
    createdAt: fmtDate(row.created_at) || String(row.created_at),
    updatedAt: fmtDate(row.updated_at) || String(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Submissions CRUD
// ---------------------------------------------------------------------------

/** A submission that may not be marked submitted this way. The route answers 409. */
export class SubmissionNotOpenError extends Error {
  readonly code = 'SUBMISSION_NOT_OPEN';
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionNotOpenError';
  }
}

/**
 * Saves the company's open draft for the period: updates it when one exists (keepExistingAs stores its previous
 * form_data under that key of the new one, so nothing the page saved is lost), inserts it otherwise. One open draft per company, form and period, held by an advisory lock on that key
 * and a row lock on the draft, not by an index (migration 971 explains why): concurrent saves queue, the second
 * sees the first's draft. A period already filed is not refused; a correction is a new submission.
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

  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sars-draft:${companyId}:${formType}:${periodStart}:${periodEnd}`}, 0))`;
  const open = (await sql`
    SELECT * FROM sars_submissions
    WHERE company_id = ${companyId}::UUID AND form_type = ${formType}
      AND period_start = ${periodStart}::DATE AND period_end = ${periodEnd}::DATE AND status = 'draft'
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    LIMIT 1
    FOR UPDATE
  `) as DbRow[];
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
      RETURNING *`) as DbRow[];

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
        updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'
    RETURNING *
  `) as DbRow[];

  if (rows.length === 0) throw new SubmissionNotOpenError(`Submission ${id} is no longer an open draft.`);
  return mapSubmissionRow(rows[0]!);
}

// ---------------------------------------------------------------------------
// DB-merged Compliance Calendar
// ---------------------------------------------------------------------------

/**
 * Load compliance events from the database (if any exist), merged with
 * the static calendar. DB events can override status (e.g. marked completed).
 */
export async function getComplianceCalendarWithDB(companyId: string, year?: number): Promise<ComplianceEvent[]> {
  const staticEvents = getComplianceCalendar(year);

  try {
    const y = year || new Date().getFullYear();
    const dbEvents = (await sql`
      SELECT
        ce.id, ce.event_type, ce.due_date, ce.description,
        ce.status, ce.submission_id
      FROM sars_compliance_events ce
      WHERE ce.company_id = ${companyId}::UUID
        AND (EXTRACT(YEAR FROM ce.due_date) = ${y}
         OR EXTRACT(YEAR FROM ce.due_date) = ${y + 1})
      ORDER BY ce.due_date
    `) as DbRow[];

    const dbMap = new Map<string, DbRow>();
    for (const dbe of dbEvents) {
      const key = `${dbe.event_type}_${String(dbe.due_date).slice(0, 10)}`;
      dbMap.set(key, dbe);
    }

    return staticEvents.map((se) => {
      const key = `${se.eventType}_${se.dueDate}`;
      const dbMatch = dbMap.get(key);
      if (dbMatch) {
        return {
          ...se,
          id: String(dbMatch.id),
          status: dbMatch.status as ComplianceEvent['status'],
          submissionId: dbMatch.submission_id ? String(dbMatch.submission_id) : undefined,
        };
      }
      return se;
    });
  } catch (err) {
    log.warn('Could not load compliance events from DB, using static calendar', { error: err }, 'sarsComplianceService');
    return staticEvents;
  }
}
