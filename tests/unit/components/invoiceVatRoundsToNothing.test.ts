/**
 * Review of the line-level invoice form, finding 7: create and the draft edit refuse what approve would refuse
 * (invoiceLineVatDefaults.assertPricedPostable: standard lines whose VAT rounds to nothing, 1 x R0.03), but the form only
 * caught a price that rounds to nothing. So Create and Save Changes took a 400, and autosave sent a body the server
 * refused, which stops it until the next edit. The form now holds on the poster's own rule, before anything is sent.
 */
import { describe, expect, it } from 'vitest';
import { vatRoundsToNothingProblem, type LineVatTypeOrNone } from '@/components/accounting/customer-invoices/formVat';
import { autosaveProblem, saveProblem } from '@/components/accounting/customer-invoices/invoicePutBody';
import { createBody } from '@/components/accounting/customer-invoices/newInvoiceBody';
import type { InvoiceHeaderForm } from '@/components/accounting/customer-invoices/invoiceHeaderForm';
import type { TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { priceInvoiceVat } from '@/modules/accounting/services/ar/invoiceLineVatPricing';
import { typedLinesProblem } from '@/modules/accounting/services/ar/invoiceVatLegs';

const D = '2026-11-20';
const FORM: InvoiceHeaderForm = { clientId: 'c-1', invoiceDate: D, dueDate: '', billingPeriodStart: '', billingPeriodEnd: '', notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' };
const line = (quantity: number, unitPrice: number, vatType: string, description = 'Fee') => ({
  key: description + unitPrice, description, quantity, unitPrice, discount: 0, glAccountId: '', projectId: '', cc2Id: '', buId: '', vatType,
});

/** The server's verdict on the same lines: priced as create prices them, held to the poster's check. */
function serverRefuses(lines: { quantity: number; unitPrice: number }[], types: LineVatTypeOrNone[], mode: TaxMode): boolean {
  const amountsAre = mode === 'inclusive' ? 'inclusive' : 'exclusive';
  const p = priceInvoiceVat(lines, { typed: true, types: types.map((t) => t!) }, D, amountsAre);
  return typedLinesProblem(
    p.lines.map((l) => ({ amount: l.amount, taxAmount: l.taxAmount, vatType: l.vatType, glAccountId: null, projectId: null })),
    { subtotal: p.header.subtotal, taxAmount: p.header.tax, totalAmount: p.header.total, invoiceDate: D, amountsAre },
  ) !== null;
}

describe('vatRoundsToNothingProblem', () => {
  const cases: [string, { quantity: number; unitPrice: number }[], LineVatTypeOrNone[], TaxMode, boolean][] = [
    ['1 x R0.03 standard', [{ quantity: 1, unitPrice: 0.03 }], ['standard'], 'exclusive', true],
    ['1 x R0.03 standard, inclusive', [{ quantity: 1, unitPrice: 0.03 }], ['standard'], 'inclusive', true],
    ['1 x R0.04 standard (VAT R0.01)', [{ quantity: 1, unitPrice: 0.04 }], ['standard'], 'exclusive', false],
    ['two R0.03 standard lines: no VAT on either', [{ quantity: 1, unitPrice: 0.03 }, { quantity: 1, unitPrice: 0.03 }], ['standard', 'standard'], 'exclusive', true],
    ['R0.03 standard beside R100 standard: VAT on the type', [{ quantity: 1, unitPrice: 0.03 }, { quantity: 1, unitPrice: 100 }], ['standard', 'standard'], 'exclusive', false],
    ['R0.03 zero-rated: no VAT owed', [{ quantity: 1, unitPrice: 0.03 }], ['zero_rated'], 'exclusive', false],
    ['R0.03 exempt', [{ quantity: 1, unitPrice: 0.03 }], ['exempt'], 'exclusive', false],
    ['R100 standard', [{ quantity: 1, unitPrice: 100 }], ['standard'], 'exclusive', false],
  ];
  it.each(cases)('%s: refused exactly when the server refuses it', (_name, lines, types, mode, refused) => {
    expect(serverRefuses(lines, types, mode)).toBe(refused);
    const problem = vatRoundsToNothingProblem(lines, types, mode, D);
    expect(problem !== null).toBe(refused);
    if (refused) expect(problem).toMatch(/VAT on them rounds to nothing/);
  });
  it('a company not registered for VAT, or a date with no rate: nothing to hold', () => {
    expect(vatRoundsToNothingProblem([{ quantity: 1, unitPrice: 0.03 }], ['standard'], 'none', D)).toBeNull();
    expect(vatRoundsToNothingProblem([{ quantity: 1, unitPrice: 0.03 }], ['standard'], 'exclusive', '')).toBeNull();
  });
});

describe('the pages hold on it', () => {
  const draft = (lines: ReturnType<typeof line>[]) => ({ form: FORM, lines, taxMode: 'exclusive' as TaxMode });
  it('edit: Save Changes and autosave refuse 1 x R0.03 standard; R0.03 zero-rated saves', () => {
    expect(saveProblem(draft([line(1, 0.03, 'standard')]), {})).toMatch(/rounds to nothing/);
    expect(autosaveProblem(draft([line(1, 0.03, 'standard')]), {})).toMatch(/rounds to nothing/);
    expect(saveProblem(draft([line(1, 0.03, 'zero_rated')]), {})).toBeNull();
  });
  it('new: Create refuses it, and sends nothing', () => {
    const lines = [line(1, 0.03, 'standard')];
    expect(createBody(FORM, lines, 'exclusive', ['standard'], {})).toEqual({ problem: expect.stringMatching(/rounds to nothing/) });
    expect('body' in createBody(FORM, [line(1, 0.04, 'standard')], 'exclusive', ['standard'], {})).toBe(true);
  });
});
