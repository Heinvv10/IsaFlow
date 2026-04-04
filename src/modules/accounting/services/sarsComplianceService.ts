/**
 * SARS Compliance Service
 * Submissions CRUD and DB-backed compliance calendar for SA tax obligations.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getComplianceCalendar } from './sarsTaxPeriodsService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export type { TaxPeriod, ComplianceEvent } from './sarsTaxPeriodsService';
export { getTaxPeriods, getComplianceCalendar } from './sarsTaxPeriodsService';

import type { ComplianceEvent } from './sarsTaxPeriodsService';

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

function mapSubmissionRow(row: Row): SARSSubmission {
  return {
    id: String(row.id),
    formType: String(row.form_type),
    periodStart: String(row.period_start).slice(0, 10),
    periodEnd: String(row.period_end).slice(0, 10),
    status: String(row.status),
    formData: row.form_data || {},
    submissionReference: row.submission_reference ? String(row.submission_reference) : null,
    submittedAt: row.submitted_at ? String(row.submitted_at) : null,
    submittedBy: row.submitted_by ? String(row.submitted_by) : null,
    notes: row.notes ? String(row.notes) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Submissions CRUD
// ---------------------------------------------------------------------------

export async function saveDraftSubmission(
  companyId: string,
  formType: string,
  periodStart: string,
  periodEnd: string,
  formData: Record<string, unknown>,
  userId: string
): Promise<SARSSubmission> {
  log.info('Saving draft submission', { formType, periodStart, periodEnd }, 'sarsComplianceService');

  const rows = (await sql`
    INSERT INTO sars_submissions (form_type, period_start, period_end, status, form_data, submitted_by)
    VALUES (${formType}, ${periodStart}, ${periodEnd}, 'draft', ${JSON.stringify(formData)}::jsonb, ${userId})
    RETURNING *
  `) as Row[];

  return mapSubmissionRow(rows[0]);
}

export async function listSubmissions(companyId: string,
  formType?: string
): Promise<SARSSubmission[]> {
  let rows: Row[];
  if (formType) {
    rows = (await sql`
      SELECT * FROM sars_submissions
      WHERE form_type = ${formType}
      ORDER BY created_at DESC
      LIMIT 500
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT * FROM sars_submissions
      ORDER BY created_at DESC
      LIMIT 500
    `) as Row[];
  }
  return rows.map(mapSubmissionRow);
}

export async function getSubmission(companyId: string, id: string): Promise<SARSSubmission | null> {
  const rows = (await sql`
    SELECT * FROM sars_submissions WHERE id = ${id}
  `) as Row[];
  if (rows.length === 0) return null;
  return mapSubmissionRow(rows[0]);
}

export async function markSubmitted(companyId: string,
  id: string,
  reference: string
): Promise<SARSSubmission> {
  log.info('Marking submission as submitted', { id, reference }, 'sarsComplianceService');

  const rows = (await sql`
    UPDATE sars_submissions
    SET status = 'submitted',
        submission_reference = ${reference},
        submitted_at = NOW(),
        updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `) as Row[];

  if (rows.length === 0) throw new Error(`Submission ${id} not found`);
  return mapSubmissionRow(rows[0]);
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
      WHERE EXTRACT(YEAR FROM ce.due_date) = ${y}
         OR EXTRACT(YEAR FROM ce.due_date) = ${y + 1}
      ORDER BY ce.due_date
    `) as Row[];

    const dbMap = new Map<string, Row>();
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
