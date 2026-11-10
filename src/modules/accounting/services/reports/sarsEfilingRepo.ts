/**
 * SARS eFiling persistence — sars_submissions eFiling columns + the append-only
 * sars_efiling_events audit log (migration 504). Every query is company_id
 * scoped (multi-tenant). No secrets are ever written to the audit log.
 */

import { getAuthPool } from '@/lib/auth/authPool';
import { connectObserved } from '@/lib/auth/poolTelemetry';
import { als } from '@/lib/als';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';

export interface EfilingSubmissionRow {
  id: string;
  companyId: string;
  formType: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  efilingCorrelationId: string | null;
  efilingLastStatus: string | null;
  /** The figures saved when the draft was reviewed. Null on a row saved before form_data existed. */
  formData: Record<string, unknown> | null;
}

export async function getEfilingSubmission(
  companyId: string,
  submissionId: string,
): Promise<EfilingSubmissionRow | null> {
  const rows = (await sql`
    SELECT id, company_id, form_type, period_start, period_end, status,
           efiling_correlation_id, efiling_last_status, form_data
    FROM sars_submissions
    WHERE id = ${submissionId} AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    formType: String(r.form_type),
    periodStart: fmtDate(r.period_start),
    periodEnd: fmtDate(r.period_end),
    status: String(r.status),
    efilingCorrelationId: r.efiling_correlation_id ? String(r.efiling_correlation_id) : null,
    efilingLastStatus: r.efiling_last_status ? String(r.efiling_last_status) : null,
    formData: (r.form_data as Record<string, unknown> | null) ?? null,
  };
}

export async function getCompanyVatInfo(
  companyId: string,
): Promise<{ vatNumber: string | null; companyName: string }> {
  const rows = (await sql`
    SELECT vat_number, name FROM companies WHERE id = ${companyId}::UUID
  `) as DbRow[];
  const r = rows[0];
  return {
    vatNumber: r?.vat_number ? String(r.vat_number) : null,
    companyName: r?.name ? String(r.name) : '',
  };
}

export async function markSubmissionSubmitted(
  companyId: string,
  submissionId: string,
  correlationId: string,
  efilingStatus: string,
  userId: string,
): Promise<void> {
  await sql`
    UPDATE sars_submissions
    SET status = 'submitted',
        efiling_channel = 'isv',
        efiling_correlation_id = ${correlationId},
        efiling_last_status = ${efilingStatus},
        submitted_at = NOW(),
        submitted_by = ${userId},
        updated_at = NOW()
    WHERE id = ${submissionId} AND company_id = ${companyId}::UUID
  `;
}

export async function applyPollResult(
  companyId: string,
  submissionId: string,
  opts: { submissionStatus: string; efilingStatus: string; sarsReference: string | null },
): Promise<void> {
  await sql`
    UPDATE sars_submissions
    SET status = ${opts.submissionStatus},
        efiling_last_status = ${opts.efilingStatus},
        submission_reference = COALESCE(${opts.sarsReference}, submission_reference),
        updated_at = NOW()
    WHERE id = ${submissionId} AND company_id = ${companyId}::UUID
  `;
}

export interface EfilingEventInput {
  companyId: string;
  submissionId: string;
  eventType: 'submit' | 'poll' | 'status_change' | 'blocked' | 'error';
  efilingStatus?: string | null;
  httpStatus?: number | null;
  correlationId?: string | null;
  detail?: Record<string, unknown>;
  message?: string | null;
  createdBy?: string | null;
}

export interface EventWriter {
  /** One event in a transaction of its own on the held connection, committed before this returns. */
  write(evt: EfilingEventInput): Promise<void>;
}

/**
 * Holds ONE ordinary app_user connection (the withAuth pool; never a migration credential) for a caller that must record
 * events that survive the request's own rollback: the record that a submit is about to leave for SARS, its result and
 * its failure. The connection is taken BEFORE the caller takes any lock, so a queue of submits waiting on the period's
 * advisory lock never needs a second pool connection while holding the first (it would starve the pool). Each `write`
 * runs BEGIN, the request's verified claims and company as the RLS GUCs exactly as withAuth sets them, the INSERT, COMMIT.
 */
export async function withEventWriter<T>(fn: (writer: EventWriter) => Promise<T>): Promise<T> {
  const store = als.getStore();
  const claims = store?.claims ?? {};
  const client = await connectObserved(getAuthPool(), 'isv-event-writer');
  let unusable = false; // R-176: a ROLLBACK that failed leaves the transaction open; destroy the connection, do not pool it
  const write = async (evt: EfilingEventInput): Promise<void> => {
    // The authenticated request's company, as withAuth sets it; the event's own is the fallback outside a request.
    const companyGuc = store?.companyId ?? evt.companyId;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyGuc]);
      await client.query(
        `INSERT INTO sars_efiling_events
           (company_id, submission_id, event_type, efiling_status, http_status, correlation_id, detail, message, created_by)
         VALUES ($1::UUID, $2::UUID, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
        [evt.companyId, evt.submissionId, evt.eventType, evt.efilingStatus ?? null, evt.httpStatus ?? null,
          evt.correlationId ?? null, JSON.stringify(evt.detail ?? {}), evt.message ?? null, evt.createdBy ?? null],
      );
      await client.query('COMMIT');
    } catch (err) {
      unusable = await rollbackFailed(client, 'isv-event-writer');
      throw err;
    }
  };
  try {
    return await fn({ write });
  } finally {
    client.release(unusable);
  }
}

/** One committed event on a connection of its own (for a caller that writes a single one, such as a poll's failure). */
export async function insertEfilingEventCommitted(evt: EfilingEventInput): Promise<void> {
  await withEventWriter((w) => w.write(evt));
}

export async function insertEfilingEvent(evt: EfilingEventInput): Promise<void> {
  await sql`
    INSERT INTO sars_efiling_events
      (company_id, submission_id, event_type, efiling_status, http_status, correlation_id, detail, message, created_by)
    VALUES (
      ${evt.companyId}::UUID, ${evt.submissionId}::UUID, ${evt.eventType},
      ${evt.efilingStatus ?? null}, ${evt.httpStatus ?? null}, ${evt.correlationId ?? null},
      ${JSON.stringify(evt.detail ?? {})}::jsonb, ${evt.message ?? null}, ${evt.createdBy ?? null}
    )
  `;
}
