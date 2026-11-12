/**
 * Audit 11 Nov 2026 item 5: the quote form taxed every line at a hard-coded 15%. It now uses the invoice form's
 * "Amounts are" mode and rate, priced by the same functions the invoice preview uses.
 */
import { describe, expect, it } from 'vitest';
import { initialQuoteTaxMode, quoteLinePayload, quoteTotals } from '@/components/accounting/customer-quotes/quoteVat';
import { resolveVatRegistration } from '@/hooks/vatRegistrationState';
import { invoiceLineAmount, invoiceTotals } from '@/modules/accounting/services/ar/invoiceLineAmount';

const lines = [{ qty: 2, price: 100 }, { qty: 3, price: 33.33 }];

describe('quoteTotals', () => {
  it('standard 15% exclusive', () => {
    expect(quoteTotals(lines, 'exclusive', 15)).toEqual({ subtotal: 299.99, tax: 45, total: 344.99 });
  });
  it('No VAT: rate 0, total equals subtotal', () => {
    expect(quoteTotals(lines, 'none', 15)).toEqual({ subtotal: 299.99, tax: 0, total: 299.99 });
  });
  it('inclusive: R115 typed is R100 plus R15', () => {
    expect(quoteTotals([{ qty: 1, price: 115 }], 'inclusive', 15)).toEqual({ subtotal: 100, tax: 15, total: 115 });
  });
  it('equals invoiceTotals for the same lines', () => {
    const amounts = lines.map((l) => invoiceLineAmount(l.qty, l.price));
    const t = invoiceTotals(amounts, 15);
    expect(quoteTotals(lines, 'exclusive', 15)).toEqual(t);
  });
});

describe('quoteLinePayload', () => {
  it('sends the typed price and the form rate when exclusive', () => {
    expect(quoteLinePayload({ qty: 1, price: 100 }, 'exclusive', 15)).toEqual({ unitPrice: 100, taxRate: 15 });
  });
  it('sends rate 0 in No VAT', () => {
    expect(quoteLinePayload({ qty: 1, price: 100 }, 'none', 15)).toEqual({ unitPrice: 100, taxRate: 0 });
  });
  it('sends the ex-VAT price when inclusive', () => {
    expect(quoteLinePayload({ qty: 1, price: 115 }, 'inclusive', 15)).toEqual({ unitPrice: 100, taxRate: 15 });
  });
});

describe('initialQuoteTaxMode', () => {
  it('a company known not to be VAT registered starts in No VAT', () => {
    expect(initialQuoteTaxMode(resolveVatRegistration('none', null, false))).toBe('none');
  });
  it('a registered company starts Excluding VAT', () => {
    expect(initialQuoteTaxMode(resolveVatRegistration('bi-monthly', 'invoice', false))).toBe('exclusive');
  });
  it('unknown registration starts Excluding VAT', () => {
    expect(initialQuoteTaxMode(resolveVatRegistration(undefined, undefined, true))).toBe('exclusive');
  });
});
