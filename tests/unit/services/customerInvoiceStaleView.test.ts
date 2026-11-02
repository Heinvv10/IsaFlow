/**
 * PR S round six: the stale-view check compares exchange rates as decimals (micro-units, half away from zero), as
 * the numeric(…, 6) column stores them, never as floats: 4.0000005 stored as text is 4.000001 (as a float, 4.0000005 × 10⁶ rounds to 4000000).
 */
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
