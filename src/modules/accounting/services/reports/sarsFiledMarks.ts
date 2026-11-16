/**
 * "Marked filed" on the SARS page: a user records that a calendar item (VAT201, EMP201, EMP501,
 * IRP6) was filed, or undoes it. One sars_compliance_events row per (company, event type, period
 * end) (migration 999c); the trigger stamps who and when. A mark is the user's word, not a check
 * against SARS: it never touches sars_submissions or return versions.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import type { DbRow } from '@/types/db';
import { logAuditOrThrow } from '../core/auditTrailService';
import { calendarWindow, companyVatCycle } from './sarsComplianceCalendarDb';
import type { ComplianceEvent } from './sarsTaxPeriodsService';

export const MARKABLE_EVENT_TYPES = ['VAT201_DUE', 'EMP201_DUE', 'EMP501_DUE', 'PROVISIONAL_TAX'] as const;
export type MarkableEventType = (typeof MARKABLE_EVENT_TYPES)[number];

export interface FiledMarkInput {
  eventType: MarkableEventType;
  periodEnd: string;
  sarsReference?: string | null;
}

/** No calendar item of this company has that type and period end. The route answers 404. */
export class CalendarItemNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'CalendarItemNotFoundError'; }
}
/** The period is already marked filed. The route answers 409. */
export class AlreadyMarkedFiledError extends Error {
  constructor(message: string) { super(message); this.name = 'AlreadyMarkedFiledError'; }
}
/** The period is not marked filed (nothing to undo). The route answers 404. */
export class NotMarkedFiledError extends Error {
  constructor(message: string) { super(message); this.name = 'NotMarkedFiledError'; }
}

/**
 * The company's calendar item of that type and period end, under its current VAT cycle. Only
 * period ends from the year before to the year after this one (the page's window) are accepted. An
 * item whose period ends in year y is due by 31 Mar y+1 (Dec periods are due in Jan/Feb), so the
 * window for y holds it.
 */
async function findItem(companyId: string, eventType: string, periodEnd: string): Promise<ComplianceEvent> {
  const y = Number(periodEnd.slice(0, 4));
  const thisYear = new Date().getFullYear();
  const item = Math.abs(y - thisYear) > 1 ? undefined
    : calendarWindow(y, await companyVatCycle(companyId)).find((e) => e.eventType === eventType && e.periodEnd === periodEnd);
  if (!item) throw new CalendarItemNotFoundError(`No ${eventType} item with period end ${periodEnd}`);
  return item;
}

export interface FiledMark { id: string; filedAt: string; sarsReference: string | null }

export async function markFiled(companyId: string, userId: string, input: FiledMarkInput): Promise<FiledMark> {
  await assertNotImpersonating();
  const item = await findItem(companyId, input.eventType, input.periodEnd);
  const reference = input.sarsReference?.trim() || null;

  let rows: DbRow[];
  try {
    rows = await withSavepoint('sars_mark_filed', async () => (await sql`
      INSERT INTO sars_compliance_events (company_id, event_type, due_date, period_start, period_end, description, status, sars_reference)
      VALUES (${companyId}::UUID, ${item.eventType}, ${item.dueDate}::DATE, ${item.periodStart}::DATE, ${item.periodEnd}::DATE,
              ${item.description}, 'completed', ${reference})
      RETURNING id, filed_at, sars_reference
    `) as DbRow[]);
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === 'uq_sars_compliance_events_period') {
      throw new AlreadyMarkedFiledError(`${item.description} is already marked filed`);
    }
    throw err;
  }
  const row = rows[0]!;
  const id = String(row.id);
  await logAuditOrThrow({
    companyId, userId, action: 'create', entityType: 'sars_compliance_event', entityId: id, entityRef: item.description,
    changes: {
      fields: [{ field: 'status', label: 'SARS return', old: 'Not marked', new: 'Marked filed' }],
      metadata: { area: 'sars_filed', eventType: item.eventType, periodStart: item.periodStart, periodEnd: item.periodEnd, dueDate: item.dueDate, sarsReference: reference ?? '' },
    },
  });
  const filedAt = row.filed_at instanceof Date ? row.filed_at.toISOString() : String(row.filed_at);
  return { id, filedAt, sarsReference: reference };
}

/**
 * Undo the item's mark: the row keyed on its period, and a pre-999c row (no period) on its due date,
 * which the overlay shows as the same mark. One audit row per row removed.
 */
export async function unmarkFiled(companyId: string, userId: string, input: { eventType: MarkableEventType; periodEnd: string }): Promise<void> {
  await assertNotImpersonating();
  const item = await findItem(companyId, input.eventType, input.periodEnd);
  const rows = (await sql`
    DELETE FROM sars_compliance_events
    WHERE company_id = ${companyId}::UUID AND event_type = ${item.eventType}
      AND ((period_start = ${item.periodStart}::DATE AND period_end = ${item.periodEnd}::DATE)
        OR (period_end IS NULL AND due_date = ${item.dueDate}::DATE))
    RETURNING id, description, due_date::TEXT AS due_date, sars_reference
  `) as DbRow[];
  if (rows.length === 0) throw new NotMarkedFiledError(`${item.description} is not marked filed`);
  for (const row of rows) {
    await logAuditOrThrow({
      companyId, userId, action: 'delete', entityType: 'sars_compliance_event', entityId: String(row.id), entityRef: String(row.description),
      changes: {
        fields: [{ field: 'status', label: 'SARS return', old: 'Marked filed', new: 'Not marked' }],
        metadata: { area: 'sars_filed', eventType: item.eventType, periodStart: item.periodStart, periodEnd: item.periodEnd, dueDate: String(row.due_date), sarsReference: row.sars_reference ? String(row.sars_reference) : '' },
      },
    });
  }
}
