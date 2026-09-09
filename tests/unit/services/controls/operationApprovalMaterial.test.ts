import { expect, it } from 'vitest';
import { deriveInvoiceAmount, derivePaymentAmount } from '@/modules/accounting/services/controls/apOperationMaterializer';

it('derives invoice amount from persisted line totals and refuses a different header', () => {
  expect(deriveInvoiceAmount('115.00', [{ line_total: '100', tax_amount: '15' }])).toBe('115');
  expect(() => deriveInvoiceAmount('1000', [{ line_total: '100', tax_amount: '15' }])).toThrow();
});
it('derives payment amount and currency from complete owned invoice allocations', () => {
  const allocations = [{ amount_allocated: '60', invoice_currency: 'ZAR' }, { amount_allocated: '55', invoice_currency: 'ZAR' }];
  expect(derivePaymentAmount('115', allocations)).toEqual({ amount: '115', currency: 'ZAR' });
  expect(() => derivePaymentAmount('1000', allocations)).toThrow();
  expect(() => derivePaymentAmount('115', [])).toThrow();
  expect(() => derivePaymentAmount('115', [{ ...allocations[0]!, invoice_currency: 'USD' }, allocations[1]!])).toThrow();
});
