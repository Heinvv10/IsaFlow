/**
 * The edit page's load -> save-unchanged round trip with per-line VAT (editInvoiceLoad, invoicePutBody, formVat): an
 * inclusive typed invoice loads in Including VAT with its prices as stored and its discount read off the GROSS (not a
 * phantom ~13% off the net), a mixed invoice keeps each line's type, and the body the page sends re-prices to exactly
 * the stored rows (invoiceLineVatPricing, what the draft edit stores).
 */
import { describe, expect, it } from 'vitest';
import { linesFromStoredItems, vatAtLoad, type InvoiceDetail } from '@/components/accounting/customer-invoices/editInvoiceLoad';
import { invoicePutBody } from '@/components/accounting/customer-invoices/invoicePutBody';
import { formTotals, lineVatTypes } from '@/components/accounting/customer-invoices/formVat';
import { priceInvoiceVat, type AmountsAre } from '@/modules/accounting/services/ar/invoiceLineVatPricing';
import type { DocumentLineVatType } from '@/modules/accounting/services/ar/invoiceLineVatTypes';
import { discountFromAmount } from '@/modules/accounting/services/ar/invoiceLineAmount';
import type { InvoiceHeaderForm } from '@/components/accounting/customer-invoices/invoiceHeaderForm';

const DATE = '2026-11-20';
type In = { description: string; quantity: number; unitPrice: number; discount: number; vatType: DocumentLineVatType };

/** The invoice as the server stores it for `lines` (create / draft edit), shaped as the detail GET returns it. */
function stored(lines: In[], amountsAre: AmountsAre): InvoiceDetail {
  const p = priceInvoiceVat(lines, { typed: true, types: lines.map((l) => l.vatType) }, DATE, amountsAre);
  return {
    id: 'inv-1', status: 'draft', invoice_number: 'INV-1', invoice_date: DATE, tax_rate: String(p.header.taxRate),
    total_amount: String(p.header.total), amounts_are: amountsAre,
    items: p.lines.map((l, i) => ({ description: lines[i]!.description, quantity: String(l.qty), unit_price: String(l.price),
      amount: String(l.amount), tax_rate: String(l.taxRate), tax_amount: String(l.taxAmount), vat_type: l.vatType })),
  };
}

