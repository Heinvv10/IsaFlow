/**
 * The invoice pages' per-line VAT (formVat): each line its own type (picked, scanned, loaded), else the server's default
 * chain for the customer (invoiceLineVatTypes.defaultLineVatType); the totals are the shared per-line pricing (the figure
 * create stores); each body sends a vatType per line and no header rate; a company not registered for VAT prices and
 * sends no VAT.
 */
import { describe, expect, it } from 'vitest';
import {
  customerLineVatType, formTotals, formVatByType, fromKeptDraft, lineVatType, lineVatTypes, typeForRate, vatModeFor, vatTypeProblem,
} from '@/components/accounting/customer-invoices/formVat';
import { switchTaxMode } from '@/components/accounting/customer-invoices/taxModeSwitch';
import type { TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { priceInvoiceVat } from '@/modules/accounting/services/ar/invoiceLineVatPricing';
import { defaultLineVatType } from '@/modules/accounting/services/ar/invoiceLineVatTypes';

const D = '2026-11-20';
const l = (quantity: number, unitPrice: number, discount = 0) => ({ quantity, unitPrice, discount });

describe('typeForRate', () => {
  it('the standard rate on the date is standard, 0 is zero_rated, anything else none', () => {
    expect(typeForRate(15, D)).toBe('standard');
    expect(typeForRate(14, '2018-03-31')).toBe('standard');
    expect(typeForRate(0, D)).toBe('zero_rated');
    expect(typeForRate(14, D)).toBeNull();
    expect(typeForRate(15, '')).toBeNull();
  });
});

describe('a line\'s VAT type', () => {
  it('its own wins; null is none yet; absent follows the customer\'s default chain, as the server types it', () => {
    expect(lineVatType({ vatType: 'exempt' }, 'standard')).toBe('exempt');
    expect(lineVatType({ vatType: null }, 'exempt')).toBeNull();
    for (const customer of ['zero', 'Zero', ' EXEMPT ', 'exempt', 'standard', null, 'something a script wrote']) {
      expect(lineVatType({}, customer)).toBe(defaultLineVatType({ customer, item: null }));
    }
    expect(lineVatTypes([{}, { vatType: 'standard' }], 'zero')).toEqual(['zero_rated', 'standard']);
  });
  it('a legacy no-VAT line falls back to zero-rated, not standard; an exempt customer\'s goes exempt', () => {
    expect(lineVatType({ vatFallback: 'zero_rated' }, 'standard')).toBe('zero_rated');
    expect(lineVatType({ vatFallback: 'zero_rated' }, 'exempt')).toBe('exempt');
    expect(customerLineVatType(null)).toBe('standard');
  });
  it('a stored type the platform list does not offer (reverse_charge) is none yet, never standard', () => {
    expect(lineVatType({ vatType: 'reverse_charge' }, 'standard')).toBeNull();
    expect(lineVatType({ vatType: 'zero' })).toBe('zero_rated'); // the legacy spelling, as the server reads it
  });
});

describe('formTotals', () => {
  it('is the per-line pricing create stores: seven lines of 14.29 carry VAT 14.98', () => {
    const lines = Array.from({ length: 7 }, () => l(1, 14.29));
    const types = lines.map(() => 'standard' as const);
    expect(formTotals(lines, types, 'exclusive', D)).toEqual({ subtotal: 100.03, tax: 14.98, total: 115.01 });
    const stored = priceInvoiceVat(lines, { typed: true, types }, D, 'exclusive').header;
    expect(formTotals(lines, types, 'exclusive', D)).toEqual({ subtotal: stored.subtotal, tax: stored.tax, total: stored.total });
  });
  it('a mixed invoice prices each line at its own type: R1000 standard + R300 zero + R200 exempt = R1650', () => {
    const lines = [l(1, 1000), l(1, 300), l(1, 200)];
    const types = ['standard', 'zero_rated', 'exempt'] as const;
    expect(formTotals(lines, types, 'exclusive', D)).toEqual({ subtotal: 1500, tax: 150, total: 1650 });
    const stored = priceInvoiceVat(lines, { typed: true, types: [...types] }, D, 'exclusive').header;
    expect(formTotals(lines, types, 'exclusive', D)).toEqual({ subtotal: stored.subtotal, tax: stored.tax, total: stored.total });
    expect(formVatByType(lines, types, 'exclusive', D)).toEqual([
      { type: 'standard', net: 1000, vat: 150 }, { type: 'zero_rated', net: 300, vat: 0 }, { type: 'exempt', net: 200, vat: 0 },
    ]);
  });
  it('a blank line adds no row of its own to the breakdown; with no priced line every line\'s type shows', () => {
    expect(formVatByType([l(1, 500), l(1, 0)], ['standard', 'exempt'], 'exclusive', D)).toEqual([{ type: 'standard', net: 500, vat: 75 }]);
    expect(formVatByType([l(1, 0)], ['exempt'], 'exclusive', D)).toEqual([{ type: 'exempt', net: 0, vat: 0 }]);
  });
  it('the breakdown sums to the totals, inclusive too', () => {
    const lines = [l(3, 33.33, 5), l(1, 115), l(2, 49.99)];
    const types = ['standard', 'exempt', 'standard'] as const;
    const t = formTotals(lines, types, 'inclusive', D);
    const by = formVatByType(lines, types, 'inclusive', D);
    expect(by.map((b) => b.type)).toEqual(['standard', 'exempt']);
    expect(Math.round(by.reduce((s, b) => s + b.vat, 0) * 100)).toBe(Math.round(t.tax * 100));
    expect(Math.round(by.reduce((s, b) => s + b.net, 0) * 100)).toBe(Math.round(t.subtotal * 100));
  });
  it('a field mid-edit prices as 0; a line with no type yet previews with no VAT', () => {
    expect(formTotals([l(Number.NaN, 5), l(2, 50)], ['standard', 'standard'], 'exclusive', D)).toEqual({ subtotal: 100, tax: 15, total: 115 });
    expect(formTotals([l(1, 100)], [null], 'exclusive', D)).toEqual({ subtotal: 100, tax: 0, total: 100 });
  });
  it('No VAT (a company not registered) prices no VAT whatever the types say, and breaks nothing down', () => {
    expect(formTotals([l(1, 100)], ['standard'], 'none', D)).toEqual({ subtotal: 100, tax: 0, total: 100 });
    expect(formVatByType([l(1, 100)], ['standard'], 'none', D)).toEqual([]);
  });
});

describe('vatModeFor', () => {
  it('a company not registered for VAT prices at no VAT whatever is picked; a registered one never at No VAT', () => {
    expect(vatModeFor(false, 'exclusive')).toBe('none');
    expect(vatModeFor(false, 'inclusive')).toBe('none');
    expect(vatModeFor(true, 'inclusive')).toBe('inclusive');
    expect(vatModeFor(true, 'none')).toBe('exclusive');
  });
});

describe('vatTypeProblem', () => {
  it('names the first line with something in it and no type', () => {
    expect(vatTypeProblem([{ description: 'A', quantity: 1, unitPrice: 1 }, { description: 'Old', quantity: 1, unitPrice: 1 }], ['standard', null])).toBe('Choose a VAT type for "Old"');
    expect(vatTypeProblem([{ description: '', quantity: 1, unitPrice: 5 }], [null])).toBe('Choose a VAT type for line 1');
    expect(vatTypeProblem([{ description: '', quantity: 1, unitPrice: 0 }], [null])).toBeNull(); // an empty line adds nothing
  });
});

describe('the bodies (per-line vatType, no header rate)', () => {
  const form = { clientId: 'c-1', invoiceDate: D, dueDate: '', billingPeriodStart: '', billingPeriodEnd: '', notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' };
  const pageLine = (description: string, more: object = {}) => ({ key: description, description, quantity: 1, unitPrice: 100, discount: 0,
    glAccountId: '', projectId: '', cc2Id: '', buId: '', incomeType: 'other', ...more });

  it('new page: each line\'s type, no header rate; a non-vendor the legacy header 0 and untyped lines', async () => {
    const { createBody } = await import('@/components/accounting/customer-invoices/newInvoiceBody');
    const lines = [pageLine('A'), pageLine('B', { vatType: 'exempt' }), pageLine('C')];
    const mixed = createBody(form, lines, 'exclusive', lineVatTypes(lines, 'zero'), {});
    if (!('body' in mixed)) throw new Error(mixed.problem);
    expect('taxRate' in mixed.body).toBe(false);
    expect(mixed.body.items.map((i) => i.vatType)).toEqual(['zero_rated', 'exempt', 'zero_rated']);
    expect(mixed.body.items.every((i) => !('vatFallback' in i))).toBe(true);
    const none = createBody(form, lines, 'none', lineVatTypes(lines, 'zero'), {});
    if (!('body' in none)) throw new Error(none.problem);
    expect(none.body.taxRate).toBe(0);
    expect(none.body.items.some((i) => 'vatType' in i)).toBe(false);
  });

  it('edit page: each line\'s own type, else the customer\'s; a non-vendor the header 0', async () => {
    const { invoicePutBody } = await import('@/components/accounting/customer-invoices/invoicePutBody');
    const lines = [pageLine('A', { vatType: 'standard' }), pageLine('B'), pageLine('C', { vatFallback: 'zero_rated' })];
    const put = invoicePutBody('i', { form, lines, taxMode: 'exclusive', customerVat: 'Exempt' });
    expect('taxRate' in put).toBe(false);
    expect(put.items.map((i) => i.vatType)).toEqual(['standard', 'exempt', 'exempt']);
    expect(invoicePutBody('i', { form, lines, taxMode: 'exclusive', customerVat: 'standard' }).items.map((i) => i.vatType)).toEqual(['standard', 'standard', 'zero_rated']);
    const none = invoicePutBody('i', { form, lines, taxMode: 'none', customerVat: 'standard' });
    expect(none.taxRate).toBe(0);
    expect(none.items.some((i) => 'vatType' in i)).toBe(false);
  });

  it('a line with no type yet holds Create and Save, saying which', async () => {
    const { createBody } = await import('@/components/accounting/customer-invoices/newInvoiceBody');
    const { saveProblem } = await import('@/components/accounting/customer-invoices/invoicePutBody');
    const lines = [pageLine('A'), pageLine('Old', { vatType: null })];
    expect(createBody(form, lines, 'exclusive', lineVatTypes(lines), {})).toEqual({ problem: 'Choose a VAT type for "Old"' });
    expect(saveProblem({ form, lines, taxMode: 'exclusive' }, {})).toBe('Choose a VAT type for "Old"');
    expect(saveProblem({ form, lines, taxMode: 'none' }, {})).toBeNull(); // a non-vendor's lines carry no type
    expect(saveProblem({ form, lines: [pageLine('A')], taxMode: 'exclusive' }, {})).toBeNull();
  });
});

describe('fromKeptDraft (a draft kept on this device before per-line VAT)', () => {
  const kept = (taxRate: number, taxMode: TaxMode) => ({ form: { invoiceDate: D, taxRate }, lines: [{ quantity: 1, unitPrice: 100 }], taxMode });
  it('prices as it did: 15% standard, 0% or No VAT zero-rated by default, 14% none yet; the rate leaves the form', () => {
    expect(fromKeptDraft(kept(15, 'exclusive'))).toEqual({ form: { invoiceDate: D }, lines: [{ quantity: 1, unitPrice: 100, vatType: 'standard' }], taxMode: 'exclusive' });
    expect(fromKeptDraft(kept(15, 'none')).lines[0]).toEqual({ quantity: 1, unitPrice: 100, vatFallback: 'zero_rated' });
    expect(fromKeptDraft(kept(15, 'none')).taxMode).toBe('exclusive');
    expect(fromKeptDraft(kept(0, 'inclusive')).lines[0]).toMatchObject({ vatFallback: 'zero_rated' });
    expect(fromKeptDraft(kept(14, 'exclusive')).lines[0]).toMatchObject({ vatType: null });
  });
  it('a draft kept since is returned as it is', () => {
    const d = { form: { invoiceDate: D }, lines: [{ quantity: 1, unitPrice: 100, vatType: 'exempt' }], taxMode: 'inclusive' as TaxMode };
    expect(fromKeptDraft(d)).toEqual(d);
  });
});

describe('switchTaxMode (#1701 round 8: the "Amounts are" switch never reprices; the gate fixer\'s cases)', () => {
  const pl = (description: string, quantity: number, unitPrice: number) => ({ description, quantity, unitPrice, discount: 0 });
  type PL = ReturnType<typeof pl>;
  const change = (lines: PL[], from: TaxMode, to: TaxMode, types: ('standard' | 'zero_rated' | 'exempt' | null)[] = lines.map(() => 'standard'), registered = true, date = D) =>
    switchTaxMode(lines, { from, to, date, types, registered });
  const shown = (r: ReturnType<typeof change>) => {
    if ('problem' in r) throw new Error(r.problem);
    return r.lines.map((x) => x.unitPrice);
  };

  it('converts each line at its own type\'s rate: a mixed draft\'s exempt line keeps its price, and the total stays R215', () => {
    const mixed = [pl('Fee', 1, 100), pl('Rent', 1, 100)];
    const types = ['standard', 'exempt'] as ('standard' | 'exempt')[];
    const r = change(mixed, 'exclusive', 'inclusive', types);
    expect(shown(r)).toEqual([115, 100]);
    expect(formTotals(mixed, types, 'exclusive', D).total).toBe(215);
    if ('lines' in r) expect(formTotals(r.lines, types, 'inclusive', D).total).toBe(215);
    expect(shown(change([pl('Fee', 1, 115), pl('Rent', 1, 100)], 'inclusive', 'exclusive', types))).toEqual([100, 100]);
  });

  it('a zero-rated line converts nothing; a line with no type yet converts nothing either', () => {
    expect(shown(change([pl('A', 1, 100)], 'exclusive', 'inclusive', ['zero_rated']))).toEqual([100]);
    expect(shown(change([pl('A', 1, 100)], 'exclusive', 'inclusive', [null]))).toEqual([100]);
  });

  it('refuses a switch that would reprice a line: 1 000 x R0.03 excl is not R30.00 incl; R10.00 incl would be R10.01 excl', () => {
    expect(change([pl('Fee', 1, 100), pl('Screws', 1000, 0.03)], 'exclusive', 'inclusive')).toEqual({
      problem: expect.stringMatching(/^Switching to Including VAT would change "Screws" from R\s?34\.50 to R\s?30\.00/),
    });
    expect(change([pl('', 1, 10)], 'inclusive', 'exclusive')).toEqual({
      problem: expect.stringMatching(/^Switching to Excluding VAT would change line 1 from R\s?10\.00 to R\s?10\.01/),
    });
  });

  it('a date with no VAT rate yet refuses a switch a standard line would convert in; nothing changes', () => {
    expect(change([pl('A', 1, 100)], 'exclusive', 'inclusive', ['standard'], true, '')).toEqual({ problem: expect.stringMatching(/^Enter the invoice date/) });
    expect(shown(change([pl('A', 1, 100)], 'exclusive', 'inclusive', ['exempt'], true, ''))).toEqual([100]);
  });

  it('a company not registered for VAT converts nothing', () => {
    expect(change([pl('A', 1, 100)], vatModeFor(false, 'exclusive'), 'inclusive', ['standard'], false)).toEqual({ mode: 'none', lines: [pl('A', 1, 100)] });
  });

  it('a price mid-edit is left as it is and does not refuse the switch', () => {
    expect(shown(change([pl('A', 1, Number.NaN), pl('B', 1, 100)], 'exclusive', 'inclusive'))).toEqual([Number.NaN, 115]);
  });
});
