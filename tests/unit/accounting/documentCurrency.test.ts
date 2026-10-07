/**
 * FX PR0: the currency and rate a new document may be written with.
 *
 * - A document in the company's functional currency converts at exactly 1.
 *   Any other rate shrinks or inflates `functional_total`, the figure approval
 *   rules match on (R-035 PR2 HIGH-1, now for invoices and bills alike).
 * - A document in any other currency is refused unless the company has
 *   `fx_documents_enabled`: until the FX programme lands, such a document
 *   would post its document figures as rands.
 */
import { describe, expect, it } from 'vitest';
import {
  DocumentCurrencyError, DocumentExchangeRateError, ForeignCurrencyDisabledError, checkDocumentCurrency,
} from '@/modules/accounting/services/shared/documentCurrency';

const off = { functionalCurrency: 'ZAR', fxDocumentsEnabled: false };
const on = { functionalCurrency: 'ZAR', fxDocumentsEnabled: true };

describe('checkDocumentCurrency', () => {
  it('defaults to the functional currency at 1', () => {
    expect(checkDocumentCurrency(off, undefined, undefined, 'invoice')).toEqual({ currencyCode: 'ZAR', exchangeRate: 1 });
    expect(checkDocumentCurrency(off, '', 0, 'invoice')).toEqual({ currencyCode: 'ZAR', exchangeRate: 1 });
    expect(checkDocumentCurrency(off, ' zar ', 1, 'bill')).toEqual({ currencyCode: 'ZAR', exchangeRate: 1 });
  });

  it('refuses the functional currency at any rate but 1, flag or no flag', () => {
    for (const company of [off, on]) {
      for (const rate of [0.5, 0.0001, 18.5, 1.000001]) {
        const attempt = () => checkDocumentCurrency(company, 'ZAR', rate, 'invoice');
        expect(attempt).toThrow(DocumentExchangeRateError);
        expect(attempt).toThrow(/ZAR invoice is in this company's own currency, so its exchange rate must be 1/);
      }
    }
  });

  it('refuses a foreign currency while the company has not enabled foreign-currency documents', () => {
    const attempt = () => checkDocumentCurrency(off, 'usd', 18.5, 'bill');
    expect(attempt).toThrow(ForeignCurrencyDisabledError);
    expect(attempt).toThrow(/USD bills are not enabled for this company/);
  });

  it('accepts a foreign currency once enabled, at its own rate', () => {
    expect(checkDocumentCurrency(on, 'usd', 18.5, 'invoice')).toEqual({ currencyCode: 'USD', exchangeRate: 18.5 });
  });

  it('both refusals are one class to catch, each with its own registered code', () => {
    let rate: unknown;
    let fx: unknown;
    try { checkDocumentCurrency(off, 'ZAR', 2, 'invoice'); } catch (e) { rate = e; }
    try { checkDocumentCurrency(off, 'EUR', 20, 'credit note'); } catch (e) { fx = e; }
    expect(rate).toBeInstanceOf(DocumentCurrencyError);
    expect(fx).toBeInstanceOf(DocumentCurrencyError);
    expect((rate as DocumentExchangeRateError).code).toBe('EXCHANGE_RATE_INVALID');
    expect((fx as ForeignCurrencyDisabledError).code).toBe('FOREIGN_CURRENCY_DISABLED');
  });
});
