/**
 * The SARS page's compliance calendar: the static calendar for the company's VAT cycle, with the
 * company's "marked filed" rows (sars_compliance_events, migration 999c) laid over it.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { getComplianceCalendar, type ComplianceEvent } from './sarsTaxPeriodsService';
import { readCompanyVatRow, vatCycleOfRow, type VatCycle } from './companyVatCycle';

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
  /** True when the marks could not be read: the events are the bare calendar, and a filed item may show overdue. */
  marksUnavailable: boolean;
}

/**
 * The company's calendar with its marks laid over it. A mark matches an item on (event type,
 * period start, period end), so a mark made under one VAT cadence never marks another period that
 * ends the same day; a row from before 999c (no period) matches on (event type, due date). The
 * marks are read in their own savepoint: a failed read (e.g. a privilege missing) returns the bare
 * calendar with `marksUnavailable` and leaves the request transaction usable.
 */
export async function getComplianceCalendarWithMarks(companyId: string, year?: number): Promise<CalendarWithMarks> {
  const y = year || new Date().getFullYear();
  const staticEvents = calendarWindow(y, await companyVatCycle(companyId));
  const from = `${y - 1}-01-01`;
  const to = `${y + 1}-12-31`;

  let dbEvents: DbRow[];
  try {
    dbEvents = await withSavepoint('sars_calendar_marks', async () => (await sql`
      SELECT ce.id, ce.event_type, ce.due_date, ce.period_start, ce.period_end, ce.status, ce.submission_id,
             ce.sars_reference, ce.filed_at,
             public.approval_company_member_name(ce.company_id, ce.filed_by) AS filed_by_name
      FROM sars_compliance_events ce
      WHERE ce.company_id = ${companyId}::UUID
        AND (ce.due_date BETWEEN ${from}::DATE AND ${to}::DATE OR ce.period_end BETWEEN ${from}::DATE AND ${to}::DATE)
      ORDER BY ce.due_date
    `) as DbRow[]);
  } catch (err) {
    log.warn('Could not load compliance events from DB, using static calendar', { error: err }, 'sarsComplianceService');
    return { events: staticEvents, marksUnavailable: true };
  }

  const byPeriod = new Map<string, DbRow>();
  const byDue = new Map<string, DbRow>();
  for (const dbe of dbEvents) {
    if (dbe.period_end) byPeriod.set(`${dbe.event_type}_${fmtDate(dbe.period_start)}_${fmtDate(dbe.period_end)}`, dbe);
    else byDue.set(`${dbe.event_type}_${fmtDate(dbe.due_date)}`, dbe);
  }

  const events = staticEvents.map((se) => {
    const m = byPeriod.get(`${se.eventType}_${se.periodStart}_${se.periodEnd}`) ?? byDue.get(`${se.eventType}_${se.dueDate}`);
    if (!m) return se;
    const filedAt = m.filed_at instanceof Date ? m.filed_at.toISOString() : m.filed_at ? String(m.filed_at) : undefined;
    return {
      ...se,
      id: String(m.id),
      status: m.status as ComplianceEvent['status'],
      submissionId: m.submission_id ? String(m.submission_id) : undefined,
      ...(filedAt ? { filedAt, filedBy: m.filed_by_name ? String(m.filed_by_name) : null } : {}),
      sarsReference: m.sars_reference ? String(m.sars_reference) : null,
    };
  });
  return { events, marksUnavailable: false };
}

/** The events only (getComplianceCalendarWithMarks without the flag). */
export async function getComplianceCalendarWithDB(companyId: string, year?: number): Promise<ComplianceEvent[]> {
  return (await getComplianceCalendarWithMarks(companyId, year)).events;
}
