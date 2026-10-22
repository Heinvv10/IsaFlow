/**
 * PAYE 4a follow-ups (G7): the UI lump-sum calculator uses SARS's retirement
 * fund lump sum benefits / severance benefits table for the 2027 tax year.
 *
 * Source: https://www.sars.gov.za/tax-rates/income-tax/retirement-lump-sum-benefits/
 * (retrieved 2026-10-22), "Retirement fund lump sum benefits or severance
 * benefits", 2025-2027 tax years (no change since 2024):
 *   1 – 550 000            0%
 *   550 001 – 770 000      18% of taxable income above 550 000
 *   770 001 – 1 155 000    39 600 + 27% of taxable income above 770 000
 *   1 155 001 and above    143 550 + 36% of taxable income above 1 155 000
 */
import { describe, it, expect } from 'vitest';
import { calculateLumpSumTax, LUMP_SUM_TAX_YEAR } from '@/lib/taxCalculations';

describe('calculateLumpSumTax — SARS 2027 retirement/severance lump-sum table', () => {
  it('names the tax year', () => {
    expect(LUMP_SUM_TAX_YEAR).toBe(2027);
  });

  it.each([
    [550_000, 0],
    [550_001, 0.18],
    [770_000, 39_600],
    [770_001, 39_600.27],
    [1_155_000, 143_550],
    [1_155_001, 143_550.36],
    [2_000_000, 143_550 + 0.36 * 845_000],
  ])('R%d → R%d', (gross, tax) => {
    const r = calculateLumpSumTax(gross, null);
    expect(r.taxAmount).toBeCloseTo(tax, 2);
    expect(r.directiveRateUsed).toBe(false);
  });

  it('the breakdown labels carry the 2027 bracket edges', () => {
    const labels = calculateLumpSumTax(2_000_000, null).breakdown.map(b => b.bracket);
    expect(labels.join(' | ')).toMatch(/550,000.*770,000.*1,155,000/);
  });
});
