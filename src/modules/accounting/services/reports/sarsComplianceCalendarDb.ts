/**
 * The SARS page's compliance calendar: the static calendar for the company's VAT cycle, with
 * IsaFlow's own filings (sars_submissions) and the company's "marked filed" rows
 * (sars_compliance_events, migration 999c) laid over it.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { getComplianceCalendar, type ComplianceEvent } from './sarsTaxPeriodsService';
import { readCompanyVatRow, vatCycleOfRow, type VatCycle } from './companyVatCycle';
import { legacyDueDates } from './legacyMarkDueDates';
import { coveringSubmissions, filingLines, readFiledSubmissions, weakestKind } from './sarsSubmissionCoverage';

/**
 * Events due from 1 Jan `y` to 31 Mar `y + 1`: the year plus the SARS page's
 * 90-day look-ahead past it, so a return due across the year boundary (Cat A
 * Dec–Jan, Cat B / monthly December) is never missed. Built from the
 * calendars of y-1, y and y+1, de-duplicated by event type + due date.
 */
export function calendarWindow(y: number, cycle: VatCycle | null): ComplianceEvent[] {
  const from = `${y}-01-01`;
  const to = `${y + 1}-03-31`;
  const byKey = new Map<string, ComplianceEvent>();
  for (const cy of [y - 1, y, y + 1]) {
    const events = cycle ? getComplianceCalendar(cy, cycle.alignment, cycle.cadence) : getComplianceCalendar(cy, 'odd', 'none');
    for (const e of events) {
      if (e.dueDate >= from && e.dueDate <= to) byKey.set(`${e.eventType}_${e.dueDate}`, e);
    }
  }
  return [...byKey.values()].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/** The company's VAT cycle (null: not a vendor). A failure reading it, or a missing company row, propagates. */
export async function companyVatCycle(companyId: string): Promise<VatCycle | null> {
  const row = await readCompanyVatRow(companyId);
  if (!row) throw new Error(`Compliance calendar: company ${companyId} not found`);
  return vatCycleOfRow(row);
}

export interface CalendarWithMarks {
  events: ComplianceEvent[];
  /** True when the marks could not be read: a manually marked item may show overdue. */
  marksUnavailable: boolean;
  /** True when IsaFlow's own filings could not be read: an item IsaFlow filed may show overdue. */
  submissionsUnavailable: boolean;
}

/** A database error carries a five-character SQLSTATE `code`; anything else is a code bug. */
const isDatabaseError = (err: unknown): boolean =>
  typeof (err as { code?: unknown } | null)?.code === 'string' && /^[0-9A-Z]{5}$/.test((err as { code: string }).code);

/**
 * One read in its own savepoint (rolled back on any error, so the request transaction stays usable).
 * A database error is logged and returns null ("could not be loaded"); any other error propagates.
 */
async function guardedRead<T>(savepoint: string, what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await withSavepoint(savepoint, read);
  } catch (err) {
    if (!isDatabaseError(err)) throw err;
    log.warn(`Could not load ${what} for the compliance calendar`, { error: err }, 'sarsComplianceService');
    return null;
  }
}

/**
 * A pre-999c mark (no period) of the item: same type and a due date the item has now or had under the old
 * weekend-only rule (legacyMarkDueDates), so moving due dates off public holidays does not unmark it.
 */
function legacyMarkOf(legacy: readonly DbRow[], item: ComplianceEvent): DbRow | undefined {
  const dates = legacyDueDates(item.dueDate);
  return legacy.find((r) => r.event_type === item.eventType && dates.includes(fmtDate(r.due_date)));
}

/**
 * The company's calendar with what was filed laid over it.
 *   - The company's filings (sars_submissions, submitted or accepted): an item they fully cover
 *     (sarsSubmissionCoverage) is completed with `efiling` (how it was filed, and every covering
 *     filing). It is shown over a manual mark, which stays on the item so it can still be undone.
 *   - Manual marks (sars_compliance_events, 999c): a mark matches an item on (event type, period
 *     start, period end), so a mark made under one VAT cadence never marks another period that ends
 *     the same day; a row from before 999c (no period) matches on (event type, due date).
 * Each is read in its own savepoint; a database error sets its flag and leaves the rest of the
 * calendar, any other error propagates.
 */
export async function getComplianceCalendarWithMarks(companyId: string, year?: number): Promise<CalendarWithMarks> {
  const y = year || new Date().getFullYear();
  const staticEvents = calendarWindow(y, await companyVatCycle(companyId));
  const from = `${y - 1}-01-01`;
  const to = `${y + 1}-12-31`;

  const dbEvents = await guardedRead('sars_calendar_marks', 'compliance events', async () => (await sql`
      SELECT ce.id, ce.event_type, ce.due_date, ce.period_start, ce.period_end, ce.status, ce.submission_id,
             ce.sars_reference, ce.filed_at,
             public.approval_company_member_name(ce.company_id, ce.filed_by) AS filed_by_name
      FROM sars_compliance_events ce
      WHERE ce.company_id = ${companyId}::UUID
        AND (ce.due_date BETWEEN ${from}::DATE AND ${to}::DATE OR ce.period_end BETWEEN ${from}::DATE AND ${to}::DATE)
      ORDER BY ce.due_date
    `) as DbRow[]);
  const filed = await guardedRead('sars_calendar_submissions', 'filed submissions', () => readFiledSubmissions(companyId, from, to));

  const byPeriod = new Map<string, DbRow>();
  const legacy: DbRow[] = [];
  for (const dbe of dbEvents ?? []) {
    if (dbe.period_end) byPeriod.set(`${dbe.event_type}_${fmtDate(dbe.period_start)}_${fmtDate(dbe.period_end)}`, dbe);
    else legacy.push(dbe);
  }

  const events = staticEvents.map((se): ComplianceEvent => {
    const m = byPeriod.get(`${se.eventType}_${se.periodStart}_${se.periodEnd}`) ?? legacyMarkOf(legacy, se);
    const filedAt = m ? (m.filed_at instanceof Date ? m.filed_at.toISOString() : m.filed_at ? String(m.filed_at) : undefined) : undefined;
    const marked: ComplianceEvent = !m ? se : {
      ...se,
      id: String(m.id),
      status: m.status as ComplianceEvent['status'],
      submissionId: m.submission_id ? String(m.submission_id) : undefined,
      ...(filedAt ? { filedAt, filedBy: m.filed_by_name ? String(m.filed_by_name) : null } : {}),
      sarsReference: m.sars_reference ? String(m.sars_reference) : null,
    };
    // A filing is shown over a manual mark; the mark stays on the item so it can still be undone.
    const covering = coveringSubmissions(se, filed ?? []);
    if (!covering) return marked;
    return { ...marked, status: 'completed', efiling: { kind: weakestKind(covering), filings: filingLines(covering) } };
  });
  return { events, marksUnavailable: dbEvents === null, submissionsUnavailable: filed === null };
}

/** The events only (getComplianceCalendarWithMarks without the flag). */
export async function getComplianceCalendarWithDB(companyId: string, year?: number): Promise<ComplianceEvent[]> {
  return (await getComplianceCalendarWithMarks(companyId, year)).events;
}
