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

  it('passes a 2-decimal rate and refuses a 3-decimal one (tax_rate is numeric(5,2))', () => {
    expect(assertWipTaxRate(15.25)).toBe(15.25);
    expect(assertWipTaxRate(0.1 + 0.2)).toBeCloseTo(0.3);
    expect(() => assertWipTaxRate(15.555)).toThrow(/at most 2 decimals/);
  });

  it.each([101, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s', (rate) => {
    expect(() => assertWipTaxRate(rate)).toThrow(WipInvoiceRefusal);
    expect(() => assertWipTaxRate(rate)).toThrow(/taxRate must be between 0 and 100/);
  });
});

describe('assertWipEntryLines', () => {
  const entry = (over: Record<string, unknown>) => ({
    id: 'te-1', entry_date: '2026-01-05', task_description: 'Audit', hours: 4, applied_rate: 250, line_total: 1000, ...over,
  });

  it('passes non-negative lines, including a zero line', () => {
    expect(() => assertWipEntryLines([entry({}), entry({ applied_rate: 0, line_total: 0 })])).not.toThrow();
  });

  it('passes a line within 1c of hours × rate, refuses one that disagrees', () => {
    expect(() => assertWipEntryLines([entry({ hours: 1.33, applied_rate: 333.3333, line_total: 443.33 })])).not.toThrow();
    // Exactly 1c off, as pg returns them (strings): allowed, as the census allows it.
    expect(() => assertWipEntryLines([entry({ hours: '1.00', applied_rate: '100.0000', line_total: '100.01' })])).not.toThrow();
    expect(() => assertWipEntryLines([entry({ hours: '2.00', applied_rate: '50.0000', line_total: '99.99' })])).not.toThrow();
    expect(() => assertWipEntryLines([entry({ hours: '1.00', applied_rate: '100.0000', line_total: '100.02' })])).toThrow(WipInvoiceRefusal);
    expect(() => assertWipEntryLines([entry({ hours: 2, applied_rate: 100, line_total: 5000 })]))
      .toThrow(/not its 2h × 100/);
  });

  it.each([
    // Each consistent (line = hours × rate), so only the named check refuses it.
    ['a negative rate and line', { applied_rate: -50, line_total: -200 }],
    ['a non-numeric line', { line_total: 'abc' }],
    ['a NULL rate on a zero line (Number(null) is 0)', { applied_rate: null, line_total: 0 }],
    ['a NULL line', { line_total: null }],
  ])('refuses %s, naming the entry', (_label, over) => {
    expect(() => assertWipEntryLines([entry({}), entry(over)])).toThrow(WipInvoiceRefusal);
    expect(() => assertWipEntryLines([entry(over)])).toThrow(/"Audit"/);
  });
});
