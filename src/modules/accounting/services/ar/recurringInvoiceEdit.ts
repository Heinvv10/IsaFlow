/**
 * Recurring invoice EDIT (PUT) — the pure pieces.
 *
 * Split from the route so the two things an edit used to get wrong are
 * unit-testable without a database: End Date was never read, and a missing
 * taxRate fell back to 15 while the stored tax_rate stayed put, leaving the
 * template's header at a different rate from the one the run derives from
 * (assertAggregateAgrees then refuses the template).
 */

/** A request the edit refuses; the route answers it with a 400 and this message. */
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
 * The tax rate an edit applies. A rate in the request wins (0 included); an
 * edit that sends none keeps the template's STORED rate — create stored it in
 * tax_rate, and the page that edits lines never resends it. There is no
 * fallback: a stored value that is not a rate is refused, not guessed at 15.
 */
export function resolveEditTaxRate(requested: unknown, stored: unknown): number {
  if (requested !== undefined && requested !== null) {
    const rate = asRate(requested);
    if (rate === null || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      throw new RecurringInvoiceEditError('taxRate must be a number between 0 and 100');
    }
    return rate;
  }
  const rate = asRate(stored);
  if (rate === null || !Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new RecurringInvoiceEditError('The template has no usable stored tax rate; send taxRate');
  }
  return rate;
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
