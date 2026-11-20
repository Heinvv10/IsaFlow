/**
 * The request contract of per-line VAT on a customer invoice (invoiceLineVatTypes): every row of it, each refusal, the
 * default chain's order, the non-vendor rule, and the draft edit's kept type. Pure.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultLineVatType, InvoiceLineVatRefusal, InvoiceVatNotRegisteredRefusal, resolveInvoiceLineVat,
  storedLineVatType, type ResolveLineVatInput,
} from '@/modules/accounting/services/ar/invoiceLineVatTypes';

const NONE = { customer: null, item: null, account: null };
const base = (over: Partial<ResolveLineVatInput> = {}): ResolveLineVatInput => ({
  registered: true, invoiceDate: '2026-11-20', headerTaxRate: undefined,
  lines: [{}], defaults: [NONE], ...over,
});
const types = (over: Partial<ResolveLineVatInput>) => {
  const r = resolveInvoiceLineVat(base(over));
  if (!r.typed) throw new Error('expected typed');
  return r.types;
};
const refusal = (over: Partial<ResolveLineVatInput>): Error => {
  try {
    resolveInvoiceLineVat(base(over));
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a refusal');
};

describe('a line that names its VAT type', () => {
  it.each(['standard', 'zero_rated', 'exempt'] as const)('%s is taken as given', (t) => {
    expect(types({ lines: [{ vatType: t }] })).toEqual([t]);
  });
  it('the legacy spelling "zero" reads as zero_rated', () => {
    expect(types({ lines: [{ vatType: 'zero' }] })).toEqual(['zero_rated']);
  });
  it('beats every default', () => {
    expect(types({ lines: [{ vatType: 'standard' }], defaults: [{ customer: 'exempt', item: 'zero', account: 'exempt' }] }))
      .toEqual(['standard']);
  });
  it.each([
    ['an unknown word', 'luxury', /^items\[1\]: "luxury" is not a VAT type/],
    ['a number', 15, /^items\[1\]: 15 is not a VAT type/],
    ['a ledger type no document line takes', 'reverse_charge', /^items\[1\] cannot be reverse_charge: a customer invoice line is standard, zero_rated or exempt$/],
    ['no_vat (the open point: not a document line type)', 'no_vat', /^items\[1\] cannot be no_vat/],
    ['the legacy "none" (no_vat)', 'none', /^items\[1\] cannot be no_vat/],
  ])('%s is refused naming the line', (_l, v, message) => {
    const err = refusal({ lines: [{}, { vatType: v }], defaults: [NONE, NONE] });
    expect(err).toBeInstanceOf(InvoiceLineVatRefusal);
    expect((err as InvoiceLineVatRefusal).code).toBe('INVOICE_LINE_VAT_REFUSED');
    expect(err.message).toMatch(message);
  });
});

describe('the legacy header taxRate', () => {
  it('the standard rate on the invoice date types every line standard', () => {
    expect(types({ headerTaxRate: 15, lines: [{}, {}], defaults: [{ ...NONE, item: 'exempt' }, NONE] })).toEqual(['standard', 'standard']);
  });
  it('0 types every line zero_rated (how a zero-VAT invoice has always been reported)', () => {
    expect(types({ headerTaxRate: 0, lines: [{}, {}], defaults: [NONE, { ...NONE, customer: 'exempt' }] })).toEqual(['zero_rated', 'zero_rated']);
  });
  it('the standard rate is the one on the invoice date: 14 before 1 April 2018', () => {
    expect(types({ headerTaxRate: 14, invoiceDate: '2018-03-31' })).toEqual(['standard']);
  });
  it.each([14, 15.5, 100, -1])('%s on a 2026 invoice is refused: the rate comes from the VAT type', (rate) => {
    const err = refusal({ headerTaxRate: rate });
    expect(err).toBeInstanceOf(InvoiceLineVatRefusal);
    expect(err.message).toBe(`taxRate ${rate} is neither the VAT rate on 2026-11-20 (15%) nor 0: the rate comes from each line's VAT type `
      + '(vatType: standard, zero_rated or exempt). Leave taxRate out and give each line its vatType.');
  });
  it('15 on a 2018-03-31 invoice is refused (14% then)', () => {
    expect(refusal({ headerTaxRate: 15, invoiceDate: '2018-03-31' }).message).toMatch(/^taxRate 15 is neither the VAT rate on 2018-03-31 \(14%\)/);
  });
  it.each([['a string', '15'], ['NaN', Number.NaN], ['an object', {}]])('%s is refused', (_l, v) => {
    expect(refusal({ headerTaxRate: v }).message).toBe('taxRate must be a number');
  });
  it('together with ANY line vatType is refused (no caller sends both)', () => {
    const err = refusal({ headerTaxRate: 15, lines: [{}, { vatType: 'standard' }], defaults: [NONE, NONE] });
    expect(err).toBeInstanceOf(InvoiceLineVatRefusal);
    expect(err.message).toBe('Send a vatType on each line or the invoice\'s taxRate, not both: the rate comes from the VAT type.');
  });
  it('null is not given', () => {
    expect(types({ headerTaxRate: null, lines: [{ vatType: 'exempt' }] })).toEqual(['exempt']);
  });
});

describe('the default chain (no type, no header rate)', () => {
  it.each([
    ['the customer zero-rated beats the item and the account', { customer: 'zero', item: 'exempt', account: 'exempt' }, 'zero_rated'],
    ['the customer exempt', { customer: 'Exempt ', item: 'standard', account: 'standard' }, 'exempt'],
    ['a standard customer is no opinion: the item decides', { customer: 'standard', item: 'exempt', account: 'zero_rated' }, 'exempt'],
    ['the item zero', { customer: null, item: 'zero', account: 'exempt' }, 'zero_rated'],
    ['the item standard beats the account', { customer: null, item: 'standard', account: 'exempt' }, 'standard'],
    ['no item: the account exempt', { customer: null, item: null, account: 'exempt' }, 'exempt'],
    ['the account "none" (the chart default) is no opinion', { customer: null, item: null, account: 'none' }, 'standard'],
    ['an account type no document line takes is no opinion', { customer: null, item: null, account: 'capital_goods' }, 'standard'],
    ['an unknown customer text is no opinion', { customer: 'weird', item: null, account: null }, 'standard'],
    ['nothing at all: standard', NONE, 'standard'],
  ])('%s', (_l, opinions, expected) => {
    expect(defaultLineVatType(opinions)).toBe(expected);
    expect(types({ defaults: [opinions] })).toEqual([expected]);
  });
});

describe('the draft edit: a line keeps the type of the identical stored line', () => {
  it('kept when the line names none and no header rate is sent', () => {
    expect(types({ lines: [{}, {}], kept: ['exempt', null], defaults: [NONE, { ...NONE, item: 'zero' }] })).toEqual(['exempt', 'zero_rated']);
  });
  it('a line naming a type beats the kept one', () => {
    expect(types({ lines: [{ vatType: 'standard' }], kept: ['exempt'] })).toEqual(['standard']);
  });
  it('a legacy header rate keeps a stored type of the same rate, and re-types one of another', () => {
    expect(types({ headerTaxRate: 0, lines: [{}, {}, {}], kept: ['exempt', 'standard', null], defaults: [NONE, NONE, NONE] }))
      .toEqual(['exempt', 'zero_rated', 'zero_rated']);
    expect(types({ headerTaxRate: 15, lines: [{}, {}], kept: ['standard', 'exempt'], defaults: [NONE, NONE] }))
      .toEqual(['standard', 'standard']);
  });
  it('a stored legacy (NULL) type reads as standard when its rate is above zero, else zero_rated', () => {
    expect(storedLineVatType(null, 15)).toBe('standard');
    expect(storedLineVatType(null, 14)).toBe('standard');
    expect(storedLineVatType(null, 0)).toBe('zero_rated');
    expect(storedLineVatType(null, null)).toBe('zero_rated');
    expect(storedLineVatType('exempt', 15)).toBe('exempt');
    // A stored type no document line may carry is not kept: the line takes the default chain.
    expect(storedLineVatType('reverse_charge', 0)).toBeNull();
  });
});

describe('the per-line taxRate (the edit schema)', () => {
  it('accepted when it is its type\'s rate on the date', () => {
    expect(types({ lines: [{ vatType: 'standard', taxRate: 15 }, { vatType: 'exempt', taxRate: 0 }], defaults: [NONE, NONE] }))
      .toEqual(['standard', 'exempt']);
    expect(types({ headerTaxRate: 15, lines: [{ taxRate: 15 }] })).toEqual(['standard']);
  });
  it.each([
    ['a standard line at 0', { vatType: 'standard', taxRate: 0 }, 'items[0]: taxRate 0 is not the rate of its VAT type standard (15% on 2026-11-20). Leave taxRate out: the rate comes from the type.'],
    ['an exempt line at 15', { vatType: 'exempt', taxRate: 15 }, 'items[0]: taxRate 15 is not the rate of its VAT type exempt (0% on 2026-11-20). Leave taxRate out: the rate comes from the type.'],
    ['a defaulted standard line at 14', { taxRate: 14 }, 'items[0]: taxRate 14 is not the rate of its VAT type standard (15% on 2026-11-20). Leave taxRate out: the rate comes from the type.'],
  ])('%s is refused', (_l, line, message) => {
    const err = refusal({ lines: [line] });
    expect(err).toBeInstanceOf(InvoiceLineVatRefusal);
    expect(err.message).toBe(message);
  });
});

describe('a company that is not registered for VAT', () => {
  it('writes every line untyped, whatever the defaults say', () => {
    expect(resolveInvoiceLineVat(base({ registered: false, lines: [{}, {}], defaults: [NONE, { ...NONE, item: 'standard' }] })))
      .toEqual({ typed: false });
  });
  it('a header taxRate of 0 is accepted: untyped', () => {
    expect(resolveInvoiceLineVat(base({ registered: false, headerTaxRate: 0 }))).toEqual({ typed: false });
  });
  it('zero_rated and exempt line types are accepted and written untyped (there is no VAT either way)', () => {
    expect(resolveInvoiceLineVat(base({ registered: false, lines: [{ vatType: 'exempt' }, { vatType: 'zero_rated' }], defaults: [NONE, NONE] })))
      .toEqual({ typed: false });
  });
  it.each([
    ['a header taxRate above 0', { headerTaxRate: 15 }, 'This company is not registered for VAT, so its invoices carry no VAT: leave taxRate out (or send 0).'],
    ['a standard line', { lines: [{}, { vatType: 'standard' }], defaults: [NONE, NONE] },
      'items[1] is standard-rated, but this company is not registered for VAT, so its invoices carry no VAT: leave vatType out.'],
    ['a line taxRate above 0', { lines: [{ taxRate: 15 }] },
      'items[0] has taxRate 15, but this company is not registered for VAT, so its invoices carry no VAT: leave taxRate out.'],
  ])('%s is refused with the not-registered message', (_l, over, message) => {
    const err = refusal({ registered: false, ...over });
    expect(err).toBeInstanceOf(InvoiceVatNotRegisteredRefusal);
    expect((err as InvoiceVatNotRegisteredRefusal).code).toBe('INVOICE_VAT_NOT_REGISTERED');
    expect(err.message).toBe(message);
  });
  it('an unknown type is still refused as unknown', () => {
    expect(refusal({ registered: false, lines: [{ vatType: 'luxury' }] })).toBeInstanceOf(InvoiceLineVatRefusal);
  });
  it('both inputs are still refused', () => {
    expect(refusal({ registered: false, headerTaxRate: 0, lines: [{ vatType: 'exempt' }] }).message).toMatch(/not both/);
  });
  it('needs no VAT rate for its date', () => {
    expect(resolveInvoiceLineVat(base({ registered: false, invoiceDate: '1980-01-01' }))).toEqual({ typed: false });
  });
});

describe('a date no VAT rate is known for', () => {
  it('is refused before VAT began', () => {
    const err = refusal({ invoiceDate: '1990-01-01' });
    expect(err).toBeInstanceOf(InvoiceLineVatRefusal);
    expect(err.message).toBe('The invoice date has no VAT rate: 1990-01-01 is before VAT began (1991-09-30)');
  });
});
