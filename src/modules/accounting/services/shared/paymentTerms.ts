/**
 * Payment terms: the due date a contact's terms give an invoice date, the one parser of a terms write, and the words
 * the UI shows. Shared by suppliers and customers (migration 958).
 *
 *   invoice_days      invoice date + N days (N = 0 is "Immediate")
 *   statement_days    month-end of the invoice month + N days (the statement is the month-end of the invoice month)
 *   statement_months  month-end of the Nth month after the invoice month (Aug 16 + 3 = Nov 30)
 *   not set (NULL)    the terms give no date
 *
 * The legacy customer values `days` and `end_of_month` still arrive (old rows, old clients, imports) and read as
 * `invoice_days` and `statement_days`.
 *
 * Local-date arithmetic only: `toISOString()` rolls the date back a day east of UTC. Pure, safe in a client bundle.
 */
import { addDaysISO, localDateFromISO, monthEndISO } from '@/lib/dateUtils';

export const PAYMENT_TERMS_TYPES = ['invoice_days', 'statement_days', 'statement_months'] as const;
export type PaymentTermsType = (typeof PAYMENT_TERMS_TYPES)[number];

/** Input-only value: "clear the terms" on an update (the DB stores NULL). */
export const TERMS_NOT_SET = 'not_set';

/** The largest N a write accepts; the DB check only demands a non-negative integer. */
export const MAX_PAYMENT_TERMS = 999;

const LEGACY_TYPES: Record<string, PaymentTermsType> = { days: 'invoice_days', end_of_month: 'statement_days' };

export class PaymentTermsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentTermsError';
  }
}

/** The canonical type for a stored or submitted value, or null when it is none of the known ones. */
export function normalisePaymentTermsType(type: string | null | undefined): PaymentTermsType | null {
  if (typeof type !== 'string') return null;
  if ((PAYMENT_TERMS_TYPES as readonly string[]).includes(type)) return type as PaymentTermsType;
  return LEGACY_TYPES[type] ?? null;
}

function validTermsNumber(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/**
 * The due date `n` / `type` give `invoiceDateIso` ('YYYY-MM-DD'), or null when the terms give no date: not set, a
 * negative or fractional number, a type this file does not know, an invoice date that is not a real date, or a
 * number so large the result is not a date.
 */
export function dueDateFromTerms(
  invoiceDateIso: string,
  n: number | null | undefined,
  type: string | null | undefined,
): string | null {
  const invoiceDate = localDateFromISO(invoiceDateIso);
  const kind = normalisePaymentTermsType(type);
  if (invoiceDate === null || kind === null || !validTermsNumber(n)) return null;
  let due: string;
  if (kind === 'invoice_days') due = addDaysISO(invoiceDateIso, n);
  else if (kind === 'statement_days') due = addDaysISO(monthEndISO(invoiceDate), n);
  else due = monthEndISO(new Date(invoiceDate.getFullYear(), invoiceDate.getMonth() + n, 1));
  return localDateFromISO(due) === null ? null : due;
}

export type TermsWrite =
  | { kind: 'leave' }
  | { kind: 'clear' }
  | { kind: 'set'; days: number; type: PaymentTermsType };

/**
 * What a write's `payment_terms` / `payment_terms_type` pair means.
 *   neither sent            leave (an update keeps the stored terms; a create stores "not set")
 *   a number alone          invoice days (callers that predate the type)
 *   a number and a type     set
 *   type `not_set`, no N    clear
 * Anything else (a type without its number, an unknown type, a negative, fractional or over-cap number) throws
 * PaymentTermsError before the database can answer with an opaque check violation.
 */
export function parseTermsWrite(days: number | null | undefined, type: string | null | undefined): TermsWrite {
  const hasDays = days !== null && days !== undefined;
  const hasType = typeof type === 'string' && type !== '';
  if (!hasDays && !hasType) return { kind: 'leave' };
  if (type === TERMS_NOT_SET) {
    if (hasDays) throw new PaymentTermsError('payment_terms must be omitted when payment_terms_type is not_set');
    return { kind: 'clear' };
  }
  if (!hasDays) throw new PaymentTermsError('payment_terms (a whole number) is required with payment_terms_type');
  if (!validTermsNumber(days) || days > MAX_PAYMENT_TERMS) {
    throw new PaymentTermsError(`payment_terms must be a whole number from 0 to ${MAX_PAYMENT_TERMS}`);
  }
  if (!hasType) return { kind: 'set', days, type: 'invoice_days' };
  const kind = normalisePaymentTermsType(type);
  if (kind === null) {
    throw new PaymentTermsError(`payment_terms_type must be one of: ${PAYMENT_TERMS_TYPES.join(', ')}, ${TERMS_NOT_SET}`);
  }
  return { kind: 'set', days, type: kind };
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** The terms in words: "Immediate", "30 days from invoice date", "3 months after statement", "Not set". */
export function describePaymentTerms(n: number | null | undefined, type: string | null | undefined): string {
  const kind = normalisePaymentTermsType(type);
  if (kind === null || !validTermsNumber(n)) return 'Not set';
  if (kind === 'invoice_days') return n === 0 ? 'Immediate' : `${plural(n, 'day')} from invoice date`;
  if (kind === 'statement_days') return n === 0 ? 'End of the invoice month' : `${plural(n, 'day')} after statement`;
  return `${plural(n, 'month')} after statement`;
}
