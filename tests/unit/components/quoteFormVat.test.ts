/**
 * The New Quote modal's body (quoteFormVat): per-line VAT types and the invoice form's holds. Every line of a VAT
 * mode names its vatType and no legacy taxRate (No VAT sends taxRate 0 and no type) (review round 2 LOW 3: one rate on every line retyped a mixed quote's exempt lines).
 * The modal only creates, so no line carries an id (UI review L8).
 */
import { describe, expect, it } from 'vitest';
import { quoteBody, type QuoteFormLine } from '@/components/accounting/customer-quotes/quoteFormVat';
import { lineVatTypes } from '@/components/accounting/customer-invoices/formVat';

const form = { clientId: 'c1', customerName: 'Acme', quoteDate: '2026-11-11', expiryDate: '', notes: '' };
const line = (o: Partial<QuoteFormLine>): QuoteFormLine => ({ key: 'k', description: 'Widget', quantity: 1, unitPrice: 100, ...o });
const body = (lines: QuoteFormLine[], mode: 'exclusive' | 'inclusive' | 'none' = 'exclusive', customerVat: string | null = null) =>
  quoteBody(form, lines, mode, lineVatTypes(lines, customerVat));

describe('quoteBody', () => {
  it('a mixed typed quote: each line its own vatType, no taxRate and no id', () => {
    const b = body([line({ vatType: 'standard' }), line({ key: 'k2', description: 'Rent', vatType: 'exempt' })]);
    expect(b).toEqual({ body: { ...form, amountsAre: 'exclusive', lines: [
      { description: 'Widget', quantity: 1, unitPrice: 100, lineNo: 1, vatType: 'standard' },
      { description: 'Rent', quantity: 1, unitPrice: 100, lineNo: 2, vatType: 'exempt' },
    ] } });
    if ('body' in b) expect(b.body.lines.some((l) => 'taxRate' in l)).toBe(false);
  });

  it('a line with no type of its own sends the customer\'s default chain', () => {
    const b = body([line({})], 'exclusive', 'exempt');
    expect('body' in b && b.body.lines[0]!.vatType).toBe('exempt');
  });

  it('inclusive sends the ex-VAT price of a rated line with amountsAre exclusive; an exempt line as typed', () => {
    const b = body([line({ unitPrice: 115, vatType: 'standard' }), line({ key: 'k2', description: 'Rent', unitPrice: 115, vatType: 'exempt' })], 'inclusive');
    expect('body' in b && [b.body.amountsAre, ...b.body.lines.map((l) => l.unitPrice)]).toEqual(['exclusive', 100, 115]);
  });

  it('No VAT sends untyped lines at an EXPLICIT taxRate 0 (never the server\'s default chain), exclusive', () => {
    const b = body([line({ vatType: 'standard' }), line({ key: 'k2', description: 'Two', unitPrice: 50 })], 'none');
    expect('body' in b && b.body).toMatchObject({ amountsAre: 'exclusive', lines: [
      { description: 'Widget', unitPrice: 100, lineNo: 1, taxRate: 0 }, { description: 'Two', unitPrice: 50, lineNo: 2, taxRate: 0 }] });
    expect('body' in b && b.body.lines.some((l) => 'vatType' in l)).toBe(false);
  });

  it('blank lines are dropped and the rest keep their place on the form (lineNo)', () => {
    const b = body([line({ description: '' , unitPrice: 0 }), line({ key: 'k2' })]);
    expect('body' in b && b.body.lines.map((l) => l.lineNo)).toEqual([2]);
  });

  it('holds: a customer, a described line, a price of at least a cent, a VAT type, VAT that does not round to nothing', () => {
    expect(quoteBody({ ...form, clientId: '' }, [line({})], 'exclusive', ['standard'])).toEqual({ problem: 'Select a customer' });
    expect(body([line({ description: '', unitPrice: 0 })])).toEqual({ problem: 'Add at least one line item' });
    expect(body([line({ description: '' })])).toEqual({ problem: 'Line 1 needs a description' });
    expect(body([line({ unitPrice: 0.001 })])).toEqual({ problem: expect.stringMatching(/comes to under a cent/) });
    expect(body([line({ vatType: null })])).toEqual({ problem: 'Choose a VAT type for "Widget"' });
    expect(body([line({ unitPrice: 0.03, vatType: 'standard' })])).toEqual({ problem: expect.stringMatching(/rounds to nothing/) });
    expect(body([line({ vatType: null })], 'none')).toMatchObject({ body: expect.anything() });
  });

  it('M1: a quote date is required (the server would price on today), and for a VAT vendor one with a rate', () => {
    expect(quoteBody({ ...form, quoteDate: '' }, [line({})], 'exclusive', ['standard'])).toEqual({ problem: 'Enter the quote date' });
    expect(quoteBody({ ...form, quoteDate: '' }, [line({})], 'none', [null])).toEqual({ problem: 'Enter the quote date' });
    expect(quoteBody({ ...form, quoteDate: '1990-01-01' }, [line({})], 'exclusive', ['standard']))
      .toEqual({ problem: 'The quote date is before VAT began: enter a later date' });
    expect(quoteBody({ ...form, quoteDate: '1990-01-01' }, [line({})], 'none', [null])).toMatchObject({ body: expect.anything() });
  });

  it('L2: spaces alone are no description, for every hold and for what is sent', () => {
    const b = body([line({ description: '   ', unitPrice: 0 }), line({ key: 'k2' })]);
    expect('body' in b && b.body.lines.map((l) => [l.description, l.lineNo])).toEqual([['Widget', 2]]);
    expect(body([line({ description: '  ', unitPrice: 0 })])).toEqual({ problem: 'Add at least one line item' });
    expect(body([line({ description: ' ', unitPrice: 0.001 })])).toEqual({ problem: 'Line 1 needs a description' });
  });

  it('L13: a priced line without a description is held, not silently dropped (a blank line still is dropped)', () => {
    expect(body([line({}), line({ key: 'k2', description: '  ', unitPrice: 50 })])).toEqual({ problem: 'Line 2 needs a description' });
    expect(body([line({}), line({ key: 'k2', description: '', unitPrice: 0 })])).toMatchObject({ body: expect.anything() });
  });
});
