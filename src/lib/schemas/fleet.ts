/**
 * Request bodies for the fleet record routes (`/api/accounting/assets/[assetId]/fuel` and `/service`, mig 853).
 * Shared with the asset page's forms, so the client and the route refuse the same input.
 */
import { z } from 'zod';
import { ISODate } from './common';

/**
 * A real calendar day in 1900–2999: `2026-02-30` passes the YYYY-MM-DD shape and `0000-01-01` passes JS `Date`, but
 * Postgres refuses both (a 500, not a 422). The year range is a sane bound for a vehicle's fuel or service date.
 */
const CalendarDate = ISODate.refine((d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}, 'Must be a real date').refine((d) => d >= '1900-01-01' && d <= '2999-12-31', 'Must be a date between 1900 and 2999');

/** Postgres TEXT refuses a NUL character (0x00) — a 500 if it reaches the INSERT. */
const noNul = (s: string) => !s.includes('\u0000');

const Rands = z.number().finite().nonnegative().multipleOf(0.01).max(9_999_999_999_999.99);
const OptionalText = z.string().trim().max(500).refine(noNul, 'Invalid character').nullish();

const Common = {
  amount: Rands,
  odometerKm: z.number().int().nonnegative().max(2_147_483_647).nullish(),
  supplierName: OptionalText,
  notes: OptionalText,
};

export const FuelRecordBody = z.object({
  fillDate: CalendarDate,
  litres: z.number().finite().positive().multipleOf(0.01).max(99_999_999.99),
  ...Common,
}).strict();

export const ServiceRecordBody = z.object({
  serviceDate: CalendarDate,
  description: z.string().trim().min(1, 'Description is required').max(500).refine(noNul, 'Invalid character'),
  ...Common,
}).strict();

export type FuelRecordBodyInput = z.infer<typeof FuelRecordBody>;
export type ServiceRecordBodyInput = z.infer<typeof ServiceRecordBody>;
