/**
 * R-120: the WIP invoice refusals, at the service boundary — the route's own
 * schema is not the only caller generateWipInvoice can ever have.
 */
import { describe, expect, it } from 'vitest';
import {
  WipInvoiceRefusal, assertWipTaxRate, assertWipEntryLines,
} from '@/modules/accounting/services/practice/wipInvoiceGuards';

describe('assertWipTaxRate', () => {
  it('defaults to 15 and passes 0 and 100 through', () => {
    expect(assertWipTaxRate(undefined)).toBe(15);
    expect(assertWipTaxRate(0)).toBe(0);
    expect(assertWipTaxRate(100)).toBe(100);
  });

  it.each([101, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s', (rate) => {
    expect(() => assertWipTaxRate(rate)).toThrow(WipInvoiceRefusal);
    expect(() => assertWipTaxRate(rate)).toThrow(/taxRate must be between 0 and 100/);
  });
});

describe('assertWipEntryLines', () => {
  const entry = (over: Record<string, unknown>) => ({
    id: 'te-1', entry_date: '2026-01-05', task_description: 'Audit', applied_rate: 250, line_total: 1000, ...over,
  });

  it('passes non-negative lines, including a zero line', () => {
    expect(() => assertWipEntryLines([entry({}), entry({ applied_rate: 0, line_total: 0 })])).not.toThrow();
  });

  it.each([
    ['a negative line', { line_total: -200 }],
    ['a negative rate', { applied_rate: -50 }],
    ['a non-numeric line', { line_total: 'abc' }],
  ])('refuses %s, naming the entry', (_label, over) => {
    expect(() => assertWipEntryLines([entry({}), entry(over)])).toThrow(WipInvoiceRefusal);
    expect(() => assertWipEntryLines([entry(over)])).toThrow(/"Audit"/);
  });
});
