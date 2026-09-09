/**
 * Request-body schemas for the migration wizard's invoice steps.
 *
 * The AP and AR routes used to cast `req.body` straight to the row type, so a
 * wrong type, a missing field or a negative amount reached the numeric and DATE
 * columns unchecked and surfaced as a raw Postgres message in `errors`. The
 * per-row savepoint contains the damage to one row; this stops it earlier and
 * with a message the operator can act on.
 */

import { z } from 'zod';

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
  invoiceNumber: z.string().trim().min(1).max(100),
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
  supplierName: z.string().trim().min(1).max(200),
});

export const ARInvoiceRowSchema = z.object({
  ...invoiceRowBase,
  customerName: z.string().trim().min(1).max(200),
});

/** Written out per side rather than through a helper: a generic wrapper erases
 * the row type and hands the service `unknown[]`. */
export const APImportRequestSchema = z.object({
  sessionId: uuidish,
  invoices: z.array(APInvoiceRowSchema).min(1).max(5000),
});

export const ARImportRequestSchema = z.object({
  sessionId: uuidish,
  invoices: z.array(ARInvoiceRowSchema).min(1).max(5000),
});
