/**
 * Payment terms: the due date a contact's terms give an invoice date, the one parser of a terms write, and the words
 * the UI shows. Shared by suppliers and customers (migration 960).
 *
 *   invoice_days      invoice date + N days (N = 0 is "Immediate")
 *   statement_days    month-end of the invoice month + N days (the statement is the month-end of the invoice month)
 *   statement_months  month-end of the Nth month after the invoice month (Aug 16 + 3 = Nov 30)
 *   not set (NULL)    the terms give no date
 *
 * The legacy customer values `days` and `end_of_month` still arrive (old rows, old clients, imports) and read as
 * `invoice_days` and `statement_days`.
 *
 * Local-date arithmetic only: `toISOString()` rolls the date back a day east of UTC. Safe in a client bundle (the one
 * side effect is a warning log for an unreadable company default).
 */
import { addDaysISO, localDateFromISO, monthEndISO } from '@/lib/dateUtils';
import { log } from '@/lib/logger';

export const PAYMENT_TERMS_TYPES = ['invoice_days', 'statement_days', 'statement_months'] as const;
export type PaymentTermsType = (typeof PAYMENT_TERMS_TYPES)[number];

/** Input-only value: "clear the terms" on an update (the DB stores NULL). */
export const TERMS_NOT_SET = 'not_set';

/** The largest N the app accepts (write and read); the tighten migration's CHECK says the same. */
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
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_PAYMENT_TERMS;
}

export interface Terms { days: number; type: PaymentTermsType }

/**
 * A contact's stored (N, type) as terms, or null when they are not set. Legacy rows read as they always meant: 'days'
 * is invoice days, 'end_of_month' is statement days, and a number with NO type (what the pre-960 code wrote as
 * `(30, NULL)`) is invoice days. A negative, fractional or over-cap number, or a type nobody defined, is not terms.
 */
export function readTerms(days: number | null | undefined, type: string | null | undefined): Terms | null {
  if (!validTermsNumber(days)) return null;
  const kind = type === null || type === undefined || type === '' ? 'invoice_days' : normalisePaymentTermsType(type);
  return kind === null ? null : { days, type: kind };
}

/** A company's default terms: what a contact whose own terms are not set is given. */
export const FALLBACK_COMPANY_TERMS: Terms = { days: 30, type: 'invoice_days' };

/** The accounting_settings key (per company) that holds the company's default terms, as JSON `{"days":30,"type":"invoice_days"}`. */
export const COMPANY_DEFAULT_TERMS_KEY = 'default_payment_terms';

/**
 * The company's default terms from the setting's stored value; 30 days from invoice when there is none. A stored value that
 * is there but unreadable (not JSON, or terms the forms would refuse, e.g. {"days":-1}) also falls back to 30 days, and
 * says so in the log with the company id: every undated contact of that company is being dated by a default nobody chose.
 */
export function companyTermsFromSetting(value: unknown, companyId?: string): Terms {
  if (typeof value !== 'string' || value === '') return FALLBACK_COMPANY_TERMS;
  let terms: Terms | null = null;
  try {
    const parsed = JSON.parse(value) as { days?: unknown; type?: unknown } | null;
    terms = readTerms(typeof parsed?.days === 'number' ? parsed.days : null, typeof parsed?.type === 'string' ? parsed.type : null);
  } catch {
    terms = null; // a hand-edited setting that is not JSON
  }
  if (terms === null) log.warn('Company default payment terms unreadable; using 30 days from invoice', { companyId }, 'paymentTerms');
  return terms ?? FALLBACK_COMPANY_TERMS;
}

export function companyTermsSetting(t: Terms): string {
  return JSON.stringify({ days: t.days, type: t.type });
}

/** A company's default terms from the two fields a contact GET carries; 30 days from invoice when unreadable. */
export function companyTermsFromFields(days: unknown, type: unknown): Terms {
  return readTerms(days === null || days === undefined ? null : Number(days), typeof type === 'string' ? type : null) ?? FALLBACK_COMPANY_TERMS;
}

