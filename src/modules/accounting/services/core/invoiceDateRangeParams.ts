/**
 * Query-param validation for an invoice-date range (`from_date` / `to_date`),
 * shared by the customer- and supplier-invoice list and export routes.
 *
 * Both bounds are inclusive calendar dates (YYYY-MM-DD) compared against a pg
 * DATE column, so no timezone is involved: a SAST month is simply
 * `YYYY-MM-01 .. YYYY-MM-<last>`. A malformed or impossible date is an error,
 * never a silent "no filter" — a user who asked for June must not get every
 * invoice back because they typed 2026-06-31.
 */

import { z } from 'zod';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  // Day 0 of the next month is the last day of this one; UTC keeps it off the box's zone.
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const optionalDate = (name: string) => z
  .string({ error: `${name} must be a single YYYY-MM-DD date` })
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v))
  .refine((v) => v === undefined || isCalendarDate(v), { error: `${name} must be a real YYYY-MM-DD date` });

const rangeSchema = z
  .object({ from_date: optionalDate('from_date'), to_date: optionalDate('to_date') })
  .refine((r) => !r.from_date || !r.to_date || r.from_date <= r.to_date, {
    error: 'from_date must be on or before to_date',
  });

export type DateRangeParseResult =
  | { ok: true; fromDate?: string; toDate?: string }
  | { ok: false; error: string };

export function parseInvoiceDateRange(query: Record<string, unknown>): DateRangeParseResult {
  const parsed = rangeSchema.safeParse({ from_date: query.from_date, to_date: query.to_date });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid date range' };
  return { ok: true, fromDate: parsed.data.from_date, toDate: parsed.data.to_date };
}
