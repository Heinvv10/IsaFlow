/**
 * L2 — the migration wizard's AP and AR routes used to cast `req.body`
 * straight to the row type, so wrong types, negative amounts and missing
 * fields reached the numeric and DATE columns unchecked and surfaced as raw
 * Postgres messages. These schemas stop that at the edge.
 *
 * Round 4 adds the two decisions the previous revision got wrong:
 *   - a BLANK AP invoice number is legitimate, because the service's
 *     fingerprint fallback exists for it and production carries such rows;
 *   - validation is per ROW, so one bad line costs one line rather than the
 *     whole 5000-row file, and the failure names its position in that file.
 */
import { describe, it, expect } from 'vitest';
import {
  APInvoiceRowSchema,
  ARInvoiceRowSchema,
  ImportEnvelopeSchema,
  invoiceNumberColumnUnmapped,
  parseInvoiceRows,
} from '@/modules/accounting/services/core/migrationRowSchemas';

const SESSION = '3f8a1c22-9b7e-4d61-8a03-27c5e9d41b6f';
const SUPPLIER = '9c1d5e70-4a2b-4c88-9f31-6e0b7a45d213';

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
    const parsed = APInvoiceRowSchema.safeParse(apRow);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.amountPaid).toBeUndefined();
  });

  it('trims and keeps an optional reference', () => {
    const parsed = APInvoiceRowSchema.safeParse({ ...apRow, reference: '  PO-9  ' });
    expect(parsed.success && parsed.data.reference).toBe('PO-9');
  });

  it.each([
    ['a negative amount', { ...apRow, totalAmount: -1 }],
    ['a numeric string where a number is required', { ...apRow, subtotal: '100' }],
    ['a missing supplier name', { ...apRow, supplierName: undefined }],
    ['a blank supplier name', { ...apRow, supplierName: '   ' }],
    ['a date that is not YYYY-MM-DD', { ...apRow, invoiceDate: '30/06/2026' }],
    ['a non-finite amount', { ...apRow, taxAmount: Number.POSITIVE_INFINITY }],
    ['a supplier override that is not a UUID', { ...apRow, supplierId: 'nope' }],
  ])('rejects %s', (_label, row) => {
    expect(APInvoiceRowSchema.safeParse(row).success).toBe(false);
  });

  it('accepts a BLANK AP invoice number, which the blank-row fallback exists for', () => {
    // The service keys a numbered bill on its number and a blank one on
    // (supplier, date, total, reference). Requiring a number here made that
    // fallback unreachable through the only API that calls it, and 400ed a
    // whole take-on file over one unnumbered till slip.
    for (const invoiceNumber of ['', '   ']) {
      const parsed = APInvoiceRowSchema.safeParse({ ...apRow, invoiceNumber });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.invoiceNumber).toBe('');
    }
  });

  it('rejects an invoice number longer than the VARCHAR(50) column, on both sides', () => {
    // 51-100 characters used to pass here and die at the INSERT with a raw
    // 22001, which the per-row savepoint contains but the operator cannot read.
    const long = 'X'.repeat(51);
    expect(APInvoiceRowSchema.safeParse({ ...apRow, invoiceNumber: long }).success).toBe(false);
    expect(APInvoiceRowSchema.safeParse({ ...apRow, invoiceNumber: 'X'.repeat(50) }).success).toBe(true);
    const { supplierName: _s, ...rest } = apRow;
    expect(ARInvoiceRowSchema.safeParse({ ...rest, customerName: 'ACME', invoiceNumber: long }).success).toBe(false);
  });

  it('tells an UNMAPPED invoice-number column apart from a file of blank ones', () => {
    // Both look like "no number" at the service. An unmapped column is a
    // mapping mistake and must refuse the whole file: every row would import as
    // unnumbered and de-duplicate against the others on (supplier, date,
    // total, reference), loading a fraction of the file and reporting the rest
    // as already imported.
    const { invoiceNumber: _n, ...noNumber } = apRow;
    expect(invoiceNumberColumnUnmapped([noNumber, noNumber])).toBe(true);
    // A file that legitimately carries blanks sends the field, empty.
    expect(invoiceNumberColumnUnmapped([{ ...apRow, invoiceNumber: '' }])).toBe(false);
    // One row missing it among mapped ones is not an unmapped column.
    expect(invoiceNumberColumnUnmapped([apRow, noNumber])).toBe(false);
    expect(invoiceNumberColumnUnmapped([])).toBe(false);
    expect(invoiceNumberColumnUnmapped(['nonsense', 42])).toBe(false);
  });

  it('keeps the page\'s supplier override, and treats an empty one as absent', () => {
    const withId = APInvoiceRowSchema.safeParse({ ...apRow, supplierId: SUPPLIER });
    expect(withId.success && withId.data.supplierId).toBe(SUPPLIER);
    // The wizard page sends '' when it has no match to offer.
    expect(APInvoiceRowSchema.safeParse({ ...apRow, supplierId: '' }).success).toBe(true);
  });

  it('the AR schema still REQUIRES a number, because its unique index has no blank exemption', () => {
    const { supplierName, ...rest } = apRow;
    expect(supplierName).toBe('ACME');
    const arRow = { ...rest, customerName: 'ACME' };
    expect(ARInvoiceRowSchema.safeParse(arRow).success).toBe(true);
    expect(ARInvoiceRowSchema.safeParse({ ...arRow, invoiceNumber: '' }).success).toBe(false);
  });

  it('the AR schema wants a customer name, not a supplier name', () => {
    expect(ARInvoiceRowSchema.safeParse(apRow).success).toBe(false);
  });

  it('rejects an empty invoice array and a sessionId that is not a UUID', () => {
    expect(ImportEnvelopeSchema.safeParse(body([])).success).toBe(false);
    const parsed = ImportEnvelopeSchema.safeParse({ sessionId: 'not-a-uuid', invoices: [apRow] });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.flatten().fieldErrors.sessionId).toBeTruthy();
  });

  it('does not look at the rows: they are parsed one at a time', () => {
    expect(ImportEnvelopeSchema.safeParse(body(['nonsense', 42])).success).toBe(true);
  });
});

describe('parseInvoiceRows', () => {
  it('imports the good rows and reports each bad one against its file position', () => {
    const raw = [
      apRow,
      { ...apRow, invoiceDate: '30/06/2026' },   // the SA-locale Excel export
      { ...apRow, invoiceNumber: 'INV-3' },
    ];
    const { rows, sourceRows, errors } = parseInvoiceRows(APInvoiceRowSchema, 'ap_invoices', raw);

    expect(rows).toHaveLength(2);
    expect(sourceRows).toEqual([0, 2]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ step: 'ap_invoices', row: 1, field: 'invoiceDate' });
    expect(errors[0]!.message).toContain('YYYY-MM-DD');
  });

  it('names every bad row, not only the first', () => {
    const { rows, errors } = parseInvoiceRows(APInvoiceRowSchema, 'ap_invoices', [
      { ...apRow, totalAmount: -1 },
      apRow,
      { ...apRow, supplierName: '' },
    ]);
    expect(rows).toHaveLength(1);
    expect(errors.map(e => e.row)).toEqual([0, 2]);
  });

  it('returns no rows at all when every row is bad, rather than throwing', () => {
    const { rows, errors } = parseInvoiceRows(ARInvoiceRowSchema, 'ar_invoices', ['x', null]);
    expect(rows).toEqual([]);
    expect(errors.map(e => e.step)).toEqual(['ar_invoices', 'ar_invoices']);
  });
});
