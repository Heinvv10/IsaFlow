/**
 * PR S round six: the stale-view check compares exchange rates as decimals (micro-units, half away from zero), as
 * the numeric(…, 6) column stores them, never as floats: 4.0000005 stored as text is 4.000001 (as a float, 4.0000005 × 10⁶ rounds to 4000000).
 */
import { shownDigestOfModel, type InvoicePdfModel } from '@/modules/accounting/services/ar/invoicePdfModel';
import { describe, expect, it } from 'vitest';
import { assertShownIsStored, InvoiceStaleViewError } from '@/modules/accounting/services/ar/customerInvoiceStaleView';

describe('assertShownIsStored and exchange rates', () => {
  it('a rate whose float times a million falls just short of the half still matches its decimal rounding', () => {
    expect(() => assertShownIsStored({ expectedExchangeRate: 4.000001 }, { total_amount: '100.00', currency_code: 'USD', exchange_rate: '4.0000005' })).not.toThrow();
  });
  it('the stored column text and the JSON number of the same rate match', () => {
    expect(() => assertShownIsStored({ expectedExchangeRate: 18.5 }, { total_amount: '100.00', currency_code: 'USD', exchange_rate: '18.500000' })).not.toThrow();
  });
  it('a rate a millionth apart does not', () => {
    expect(() => assertShownIsStored({ expectedExchangeRate: 18.500001 }, { total_amount: '100.00', currency_code: 'USD', exchange_rate: '18.500000' })).toThrow(InvoiceStaleViewError);
  });
});

describe('assertShownIsStored and money', () => {
  it('compares integer cents, half away from zero: 1.005 is 1.01 (Math.round(1.005 * 100) is 100)', () => {
    expect(() => assertShownIsStored({ expectedTotal: 1.01 }, { total_amount: '1.005', currency_code: 'ZAR', exchange_rate: 1 })).not.toThrow();
  });
  it('a cent apart is another total', () => {
    expect(() => assertShownIsStored({ expectedTotal: 1150 }, { total_amount: '1150.01', currency_code: 'ZAR', exchange_rate: 1 })).toThrow(InvoiceStaleViewError);
  });
});

describe('assertShownIsStored and approval content', () => {
  it('refuses an unseen content change even when total, currency and rate are unchanged', () => {
    expect(() => assertShownIsStored(
      { expectedTotal: 1150, expectedCurrency: 'ZAR', expectedExchangeRate: 1, expectedContentDigest: 'screen-digest' },
      { total_amount: '1150.00', currency_code: 'ZAR', exchange_rate: 1, shown_digest: 'changed-digest' },
    )).toThrow(InvoiceStaleViewError);
  });

  it('the shown digest is the PDF model\'s hash: every section of the model, and the approval digest, is in it', () => {
    const model = {
      company: { name: 'Issuer', address: 'A', phone: '', email: '', vatNumber: '', bankName: 'Bank', bankAccountName: 'Issuer',
        bankAccountNumber: '1', bankBranchCode: '2', bankReference: '', logoData: null, primaryColor: '#0f766e',
        invoiceLayout: 'classic', quoteLayout: 'classic', statementLayout: 'classic' },
      invoice: { invoice_number: 'INV-1', notes: 'Pay by EFT', client_name: 'Customer', client_vat: '41', due_date: '2026-10-01' },
      items: [{ description: 'Line A', quantity: '1.00', unit_price: '100.00', amount: '100.00', tax_rate: '15.00' }],
    } as unknown as InvoicePdfModel;
    const digest = shownDigestOfModel(model, 'approval');
    expect(() => assertShownIsStored({ expectedContentDigest: digest }, { shown_digest: shownDigestOfModel(model, 'approval') })).not.toThrow();
    const changed: InvoicePdfModel[] = [
      { ...model, company: { ...model.company, bankAccountNumber: '9' } },
      { ...model, invoice: { ...model.invoice, client_name: 'Someone else' } },
      { ...model, invoice: { ...model.invoice, notes: 'Changed' } },
      { ...model, items: [{ ...model.items[0]!, description: 'Changed line' }] },
    ];
    for (const m of changed) expect(shownDigestOfModel(m, 'approval')).not.toBe(digest);
    expect(shownDigestOfModel(model, 'another approval')).not.toBe(digest);
    const twoLines = { ...model, items: [model.items[0]!, { ...model.items[0]!, description: 'Line B' }] };
    expect(shownDigestOfModel({ ...twoLines, items: [...twoLines.items].reverse() }, 'approval')).toBe(shownDigestOfModel(twoLines, 'approval')); // lines are a set
  });

  it('says what changed: the total when it moved, the content (never the total) when only that did', () => {
    const row = { total_amount: '1150.00', shown_digest: 'd' };
    expect(() => assertShownIsStored({ expectedTotal: 1000, expectedContentDigest: 'd' }, row)).toThrow(/its total is now/);
    expect(() => assertShownIsStored({ expectedTotal: 1150, expectedContentDigest: 'other' }, row)).toThrow(/lines, customer, dates or notes/);
    expect(() => assertShownIsStored({ expectedTotal: 1150, expectedContentDigest: 'other' }, row)).not.toThrow(/total/);
  });
});
