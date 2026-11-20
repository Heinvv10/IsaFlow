/**
 * The invoice pages' VAT until the line-level screen (formVat): the form's one rate types every line as the server's
 * legacy header contract does, the summary is the shared per-line pricing (the figure create stores), and a company not
 * registered for VAT prices and sends no VAT.
 */
import { describe, expect, it } from 'vitest';
import { formLineType, formTotals, vatModeFor } from '@/components/accounting/customer-invoices/formVat';
import { priceInvoiceVat } from '@/modules/accounting/services/ar/invoiceLineVatPricing';

const l = (quantity: number, unitPrice: number, discount = 0) => ({ quantity, unitPrice, discount });

describe('formLineType', () => {
  it('the standard rate on the date is standard, 0 is zero_rated, anything else none', () => {
    expect(formLineType(15, '2026-11-20')).toBe('standard');
    expect(formLineType(14, '2018-03-31')).toBe('standard');
    expect(formLineType(0, '2026-11-20')).toBe('zero_rated');
    expect(formLineType(14, '2026-11-20')).toBeNull();
    expect(formLineType(15, '')).toBeNull();
  });
});

describe('formTotals', () => {
  it('is the per-line pricing create stores: seven lines of 14.29 carry VAT 14.98', () => {
    const lines = Array.from({ length: 7 }, () => l(1, 14.29));
    expect(formTotals(lines, 15, 'exclusive', '2026-11-20')).toEqual({ subtotal: 100.03, tax: 14.98, total: 115.01 });
    const stored = priceInvoiceVat(lines, { typed: true, types: Array(7).fill('standard') }, '2026-11-20', 'exclusive').header;
    expect(formTotals(lines, 15, 'exclusive', '2026-11-20')).toEqual({ subtotal: stored.subtotal, tax: stored.tax, total: stored.total });
  });
  it('a rate the server refuses is shown as typed, VAT on the subtotal', () => {
    expect(formTotals([l(1, 100)], 14, 'exclusive', '2026-11-20')).toEqual({ subtotal: 100, tax: 14, total: 114 });
  });
  it('a field mid-edit prices as 0', () => {
    expect(formTotals([l(Number.NaN, 5), l(2, 50)], 15, 'exclusive', '2026-11-20')).toEqual({ subtotal: 100, tax: 15, total: 115 });
  });
});

describe('vatModeFor', () => {
  it('a company not registered for VAT prices at no VAT whatever is picked', () => {
    expect(vatModeFor(false, 'exclusive')).toBe('none');
    expect(vatModeFor(false, 'inclusive')).toBe('none');
    expect(vatModeFor(true, 'inclusive')).toBe('inclusive');
  });
});

describe('an exempt customer at no VAT (#1701 round 1: the pages type its lines as the server does)', () => {
  const form = { clientId: 'c-1', invoiceDate: '2026-11-20', dueDate: '', billingPeriodStart: '', billingPeriodEnd: '', taxRate: 15,
    notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' };
  const pageLine = (description: string) => ({ key: description, description, quantity: 1, unitPrice: 100, discount: 0,
    glAccountId: '', projectId: '', cc2Id: '', buId: '', incomeType: 'other' });

  it('new page: an exempt customer sends vatType exempt per line and no header rate; a zero-rated one the legacy header 0', async () => {
    const { createBody } = await import('@/components/accounting/customer-invoices/newInvoiceBody');
    const exempt = createBody(form, [pageLine('A')], 'none', 0, {}, 'exempt');
    if (!('body' in exempt)) throw new Error(exempt.problem);
    expect('taxRate' in exempt.body).toBe(false);
    expect(exempt.body.items.map((i) => i.vatType)).toEqual(['exempt']);
    const zero = createBody(form, [pageLine('A')], 'none', 0, {}, 'zero');
    if (!('body' in zero)) throw new Error(zero.problem);
    expect(zero.body.taxRate).toBe(0);
    expect('vatType' in zero.body.items[0]!).toBe(false);
    const standard = createBody(form, [pageLine('A')], 'exclusive', 15, {}, 'exempt'); // the user chose VAT: their rate stands
    if (!('body' in standard)) throw new Error(standard.problem);
    expect(standard.body.taxRate).toBe(15);
  });

  it('edit page: an exempt customer at no VAT sends exempt lines; a zero-rated one zero_rated', async () => {
    const { invoicePutBody } = await import('@/components/accounting/customer-invoices/invoicePutBody');
    expect(invoicePutBody('i', { form, lines: [pageLine('A')], taxMode: 'none', customerVat: 'Exempt' }).items.map((i) => i.vatType)).toEqual(['exempt']);
    expect(invoicePutBody('i', { form, lines: [pageLine('A')], taxMode: 'none', customerVat: 'zero' }).items.map((i) => i.vatType)).toEqual(['zero_rated']);
  });

  it('a rate that gives no type holds Create and Save, saying why', async () => {
    const { createBody } = await import('@/components/accounting/customer-invoices/newInvoiceBody');
    const { saveProblem } = await import('@/components/accounting/customer-invoices/invoicePutBody');
    const msg = 'Check the VAT rate: it is the standard rate on the invoice date, or 0';
    expect(createBody({ ...form, taxRate: 14 }, [pageLine('A')], 'exclusive', 14, {})).toEqual({ problem: msg });
    expect(saveProblem({ form: { ...form, taxRate: 14 }, lines: [pageLine('A')], taxMode: 'exclusive' }, {})).toBe(msg);
    expect(saveProblem({ form, lines: [pageLine('A')], taxMode: 'exclusive' }, {})).toBeNull();
  });
});
