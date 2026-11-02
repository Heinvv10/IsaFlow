/**
 * paymentTerms.ts — the due date a customer's terms give an invoice date. Local-date arithmetic, so the result never
 * slips a day across UTC.
 */
import { describe, expect, it } from 'vitest';
import { dueDateFromTerms } from '@/modules/accounting/services/ar/paymentTerms';

describe('dueDateFromTerms', () => {
  it.each([
    ['2026-01-31', 30, 'days', '2026-03-02'],
    ['2026-10-01', 30, 'days', '2026-10-31'],
    ['2026-10-01', 0, 'days', '2026-10-01'],
    ['2028-02-15', 0, 'end_of_month', '2028-02-29'],
    ['2026-02-15', 0, 'end_of_month', '2026-02-28'],
    ['2026-10-15', 30, 'end_of_month', '2026-11-30'],
    ['2026-12-31', 1, 'end_of_month', '2027-01-01'],
  ])('%s + %i %s = %s', (invoiceDate, days, type, due) => {
    expect(dueDateFromTerms(invoiceDate, days, type)).toBe(due);
  });

  it.each([
    ['null terms', '2026-10-01', null, 'days'],
    ['undefined terms', '2026-10-01', undefined, 'days'],
    ['negative terms', '2026-10-01', -1, 'days'],
    ['fractional terms', '2026-10-01', 1.5, 'days'],
    ['a type nobody defined', '2026-10-01', 30, 'net'],
    ['no type', '2026-10-01', 30, null],
    ['no invoice date', '', 30, 'days'],
    ['an impossible invoice date', '2026-02-30', 30, 'days'],
  ])('%s gives no due date', (_why, invoiceDate, days, type) => {
    expect(dueDateFromTerms(invoiceDate, days, type)).toBeNull();
  });
});
