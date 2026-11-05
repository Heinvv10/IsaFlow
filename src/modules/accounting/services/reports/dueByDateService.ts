/**
 * "Due by date" report service. Reads the SAME open-document queries the AP and
 * AR aging are built from, at today's balances (no historic as-at in v1), and
 * buckets them by recorded due date. The bucketing and the footing rule live in
 * utils/dueByDate; this file only fetches and picks the clock.
 *
 * Today is the app date (SAST), from fmtDate(new Date()) exactly as the aging
 * services take it, never CURRENT_DATE: the database session is UTC, so between
 * 22:00 and midnight SAST CURRENT_DATE is the previous day.
 */

import { fmtDate } from '@/lib/fmtDate';
import { isUuidParam } from '@/lib/validation';
import { fetchAPAgingInvoices } from '../ap/apAgingInvoices';
import { fetchARAgingInvoices } from '../ar/arAgingInvoices';
import {
  buildDueByDateSide,
  byDateError,
  netPosition,
  type DueByDateContactDetail,
  type DueByDateReport,
  type DueByDateSide,
  type DueSide,
} from '../../utils/dueByDate';

/** Thrown for a by_date the report refuses; routes map it to a 400. */
export class DueByDateInputError extends Error {}

/** The app's calendar day (SAST). */
export function appToday(): string {
  return fmtDate(new Date());
}

function assertByDate(byDate: string, today: string): void {
  const problem = byDateError(byDate, today);
  if (problem) throw new DueByDateInputError(problem);
}

/** Open documents of one side as at today; `contactId` narrows to one supplier / customer in SQL. */
function readOpen(companyId: string, side: DueSide, today: string, contactId: string | null) {
  // asAt = today, rewind window = today: the live open book, as the aging page shows it.
  return side === 'ap'
    ? fetchAPAgingInvoices(companyId, today, today, contactId)
    : fetchARAgingInvoices(companyId, today, today, contactId);
}

/**
 * One side, with every contact's invoices. A failure is not logged here: the
 * REST route's withErrorHandler and the MCP registry each log a thrown error
 * once, and a second log here would make every failure two lines.
 */
export async function getDueByDate(
  companyId: string,
  side: DueSide,
  byDate: string,
): Promise<DueByDateSide<DueByDateContactDetail>> {
  const today = appToday();
  assertByDate(byDate, today);
  return buildDueByDateSide(side, await readOpen(companyId, side, today, null), today, byDate);
}

/**
 * One contact of a side with its invoices; null when the contact has nothing
 * open (or is not this company's). The contact is picked in SQL, by the
 * fetchers' own supplier / customer filter, so a drill-down reads one contact's
 * documents and not the whole side's. The contact id is the one the summary
 * lists: COALESCE(client_id, customer_id) on AR, supplier_id on AP.
 */
export async function getDueByDateContact(
  companyId: string,
  side: DueSide,
  byDate: string,
  contactId: string,
): Promise<DueByDateContactDetail | null> {
  const today = appToday();
  assertByDate(byDate, today);
  // Both callers check this already; the fetchers cast it ::UUID, and a cast error aborts the request transaction.
  if (!isUuidParam(contactId)) return null;
  const rows = await readOpen(companyId, side, today, contactId);
  return buildDueByDateSide(side, rows, today, byDate).contacts.find((c) => c.contactId === contactId) ?? null;
}

/** Both sides plus the net cash position (AR totalByDate - AP totalByDate). */
export async function getDueByDateReport(companyId: string, byDate: string): Promise<DueByDateReport<DueByDateContactDetail>> {
  const today = appToday();
  assertByDate(byDate, today);
  const [ap, ar] = await Promise.all([
    getDueByDate(companyId, 'ap', byDate),
    getDueByDate(companyId, 'ar', byDate),
  ]);
  return { today: ap.today, byDate, ap, ar, netPosition: netPosition(ar.totals, ap.totals) };
}
