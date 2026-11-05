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

import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { fetchAPAgingInvoices } from '../ap/apAgingInvoices';
import { fetchARAgingInvoices } from '../ar/arAgingInvoices';
import {
  buildDueByDateSide,
  byDateError,
  netPosition,
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

export async function getDueByDate(companyId: string, side: DueSide, byDate: string): Promise<DueByDateSide> {
  const today = appToday();
  assertByDate(byDate, today);
  try {
    // asAt = today, rewind window = today: the live open book, as the aging page shows it.
    const rows = side === 'ap'
      ? await fetchAPAgingInvoices(companyId, today, today)
      : await fetchARAgingInvoices(companyId, today, today);
    return buildDueByDateSide(side, rows, today, byDate);
  } catch (err) {
    log.error('Failed to get due-by-date report', { side, error: err }, 'accounting');
    throw err;
  }
}

/** Both sides plus the net cash position (AR totalByDate - AP totalByDate). */
export async function getDueByDateReport(companyId: string, byDate: string): Promise<DueByDateReport> {
  const today = appToday();
  assertByDate(byDate, today);
  const [ap, ar] = await Promise.all([
    getDueByDate(companyId, 'ap', byDate),
    getDueByDate(companyId, 'ar', byDate),
  ]);
  return { today: ap.today, byDate, ap, ar, netPosition: netPosition(ar.totals, ap.totals) };
}
