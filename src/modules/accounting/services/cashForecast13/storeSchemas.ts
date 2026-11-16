/**
 * Request validation for the 13-week cash forecast's stored inputs (routes under
 * /api/accounting/cash-forecast-13). Mirrors migration 999i's CHECKs so a bad value is a 400 here,
 * never a 23514 inside the request transaction. Dates must be real calendar dates.
 */
import { z } from 'zod';
import { UUID } from '@/lib/schemas/common';
import { isRealCalendarDate } from '@/lib/validation';

/** numeric(15,2): below 10^13 in magnitude. */
const MAX_AMOUNT = 9_999_999_999_999.99;

const hasTwoDecimals = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

const Amount = z.number().finite()
  .refine(hasTwoDecimals, 'Amounts have at most two decimals')
  .refine((n) => Math.abs(n) <= MAX_AMOUNT, 'Amount is too large');

export const CalendarDate = z.string().refine(isRealCalendarDate, 'Dates are real calendar dates (YYYY-MM-DD)');

/** ISO day 1. Only called on a real calendar date. */
export function isMonday(date: string): boolean {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 1;
}

const Monday = CalendarDate.refine(isMonday, 'Weeks start on a Monday');

export const ItemInput = z.object({
  direction: z.enum(['receipt', 'payment']),
  amount: Amount.refine((n) => n > 0, 'Amount must be more than 0'),
  date: CalendarDate,
  repeat: z.enum(['none', 'weekly', 'monthly']).default('none'),
  repeatUntil: CalendarDate.nullish().transform((v) => v ?? null),
  description: z.string().trim().min(1, 'A description is required').max(200, 'The description is at most 200 characters'),
  accountId: UUID.nullish().transform((v) => v ?? null),
}).superRefine((v, ctx) => {
  if (v.repeatUntil === null) return;
  if (v.repeat === 'none') ctx.addIssue({ code: 'custom', path: ['repeatUntil'], message: 'A one-off item has no repeat end' });
  else if (v.repeatUntil < v.date) ctx.addIssue({ code: 'custom', path: ['repeatUntil'], message: 'The repeat ends on or after the first date' });
});
export type ItemInput = z.infer<typeof ItemInput>;

export const ItemUpdate = z.object({ id: UUID }).and(ItemInput);

export const OverrideInput = z.object({
  lineKey: z.string().trim().min(1, 'lineKey is required').max(200, 'lineKey is at most 200 characters'),
  weekStart: Monday,
  mode: z.enum(['set', 'add', 'move_to']),
  amount: Amount,
  targetWeekStart: Monday.nullish().transform((v) => v ?? null),
  note: z.string().trim().max(500, 'The note is at most 500 characters').nullish().transform((v) => (v ? v : null)),
}).superRefine((v, ctx) => {
  if (v.mode === 'set' && v.amount < 0) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'A set amount is 0 or more' });
  if (v.mode === 'add' && v.amount === 0) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'An add amount is not 0' });
  if (v.mode === 'move_to') {
    if (v.amount <= 0) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'A moved amount is more than 0' });
    if (v.targetWeekStart === null) ctx.addIssue({ code: 'custom', path: ['targetWeekStart'], message: 'move_to needs a target week' });
    else if (v.targetWeekStart === v.weekStart) ctx.addIssue({ code: 'custom', path: ['targetWeekStart'], message: 'The target week differs from the week' });
  } else if (v.targetWeekStart !== null) {
    ctx.addIssue({ code: 'custom', path: ['targetWeekStart'], message: 'Only move_to takes a target week' });
  }
});
export type OverrideInput = z.infer<typeof OverrideInput>;

export const PayDayInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('day_of_month'), day: z.number().int().min(1).max(31) }),
  z.object({ kind: z.literal('last_working_day') }),
]);
export type PayDayInput = z.infer<typeof PayDayInput>;
