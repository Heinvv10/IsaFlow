/**
 * PR S round six: the stale-view check compares exchange rates as decimals (micro-units, half away from zero), as
 * the numeric(…, 6) column stores them, never as floats: 4.0000005 stored as text is 4.000001 (as a float, 4.0000005 × 10⁶ rounds to 4000000).
 */
import { shownDigestOf } from '@/modules/accounting/services/ar/customerInvoiceShownDigest';
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
      { total_amount: '1150.00', currency_code: 'ZAR', exchange_rate: 1, approval_content_digest: 'changed-digest' },
    )).toThrow(InvoiceStaleViewError);
  });

  it('accepts the shown digest of the row the screen loaded (approval digest + notes, due date, billing period)', () => {
    const row = { approval_content_digest: 'screen-digest', notes: 'Pay by EFT', due_date: '2026-10-01', billing_period_start: null, billing_period_end: null };
    expect(() => assertShownIsStored({ expectedContentDigest: shownDigestOf(row) }, row)).not.toThrow();
    expect(() => assertShownIsStored({ expectedContentDigest: shownDigestOf(row) }, { ...row, notes: 'Changed' })).toThrow(InvoiceStaleViewError);
  });

  it('says what changed: the total when it moved, the content (never the total) when only that did', () => {
    const row = { total_amount: '1150.00', approval_content_digest: 'd', notes: '' };
    expect(() => assertShownIsStored({ expectedTotal: 1000, expectedContentDigest: shownDigestOf(row) }, row)).toThrow(/its total is now/);
    expect(() => assertShownIsStored({ expectedTotal: 1150, expectedContentDigest: 'other' }, row)).toThrow(/lines, customer, dates or notes/);
    expect(() => assertShownIsStored({ expectedTotal: 1150, expectedContentDigest: 'other' }, row)).not.toThrow(/total/);
  });
});
