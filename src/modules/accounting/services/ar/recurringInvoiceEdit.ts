/**
 * Recurring invoice EDIT (PUT) — the pure pieces.
 *
 * Split from the route so the two things an edit used to get wrong are
 * unit-testable without a database: End Date was never read, and a missing
 * taxRate fell back to 15 while the stored tax_rate stayed put, leaving the
 * template's header at a different rate from the one the run derives from
 * (assertAggregateAgrees then refuses the template).
 */

import { fmtDate } from '@/lib/fmtDate';

/** A create or edit request the template refuses; the route answers it with a 400 and this message. */
export class RecurringInvoiceEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurringInvoiceEditError';
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/**
 * What an edit says about End Date. `provided: false` means the body has no
 * `endDate` key, so the stored value stays; `provided: true` with a null value
 * clears it (null or a blank string, which is what an emptied date input sends).
 */
export function parseEndDateEdit(body: Record<string, unknown>): { provided: boolean; value: string | null } {
  const raw = body.endDate;
  if (raw === undefined) return { provided: false, value: null };
  if (raw === null) return { provided: true, value: null };
  if (typeof raw !== 'string') throw new RecurringInvoiceEditError('endDate must be a YYYY-MM-DD date or null');
  const trimmed = raw.trim();
  if (trimmed === '') return { provided: true, value: null };
  if (!isCalendarDate(trimmed)) throw new RecurringInvoiceEditError('endDate must be a valid YYYY-MM-DD date');
  return { provided: true, value: trimmed };
}

function asRate(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return null;
}

/**
 * A tax rate the table can hold: finite, 0-100, at most 2 decimals. tax_rate is
 * NUMERIC(5,2), so 7.555 is stored as 7.56 while a header computed from the
 * request would use 7.555 — the run then derives a different tax from the
 * stored rate and assertAggregateAgrees refuses the template.
 */
export function parseTaxRate(value: unknown): number {
  const rate = asRate(value);
  if (rate === null || !Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new RecurringInvoiceEditError('taxRate must be a number between 0 and 100');
  }
  const cents = rate * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-7) {
    throw new RecurringInvoiceEditError('taxRate can have at most 2 decimal places');
  }
  return rate;
}

/**
 * The tax rate an edit applies. A rate in the request wins (0 included); an
 * edit that sends none keeps the template's STORED rate — create stored it in
 * tax_rate, and the page that edits lines never resends it. There is no
 * fallback: a stored value that is not a rate is refused, not guessed at 15.
 */
export function resolveEditTaxRate(requested: unknown, stored: unknown): number {
  if (requested !== undefined && requested !== null) return parseTaxRate(requested);
  try {
    return parseTaxRate(stored);
  } catch {
    throw new RecurringInvoiceEditError('The template has no usable stored tax rate; send taxRate');
  }
}

/** YYYY-MM-DD of the next run an edit leaves: the body's nextRunDate if it sends one, else the stored one. */
export function effectiveNextRunDate(requested: unknown, stored: unknown): string {
  if (typeof requested === 'string') {
    const m = /^\d{4}-\d{2}-\d{2}/.exec(requested.trim());
    if (m) return m[0];
  }
  return fmtDate(stored as Date | string);
}

/** An End Date before the next run would end the template before it ever bills (create's date input has min=nextRunDate). */
export function assertEndNotBeforeNextRun(endDate: string | null, nextRunDate: string): void {
  if (endDate !== null && endDate < nextRunDate) {
    throw new RecurringInvoiceEditError(`endDate cannot be before the next run date (${nextRunDate})`);
  }
}

/** Header totals for an edited template — the arithmetic createRecurringInvoice uses. */
export function editTotals(
  lineItems: ReadonlyArray<{ quantity?: number; unitPrice?: number }>,
  taxRate: number,
): { subtotal: number; taxAmount: number; totalAmount: number } {
  let subtotal = 0;
  for (const l of lineItems) subtotal += (l.quantity || 1) * (l.unitPrice || 0);
  const taxAmount = Math.round(subtotal * (taxRate / 100) * 100) / 100;
  return { subtotal, taxAmount, totalAmount: subtotal + taxAmount };
}
