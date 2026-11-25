/**
 * An "Including VAT" quote keeps the total it always had (Codex finding on #1921): the modal sent an ex-VAT unit price
 * (exVatUnitPrice) priced at one rate; it now sends the same ex-VAT price with per-line types. This replays the OLD
 * computation (quoteVat.ts, deleted: unit = exVatUnitPrice(typed), total = previewTotals at the rate) against what the
 * server prices from the body the modal now sends (the shared previewInvoiceVat), for a one-line quote over a grid of
 * quantities and VAT-inclusive prices (ONE line: VAT is rounded per line now, so several lines can differ by cents), and against what the modal SHOWS for the same lines (formTotals over storedForm).
 */
import { describe, expect, it } from 'vitest';
import { quoteBody, storedForm, type QuoteFormLine } from '@/components/accounting/customer-quotes/quoteFormVat';
import { formTotals } from '@/components/accounting/customer-invoices/formVat';
import { exVatUnitPrice } from '@/components/accounting/customer-invoices/taxMode';
import { previewLineAmount, previewTotals } from '@/modules/accounting/services/ar/invoiceLineAmount';
import { previewInvoiceVat } from '@/modules/accounting/services/ar/invoiceLineVatPricing';

const DATE = '2026-11-11';
const form = { clientId: 'c1', customerName: 'Acme', quoteDate: DATE, expiryDate: '', notes: '' };
const oldTotals = (qty: number, typed: number) =>
  previewTotals([previewLineAmount(qty, exVatUnitPrice(typed, 15), 0)], 15);

const prices = [0.5, 1, 3.33, 9.99, 10, 11.5, 19.99, 33.33, 99.99, 100, 114.99, 115, 199.95, 1234.56, 99999.99];
const quantities = [1, 2, 3, 7, 12.5];

describe('an Including VAT quote\'s total', () => {
  for (const qty of quantities) {
    for (const typed of prices) {
      it(`${qty} x R${typed} incl: stored total = the old total = the total shown`, () => {
        const lines: QuoteFormLine[] = [{ key: 'k', description: 'W', quantity: qty, unitPrice: typed, vatType: 'standard' }];
        const built = quoteBody(form, lines, 'inclusive', ['standard']);
        expect(built).toHaveProperty('body'); // none of the grid is held
        if ('problem' in built) return;
        const sent = built.body;
        const server = previewInvoiceVat(sent.lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, discount: 0 })), ['standard'], DATE, sent.amountsAre);
        const old = oldTotals(qty, typed);
        expect(server).toEqual({ subtotal: old.subtotal, tax: old.tax, total: old.total });
        const stored = storedForm(lines, ['standard'], 'inclusive', DATE);
        expect(formTotals(stored.lines, ['standard'], stored.mode, DATE)).toEqual(server);
      });
    }
  }

  for (const type of ['exempt', 'zero_rated'] as const) {
    it(`a ${type} line is priced as typed, no VAT, in the body and as shown`, () => {
      const lines: QuoteFormLine[] = [{ key: 'k', description: 'R', quantity: 2, unitPrice: 57.5, vatType: type }];
      const built = quoteBody(form, lines, 'inclusive', [type]);
      expect('body' in built && built.body.lines[0]!.unitPrice).toBe(57.5);
      const stored = storedForm(lines, [type], 'inclusive', DATE);
      expect(formTotals(stored.lines, [type], stored.mode, DATE)).toMatchObject({ tax: 0, total: 115 });
    });
  }

  it('an untyped line is left as typed', () => {
    const lines: QuoteFormLine[] = [{ key: 'k', description: 'R', quantity: 1, unitPrice: 10 }];
    expect(storedForm(lines, [null], 'inclusive', DATE).lines[0]!.unitPrice).toBe(10);
  });

  it('a price whose ex-VAT price carries no VAT is held on the converted price (1 x R0.04 incl)', () => {
    const built = quoteBody(form, [{ key: 'k', description: 'W', quantity: 1, unitPrice: 0.04, vatType: 'standard' }], 'inclusive', ['standard']);
    expect(built).toHaveProperty('problem');
  });
});
