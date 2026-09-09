/**
 * L2 — the migration wizard's AP and AR routes used to cast `req.body`
 * straight to the row type, so wrong types, negative amounts and missing
 * fields reached the numeric and DATE columns unchecked and surfaced as raw
 * Postgres messages. These schemas stop that at the edge.
 */
import { describe, it, expect } from 'vitest';
import {
  APImportRequestSchema,
  ARImportRequestSchema,
} from '@/modules/accounting/services/core/migrationRowSchemas';

const SESSION = '3f8a1c22-9b7e-4d61-8a03-27c5e9d41b6f';

const apRow = {
  invoiceNumber: 'INV-1',
  supplierName: 'ACME',
  invoiceDate: '2026-06-30',
  dueDate: '2026-07-30',
  subtotal: 100,
  taxAmount: 15,
  totalAmount: 115,
};

const body = (rows: unknown[]) => ({ sessionId: SESSION, invoices: rows });

describe('migration invoice request schemas', () => {
  it('accepts a row with amountPaid omitted', () => {
    const parsed = APImportRequestSchema.safeParse(body([apRow]));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.invoices[0]!.amountPaid).toBeUndefined();
  });

  it('trims and keeps an optional reference', () => {
    const parsed = APImportRequestSchema.safeParse(body([{ ...apRow, reference: '  PO-9  ' }]));
    expect(parsed.success && parsed.data.invoices[0]!.reference).toBe('PO-9');
  });

  it.each([
    ['a negative amount', { ...apRow, totalAmount: -1 }],
    ['a numeric string where a number is required', { ...apRow, subtotal: '100' }],
    ['a missing supplier name', { ...apRow, supplierName: undefined }],
    ['a blank supplier name', { ...apRow, supplierName: '   ' }],
    ['a date that is not YYYY-MM-DD', { ...apRow, invoiceDate: '30/06/2026' }],
    ['a non-finite amount', { ...apRow, taxAmount: Number.POSITIVE_INFINITY }],
  ])('rejects %s', (_label, row) => {
    expect(APImportRequestSchema.safeParse(body([row])).success).toBe(false);
  });

  it('rejects an empty invoice array', () => {
    expect(APImportRequestSchema.safeParse(body([])).success).toBe(false);
  });

  it('rejects a sessionId that is not a UUID, before it reaches a ::UUID cast', () => {
    const parsed = APImportRequestSchema.safeParse({ sessionId: 'not-a-uuid', invoices: [apRow] });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.flatten().fieldErrors.sessionId).toBeTruthy();
  });

  it('the AR schema wants a customer name, not a supplier name', () => {
    expect(ARImportRequestSchema.safeParse(body([apRow])).success).toBe(false);
    const { supplierName, ...rest } = apRow;
    expect(supplierName).toBe('ACME');
    expect(ARImportRequestSchema.safeParse(body([{ ...rest, customerName: 'ACME' }])).success).toBe(true);
  });
});
