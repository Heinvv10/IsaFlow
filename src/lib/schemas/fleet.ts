/**
 * Request bodies for the fleet record routes (`/api/accounting/assets/[assetId]/fuel` and `/service`, mig 853).
 * Shared with the asset page's forms, so the client and the route refuse the same input.
 */
import { z } from 'zod';
import { ISODate } from './common';

/** A real calendar day: `2026-02-30` passes the YYYY-MM-DD shape but Postgres refuses it (a 500, not a 400). */
const CalendarDate = ISODate.refine((d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}, 'Must be a real date');

const Rands = z.number().finite().nonnegative().multipleOf(0.01).max(9_999_999_999_999.99);
const OptionalText = z.string().trim().max(500).nullish();

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
  description: z.string().trim().min(1, 'Description is required').max(500),
  ...Common,
}).strict();

export type FuelRecordBodyInput = z.infer<typeof FuelRecordBody>;
export type ServiceRecordBodyInput = z.infer<typeof ServiceRecordBody>;
