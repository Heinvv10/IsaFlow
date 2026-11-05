import { describe, it, expect } from 'vitest';
import { scannedPaymentTermsOption } from '@/components/accounting/supplier-invoices/scannedPaymentTerms';

describe('scannedPaymentTermsOption', () => {
  it.each([
    ['Immediate', 'immediate'], ['COD', 'immediate'], ['0 days', 'immediate'],
    ['Net 30 days', 'net30'], ['60 days from invoice', 'net60'], ['Payable within 90 days', 'net90'],
    ['by arrangement', null], ['', null],
  ])('%j reads %s', (text, option) => {
    expect(scannedPaymentTermsOption(text)).toBe(option);
  });
});
