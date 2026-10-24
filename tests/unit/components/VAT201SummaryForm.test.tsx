/**
 * The summary renders the SARS form exactly as the server sent it: the field
 * numbers, wording and amounts are the server's, a field IsaFlow cannot fill is
 * a dash (never R0.00), and the CSV carries the same numbers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { VAT201SummaryForm } from '@/components/accounting/sars/VAT201SummaryForm';
import { buildVat201Csv } from '@/components/accounting/sars/vat201Csv';
import { buildVat201SarsFields } from '@/modules/accounting/services/reports/vat201SarsFields';

afterEach(() => { cleanup(); });

const FIELDS = buildVat201SarsFields(
  {
    boxes: [
      { box: '1', label: 'x', direction: 'output', vatType: 'standard', base: 1000, tax: 150, impliedTax: 150, variance: 0, lateClaimTax: 0 },
      { box: '15', label: 'x', direction: 'input', vatType: 'standard', base: 400, tax: 60, impliedTax: 60, variance: 0, lateClaimTax: 0 },
    ],
    totals: { outputTax: 150, inputTax: 60, netVat: 90, standardRatedSupplies: 1000, standardRatedPurchases: 400, lateClaimInputTax: 0 },
  },
  { zeroRated: 0, exported: 0, exempt: 0, onTaxedJournals: 0 },
);
const DATA = { periodStart: '2026-09-01', periodEnd: '2026-09-30', sarsFields: FIELDS };

describe('VAT201SummaryForm', () => {
  it('prints the official field numbers in form order, not 1-11', () => {
    render(<VAT201SummaryForm data={DATA} />);
    const numbers = screen.getAllByTestId('vat201-field-number').map((n) => n.textContent);
    expect(numbers).toEqual(FIELDS.map((f) => f.field));
    expect(numbers).toContain('1A');
    expect(numbers).toContain('14A');
    expect(numbers.slice(-1)).toEqual(['20']);
  });

  it('shows the amount the server computed beside its field', () => {
    render(<VAT201SummaryForm data={DATA} />);
    expect(within(screen.getByTestId('vat201-field-13')).getByTestId('vat201-field-amount').textContent).toMatch(/150[.,]00/);
    expect(within(screen.getByTestId('vat201-field-20')).getByTestId('vat201-field-amount').textContent).toMatch(/90[.,]00/);
  });

  it('shows a dash, with the reason, for a field IsaFlow does not compute', () => {
    render(<VAT201SummaryForm data={DATA} />);
    const row = screen.getByTestId('vat201-field-5');
    expect(within(row).getByTestId('vat201-field-amount').textContent).toBe('—');
    expect(row.textContent).toMatch(/does not compute/);
  });
});

describe('buildVat201Csv', () => {
  it('writes one line per SARS field with its number and amount, blank for an uncomputed field', () => {
    const lines = buildVat201Csv(DATA).split('\n');
    expect(lines[0]).toBe('Field,Description,Amount (ZAR)');
    expect(lines).toContain('4,"Output tax on field 1",150.00');
    expect(lines.find((l) => l.startsWith('5,'))).toMatch(/,$/);
    expect(lines.at(-1)).toBe('Period,2026-09-01 to 2026-09-30');
  });
});
