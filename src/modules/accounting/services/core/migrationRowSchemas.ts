/**
 * Request-body schemas for the migration wizard's invoice steps.
 *
 * The AP and AR routes used to cast `req.body` straight to the row type, so a
 * wrong type, a missing field or a negative amount reached the numeric and DATE
 * columns unchecked and surfaced as a raw Postgres message in `errors`. The
 * per-row savepoint contains the damage to one row; this stops it earlier and
 * with a message the operator can act on.
 *
 * Validation is PER ROW, not per file. Parsing the whole body with one
 * `safeParse` made a single malformed line — an Excel export carrying
 * `30/06/2026` in one cell, say — reject all 5000 of them with a `fieldErrors`
 * key of `invoices` and no row number, so the operator could not even tell
 * which line was wrong. `parseInvoiceRows` collects the failures with their
 * source row index and lets the rest import, which is the shape the services
 * already use for every other kind of bad row.
 */

import { z } from 'zod';
import type { MigrationError } from './migrationService';

/**
 * Deliberately not `z.uuid()`: zod 4 enforces the RFC version nibbles and this
 * database holds seeded identifiers that do not carry them.
 */
const uuidish = z.string().regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  'Must be a UUID',
);

/** YYYY-MM-DD. The columns are DATE, and the service casts with `::DATE`. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date as YYYY-MM-DD');

const money = z.number().finite().nonnegative().max(1e13);

const invoiceRowBase = {
  invoiceDate: isoDate,
  dueDate: isoDate,
  subtotal: money,
  taxAmount: money,
  totalAmount: money,
  amountPaid: money.optional(),
  reference: z.string().trim().max(200).optional(),
};

export const APInvoiceRowSchema = z.object({
  ...invoiceRowBase,
  /**
   * BLANK IS LEGITIMATE on the AP side, and this is the schema half of that
   * decision. A supplier bill taken on from another system often has no number
   * of its own — a till slip, a cash purchase, a statement line — and nothing
   * in the schema refuses one: `supplier_invoices` has no unique index on the
   * number at all, and the one K-107 proposes (migration 646, not on origin as
   * this is written) exempts `invoice_number = ''` explicitly. AR is the other
   * way round — see `ARInvoiceRowSchema`.
   *
   * (An earlier revision of this comment cited migration 412's `coalesce(
   * si.invoice_number, 'no-inv')` as evidence. It is not: the column is
   * `VARCHAR(50) NOT NULL` since migration 201, so that COALESCE can never
   * fire on this table and a blank number produces an empty segment.)
   *
   * `importAPInvoices` therefore keys on the number when there is one and on
   * (supplier, date, total, reference) when there is not. Requiring a number
   * here would have rejected a legitimate take-on file outright.
   *
   * ABSENT IS NOT BLANK. A row that carries no `invoiceNumber` key at all is
   * an unmapped column, not an unnumbered bill; the route refuses the whole
   * file for that before it reaches this schema — see
   * `invoiceNumberColumnUnmapped`.
   *
   * `max(50)` because the column is VARCHAR(50): a longer number used to pass
   * validation and die at the INSERT with a raw 22001.
   */
  invoiceNumber: z.string().trim().max(50),
  supplierName: z.string().trim().min(1).max(200),
  /**
   * The wizard page's manual supplier correction. Optional, and `''` means the
   * page had nothing to send — the service falls back to matching on the name.
   */
  supplierId: z.union([uuidish, z.literal('')]).optional(),
});

export const ARInvoiceRowSchema = z.object({
  ...invoiceRowBase,
  /**
   * Required on the AR side, unlike AP. `uq_customer_invoices_company_number`
   * (migration 220) is company-wide with no blank exemption, so a second
   * blank-numbered customer invoice cannot be inserted at all; accepting one
   * would only turn a clear rejection into "Invoice number already exists: ".
   */
  invoiceNumber: z.string().trim().min(1).max(50),
  customerName: z.string().trim().min(1).max(200),
});

/**
 * The envelope only. The rows are `unknown` here and are parsed one at a time
 * by `parseInvoiceRows`, so one bad row costs one row.
 */
export const ImportEnvelopeSchema = z.object({
  sessionId: uuidish,
  invoices: z.array(z.unknown())
    .min(1, 'The file has no rows to import')
    .max(5000, 'Import at most 5000 rows at a time — split the file and run it in parts'),
});

/**
 * True when the operator never mapped the invoice-number column: EVERY row in
 * the file arrives without the key.
 *
 * This has to be told apart from a file that legitimately contains blank
 * numbers, because the two need opposite treatment. A blank number is a bill
 * with no number of its own and imports normally; an unmapped column makes
 * every row look blank, and those rows then de-duplicate against each other on
 * (supplier, date, total, reference) — so a file of real numbered bills would
 * import a fraction of itself and report the rest as already imported. A
 * take-on that silently loads a subset is worse than one that refuses, because
 * nobody investigates a success. The wizard page sends the value only for a
 * mapped column, so absence here is the mapping mistake and refusing the whole
 * file is the loud answer.
 */
export function invoiceNumberColumnUnmapped(raw: unknown[]): boolean {
  return raw.length > 0 && raw.every(
    row => typeof row === 'object' && row !== null
      && (row as Record<string, unknown>).invoiceNumber === undefined,
  );
}

export interface ParsedInvoiceRows<T> {
  /** The rows that parsed, in request order. */
  rows: T[];
  /** `sourceRows[i]` is the position of `rows[i]` in the request body. */
  sourceRows: number[];
  /** One entry per row that did not parse, carrying its request position. */
  errors: MigrationError[];
}

/** First failure per row, named by field, so the operator can fix that cell. */
function firstIssue(err: z.ZodError): { field?: string; message: string } {
  const issue = err.issues[0];
  if (!issue) return { message: 'Row is not valid' };
  const field = issue.path.length > 0 ? issue.path.join('.') : undefined;
  return { field, message: field ? `${field}: ${issue.message}` : issue.message };
}

export function parseInvoiceRows<T>(
  schema: z.ZodType<T>,
  step: 'ap_invoices' | 'ar_invoices',
  raw: unknown[],
): ParsedInvoiceRows<T> {
  const rows: T[] = [];
  const sourceRows: number[] = [];
  const errors: MigrationError[] = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = schema.safeParse(raw[i]);
    if (parsed.success) {
      rows.push(parsed.data);
      sourceRows.push(i);
      continue;
    }
    const { field, message } = firstIssue(parsed.error);
    errors.push({ step, row: i, ...(field ? { field } : {}), message });
  }
  return { rows, sourceRows, errors };
}