/** The contact's own terms, else the company default; `own` says which. */
export function effectiveTerms(
  days: number | null | undefined, type: string | null | undefined, companyDefault: Terms = FALLBACK_COMPANY_TERMS,
): Terms & { own: boolean } {
  const mine = readTerms(days, type);
  return mine ? { ...mine, own: true } : { ...companyDefault, own: false };
}

/**
 * The due date `n` / `type` give `invoiceDateIso` ('YYYY-MM-DD'), or null when the terms give no date: not set, a
 * negative, fractional or over-cap number, a type this file does not know (no type reads as invoice days), or an
 * invoice date that is not a real date.
 */
export function dueDateFromTerms(
  invoiceDateIso: string,
  n: number | null | undefined,
  type: string | null | undefined,
): string | null {
  const invoiceDate = localDateFromISO(invoiceDateIso);
  const terms = readTerms(n, type);
  if (invoiceDate === null || terms === null) return null;
  let due: string;
  if (terms.type === 'invoice_days') due = addDaysISO(invoiceDateIso, terms.days);
  else if (terms.type === 'statement_days') due = addDaysISO(monthEndISO(invoiceDate), terms.days);
  else due = monthEndISO(new Date(invoiceDate.getFullYear(), invoiceDate.getMonth() + terms.days, 1));
  return localDateFromISO(due) === null ? null : due;
}

/** A bill's OWN terms text ("net30", "Net 45", "immediate") as a due date; null for anything else (including none). */
export function ownTermsDueDate(invoiceDateIso: string, paymentTerms?: string | null): string | null {
  if (!paymentTerms) return null;
  if (/^\s*immediate\s*$/i.test(paymentTerms)) return dueDateFromTerms(invoiceDateIso, 0, 'invoice_days');
  // \bnet: "Internet 7 days" is not terms; at most three digits: net365000 is not terms either.
  const match = paymentTerms.match(/\bnet\s*(\d{1,3})\b/i);
  return match ? dueDateFromTerms(invoiceDateIso, Number(match[1]), 'invoice_days') : null;
}

/** The due date for a document: the contact's own terms, else the company default. Null only for a bad invoice date. */
export function dueDateWithDefault(
  invoiceDateIso: string,
  n: number | null | undefined,
  type: string | null | undefined,
  companyDefault: Terms = FALLBACK_COMPANY_TERMS,
): string | null {
  const t = effectiveTerms(n, type, companyDefault);
  return dueDateFromTerms(invoiceDateIso, t.days, t.type);
}

export type TermsWrite =
  | { kind: 'leave' }
  | { kind: 'clear' }
  | { kind: 'days_only'; days: number }
  | { kind: 'set'; days: number; type: PaymentTermsType };

/**
 * What a write's `payment_terms` / `payment_terms_type` pair means.
 *   neither sent            leave (an update keeps the stored terms; a create stores "not set")
 *   a number alone          days_only: keeps the stored type (a create: invoice days) — callers that predate the type
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
  // A number alone: the type is whatever the contact has (a create reads it as invoice days).
  if (!hasType) return { kind: 'days_only', days };
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
  const t = readTerms(n, type);
  if (t === null) return 'Not set';
  if (t.type === 'invoice_days') return t.days === 0 ? 'Immediate' : `${plural(t.days, 'day')} from invoice date`;
  if (t.type === 'statement_days') return t.days === 0 ? 'End of the invoice month' : `${plural(t.days, 'day')} after statement`;
  return `${plural(t.days, 'month')} after statement`;
}

/** "Terms not confirmed — using company default (30 days from invoice date)" for a contact that has none, else the terms. */
export function describeContactTerms(
  n: number | null | undefined, type: string | null | undefined, companyDefault: Terms = FALLBACK_COMPANY_TERMS,
): string {
  const e = effectiveTerms(n, type, companyDefault);
  const words = describePaymentTerms(e.days, e.type);
  return e.own ? words : `Terms not confirmed — using company default (${words})`;
}