const FORM: InvoiceHeaderForm = { clientId: 'c-1', invoiceDate: DATE, dueDate: '', billingPeriodStart: '',
  billingPeriodEnd: '', notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' };
/** The page's totals for the loaded lines (each line's own type, else the customer's). */
const shownTotals = (lines: ReturnType<typeof linesFromStoredItems>, mode: ReturnType<typeof vatAtLoad>['mode'], customerVat?: string) =>
  formTotals(lines, lineVatTypes(lines, customerVat), mode, DATE);

/** Load, then build the PUT body of an unchanged save; and the rows that body prices to. */
function roundTrip(detail: InvoiceDetail) {
  const v = vatAtLoad(detail);
  const lines = linesFromStoredItems(detail.items ?? [], '', v);
  const body = invoicePutBody('inv-1', { form: FORM, lines, taxMode: v.mode });
  const types = body.items.map((i) => i.vatType as DocumentLineVatType);
  const again = priceInvoiceVat(body.items, { typed: true, types }, DATE, body.amountsAre);
  return { v, lines, body, again };
}
const rowsOf = (d: InvoiceDetail) => (d.items ?? []).map((r) => ({
  qty: Number(r.quantity), price: Number(r.unit_price), amount: Number(r.amount), taxAmount: Number(r.tax_amount), vatType: r.vat_type, taxRate: Number(r.tax_rate),
}));

describe('an inclusive typed invoice', () => {
  const lines: In[] = [
    { description: 'Ten', quantity: 100, unitPrice: 9.99, discount: 0, vatType: 'standard' },
    { description: 'Disc', quantity: 3, unitPrice: 33.33, discount: 12.5, vatType: 'standard' },
    { description: 'Rent', quantity: 1, unitPrice: 200, discount: 0, vatType: 'exempt' },
  ];
  const detail = stored(lines, 'inclusive');

  it('loads in Including VAT, prices as stored (VAT-inclusive), the discount read off the gross', () => {
    const { v, lines: loaded } = roundTrip(detail);
    expect(v.mode).toBe('inclusive');
    expect(loaded.map((l) => [l.unitPrice, l.discount])).toEqual([[9.99, 0], [33.33, 12.5], [200, 0]]);
    // What the old load read off the NET: a phantom discount on an undiscounted line.
    expect(discountFromAmount(100, 9.99, Number(detail.items![0]!.amount))).toBeGreaterThan(13);
  });

  it('an unchanged save sends the mode, the prices as entered and each line\'s type, and re-prices to the stored rows', () => {
    const { body, again } = roundTrip(detail);
    expect(body.amountsAre).toBe('inclusive');
    expect('taxRate' in body).toBe(false);
    expect(body.items.map((i) => [i.unitPrice, i.vatType])).toEqual([[9.99, 'standard'], [33.33, 'standard'], [200, 'exempt']]);
    expect(again.lines).toEqual(rowsOf(detail));
    expect(again.header.total).toBe(Number(detail.total_amount));
  });

  it('the page\'s summary is the stored total: 999.00 + 87.49 + 200.00, exactly what was entered', () => {
    const { v, lines: loaded } = roundTrip(detail);
    expect(shownTotals(loaded, v.mode).total).toBe(1286.49);
    expect(Number(detail.total_amount)).toBe(1286.49);
  });
});

describe('a mixed exclusive invoice made through the API', () => {
  const detail = stored([
    { description: 'Fee', quantity: 1, unitPrice: 1000, discount: 0, vatType: 'standard' },
    { description: 'Export', quantity: 1, unitPrice: 300, discount: 0, vatType: 'zero_rated' },
    { description: 'Rent', quantity: 1, unitPrice: 200, discount: 0, vatType: 'exempt' },
  ], 'exclusive');

  it('round-trips: no line is re-typed by the header\'s 15%', () => {
    const { body, again } = roundTrip(detail);
    expect(body.items.map((i) => i.vatType)).toEqual(['standard', 'zero_rated', 'exempt']);
    expect(again.lines).toEqual(rowsOf(detail));
    expect(again.header).toMatchObject({ subtotal: 1500, tax: 150, total: 1650 });
  });

  it('a line re-typed by the user sends its new type; the others keep theirs; the customer re-types none of them', () => {
    const v = vatAtLoad(detail);
    const lines = linesFromStoredItems(detail.items ?? [], '', v).map((l, i) => (i === 0 ? { ...l, vatType: 'exempt' } : l));
    const body = invoicePutBody('inv-1', { form: FORM, lines, taxMode: v.mode, customerVat: 'zero' });
    expect(body.items.map((i) => i.vatType)).toEqual(['exempt', 'zero_rated', 'exempt']);
  });
});

describe('a legacy invoice (no types)', () => {
  it('loads as before and saves with the type its rate gives', () => {
    const detail: InvoiceDetail = { id: 'inv-1', status: 'draft', invoice_number: 'INV-1', invoice_date: DATE, tax_rate: '15', items: [
      { description: 'A', quantity: '2', unit_price: '100', amount: '180', tax_rate: '15' },
    ] };
    const { v, lines, body } = roundTrip(detail);
    expect(v).toEqual({ mode: 'exclusive', headerRate: 15, date: DATE });
    expect(lines[0]).toMatchObject({ unitPrice: 100, discount: 10 });
    expect(body.items[0]).toMatchObject({ unitPrice: 100, discount: 10, vatType: 'standard' });
    expect(body.amountsAre).toBe('exclusive');
  });
});

describe('an inclusive invoice stored at 0% (#1701 review)', () => {
  const detail = stored([{ description: 'Rent', quantity: 1, unitPrice: 200, discount: 0, vatType: 'exempt' }], 'inclusive');

  it('reloads inclusive with its exempt line exempt; a line added takes the customer\'s default chain, shown on the line', () => {
    expect(detail.tax_rate).toBe('0');
    const v = vatAtLoad(detail);
    expect(v).toEqual({ mode: 'inclusive', headerRate: 0, date: DATE });
    const added = { key: 'n', description: 'New', quantity: 1, unitPrice: 115, discount: 0, glAccountId: '', projectId: '', cc2Id: '', buId: '' };
    const lines = [...linesFromStoredItems(detail.items ?? [], '', v), added];
    expect(invoicePutBody('inv-1', { form: FORM, lines, taxMode: v.mode, customerVat: 'standard' }).items.map((i) => i.vatType)).toEqual(['exempt', 'standard']);
    expect(shownTotals(lines, v.mode, 'standard')).toEqual({ subtotal: 300, tax: 15, total: 315 });
    // A zero-rated customer's new line goes zero-rated, as the server's default chain types it.
    expect(invoicePutBody('inv-1', { form: FORM, lines, taxMode: v.mode, customerVat: 'zero' }).items.map((i) => i.vatType)).toEqual(['exempt', 'zero_rated']);
    expect(shownTotals(lines, v.mode, 'zero')).toEqual({ subtotal: 315, tax: 0, total: 315 });
  });

  it('an exclusive invoice at 0% loads as Excluding VAT (VAT-free lines are typed per line now)', () => {
    expect(vatAtLoad({ tax_rate: '0', amounts_are: null })).toEqual({ mode: 'exclusive', headerRate: 0 });
  });
});

describe('round 11 MAJOR 1: a LEGACY mixed-rate draft keeps each line\'s effective type when loaded', () => {
  const legacy = (lines: { description: string; amount: number; tax_rate: number | null; tax_amount?: number | null }[], headerRate = 15): InvoiceDetail => ({
    id: 'inv-1', status: 'draft', invoice_number: 'INV-1', invoice_date: DATE, tax_rate: String(headerRate), amounts_are: null,
    total_amount: String(lines.reduce((s, l) => s + l.amount + (l.tax_amount ?? l.amount * (l.tax_rate ?? headerRate) / 100), 0)),
    items: lines.map((l) => ({ description: l.description, quantity: '1', unit_price: String(l.amount), amount: String(l.amount),
      tax_rate: l.tax_rate === null ? null : String(l.tax_rate), tax_amount: l.tax_amount ?? null, vat_type: null })),
  });
  it('R100 at 15% + R100 at 0%: R215 loaded and saved (it repriced to R230 at the header rate), each line typed by its own rate', () => {
    const d = legacy([{ description: 'Std', amount: 100, tax_rate: 15 }, { description: 'Zero', amount: 100, tax_rate: 0 }]);
    const v = vatAtLoad(d);
    const lines = linesFromStoredItems(d.items ?? [], '', v);
    expect(shownTotals(lines, v.mode).total).toBe(215);
    const body = invoicePutBody('inv-1', { form: FORM, lines, taxMode: v.mode });
    expect(body.items.map((i) => [i.unitPrice, i.vatType])).toEqual([[100, 'standard'], [100, 'zero_rated']]);
  });
  it('a line with no rate of its own reads it from its tax_amount; one with neither, from the header', () => {
    const d = legacy([{ description: 'A', amount: 100, tax_rate: null, tax_amount: 0 }, { description: 'B', amount: 100, tax_rate: null, tax_amount: 15 },
      { description: 'C', amount: 100, tax_rate: null }]);
    const lines = linesFromStoredItems(d.items ?? [], '', vatAtLoad(d));
    expect(lines.map((l) => l.vatType)).toEqual(['zero_rated', 'standard', 'standard']);
  });
  it('a legacy rate that is neither the standard rate on the date nor 0 (14%) under a 14% header has no type yet, so the save holds and asks', async () => {
    const d = legacy([{ description: 'Old', amount: 100, tax_rate: 14 }], 14);
    const lines = linesFromStoredItems(d.items ?? [], '', vatAtLoad(d));
    expect(lines.map((l) => l.vatType)).toEqual([null]);
    const { saveProblem } = await import('@/components/accounting/customer-invoices/invoicePutBody');
    expect(saveProblem({ form: FORM, lines, taxMode: 'exclusive' }, {})).toBe('Choose a VAT type for "Old"');
  });
  it('a 14% legacy line under a standard header takes the header\'s type (the stale-priced hold shows both figures)', () => {
    const d = legacy([{ description: 'Old', amount: 100, tax_rate: 14 }], 15);
    expect(linesFromStoredItems(d.items ?? [], '', vatAtLoad(d)).map((l) => l.vatType)).toEqual(['standard']);
  });
  it('round 12: a legacy invoice with a header rate of 0 and a line at the column default 15.00 follows the header (R100, not R115)', () => {
    const d = legacy([{ description: 'L', amount: 100, tax_rate: 15 }], 0);
    const v = vatAtLoad(d);
    expect(v.mode).toBe('exclusive');
    const lines = linesFromStoredItems(d.items ?? [], '', v);
    expect(lines[0]).toMatchObject({ vatFallback: 'zero_rated' });
    expect(lines[0]!.vatType).toBeUndefined();
    expect(shownTotals(lines, v.mode, 'standard').total).toBe(100);
    expect(invoicePutBody('inv-1', { form: FORM, lines, taxMode: v.mode, customerVat: 'standard' }).items.map((i) => i.vatType)).toEqual(['zero_rated']);
    // An exempt customer's no-VAT draft goes exempt, as the old form typed it at rate 0.
    expect(invoicePutBody('inv-1', { form: FORM, lines, taxMode: v.mode, customerVat: 'exempt' }).items.map((i) => i.vatType)).toEqual(['exempt']);
  });
});
