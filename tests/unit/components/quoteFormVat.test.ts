/**
 * The New Quote modal's body (quoteFormVat): per-line VAT types and the invoice form's holds. Every line names its
 * vatType and, when stored, its id, and no legacy taxRate (review round 2 LOW 3: one rate on every line retyped a
 * mixed quote's exempt lines).
 */
import { describe, expect, it } from 'vitest';
import { quoteBody, type QuoteFormLine } from '@/components/accounting/customer-quotes/quoteFormVat';
import { lineVatTypes } from '@/components/accounting/customer-invoices/formVat';

const form = { clientId: 'c1', customerName: 'Acme', quoteDate: '2026-11-11', expiryDate: '', notes: '' };
const line = (o: Partial<QuoteFormLine>): QuoteFormLine => ({ key: 'k', description: 'Widget', quantity: 1, unitPrice: 100, ...o });
const body = (lines: QuoteFormLine[], mode: 'exclusive' | 'inclusive' | 'none' = 'exclusive', customerVat: string | null = null) =>
  quoteBody(form, lines, mode, lineVatTypes(lines, customerVat));

describe('quoteBody', () => {
  it('a mixed typed quote: each line its stored id and its own vatType, no taxRate', () => {
    const b = body([line({ id: 'a', vatType: 'standard' }), line({ key: 'k2', id: 'b', description: 'Rent', vatType: 'exempt' })]);
    expect(b).toEqual({ body: { ...form, amountsAre: 'exclusive', lines: [
      { description: 'Widget', quantity: 1, unitPrice: 100, lineNo: 1, vatType: 'standard', id: 'a' },
      { description: 'Rent', quantity: 1, unitPrice: 100, lineNo: 2, vatType: 'exempt', id: 'b' },
    ] } });
    if ('body' in b) expect(b.body.lines.some((l) => 'taxRate' in l)).toBe(false);
  });

  it('a line with no type of its own sends the customer\'s default chain', () => {
    const b = body([line({})], 'exclusive', 'exempt');
    expect('body' in b && b.body.lines[0]!.vatType).toBe('exempt');
  });

  it('inclusive sends the price as entered with amountsAre inclusive', () => {
    const b = body([line({ unitPrice: 115, vatType: 'standard' })], 'inclusive');
    expect('body' in b && [b.body.amountsAre, b.body.lines[0]!.unitPrice]).toEqual(['inclusive', 115]);
  });

  it('a company not registered for VAT sends untyped lines and exclusive', () => {
    const b = body([line({ vatType: 'standard' })], 'none');
    expect('body' in b && b.body).toMatchObject({ amountsAre: 'exclusive', lines: [{ description: 'Widget', unitPrice: 100, lineNo: 1 }] });
    expect('body' in b && 'vatType' in b.body.lines[0]!).toBe(false);
  });

  it('blank lines are dropped and the rest keep their place on the form (lineNo)', () => {
    const b = body([line({ description: '' , unitPrice: 0 }), line({ key: 'k2' })]);
    expect('body' in b && b.body.lines.map((l) => l.lineNo)).toEqual([2]);
  });

  it('holds: a customer, a described line, a price of at least a cent, a VAT type, VAT that does not round to nothing', () => {
    expect(quoteBody({ ...form, clientId: '' }, [line({})], 'exclusive', ['standard'])).toEqual({ problem: 'Select a customer' });
    expect(body([line({ description: '' })])).toEqual({ problem: 'Add at least one line item' });
    expect(body([line({ unitPrice: 0.001 })])).toEqual({ problem: expect.stringMatching(/comes to under a cent/) });
    expect(body([line({ vatType: null })])).toEqual({ problem: 'Choose a VAT type for "Widget"' });
    expect(body([line({ unitPrice: 0.03, vatType: 'standard' })])).toEqual({ problem: expect.stringMatching(/rounds to nothing/) });
    expect(body([line({ vatType: null })], 'none')).toMatchObject({ body: expect.anything() });
  });
});
