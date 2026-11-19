/**
 * The shared VAT types and line calculation (per-line VAT programme, step 1):
 * the rate comes from the VAT type and the document date, never from the caller.
 */
import { describe, expect, it } from 'vitest';
import { SA_STANDARD_VAT_RATE_PCT, isRatedDate, standardVatRatePctOn } from '@/lib/vat/standardRate';
import {
  DOCUMENT_LINE_VAT_TYPES, normaliseVatType, vatRatePctOn, vatTypeLabel,
} from '@/modules/accounting/services/shared/vatTypes';
import { lineAmount, vatDocumentTotals, vatLineAmounts, vatTotalLabel } from '@/modules/accounting/services/shared/vatLineAmounts';

describe('standardVatRatePctOn', () => {
  it('is the rate in force on the date, on either side of a change', () => {
    expect(standardVatRatePctOn('2018-03-31')).toBe(14);
    expect(standardVatRatePctOn('2018-04-01')).toBe(15);
    expect(standardVatRatePctOn('1993-04-06')).toBe(10);
    expect(standardVatRatePctOn('2026-11-19')).toBe(15);
  });

  it('reads a Date by its local calendar day (pg returns Date for date columns)', () => {
    expect(standardVatRatePctOn(new Date(2018, 2, 31))).toBe(14);
    expect(standardVatRatePctOn(new Date(2018, 3, 1))).toBe(15);
  });

  it("today's rate is the one constant the rest of the code reads", () => {
    expect(standardVatRatePctOn(new Date())).toBe(SA_STANDARD_VAT_RATE_PCT);
  });

  it('refuses a date that is not a calendar day or predates VAT', () => {
    expect(() => standardVatRatePctOn('not-a-date')).toThrow();
    expect(() => standardVatRatePctOn('1990-01-01')).toThrow();
  });

  it('refuses a day the month does not have (Date.parse rolls it over)', () => {
    expect(() => standardVatRatePctOn('2026-02-31')).toThrow(/not a calendar day/);
    expect(() => standardVatRatePctOn('2026-13-01')).toThrow();
    expect(standardVatRatePctOn('2024-02-29')).toBe(15);
  });

  it('refuses a date that is not a string or a Date, as its own error', () => {
    expect(() => standardVatRatePctOn(20261119 as unknown as string)).toThrow(/not a string/);
    expect(() => standardVatRatePctOn(null as unknown as string)).toThrow(/not a string/);
  });

  it('isRatedDate answers for a form field mid-edit without throwing', () => {
    for (const bad of ['', '2026-1', '2026-02-31', '1990-01-01', null, undefined, 5]) expect(isRatedDate(bad)).toBe(false);
    expect(isRatedDate('2026-11-19')).toBe(true);
    expect(isRatedDate(new Date(2026, 10, 19))).toBe(true);
  });
});

describe('VAT types', () => {
  it('only standard-rated types carry a rate', () => {
    expect(vatRatePctOn('standard', '2026-11-19')).toBe(15);
    expect(vatRatePctOn('capital_goods', '2026-11-19')).toBe(15);
    expect(vatRatePctOn('standard', '2017-06-01')).toBe(14);
    for (const t of ['zero_rated', 'export', 'exempt', 'no_vat'] as const) expect(vatRatePctOn(t, '2026-11-19')).toBe(0);
  });

  it("reads the items and customer screens' spellings as the ledger's", () => {
    expect(normaliseVatType('zero')).toBe('zero_rated');
    expect(normaliseVatType('none')).toBe('no_vat');
    expect(normaliseVatType('standard')).toBe('standard');
    expect(normaliseVatType('exempt')).toBe('exempt');
  });

  it('answers null for anything else, so a caller can refuse it', () => {
    for (const bad of ['STANDARD', 'std', '', '15', null, undefined, 15]) expect(normaliseVatType(bad)).toBeNull();
  });

  it('labels a rated type with the rate on the date', () => {
    expect(vatTypeLabel('standard', '2026-11-19')).toBe('Standard (15%)');
    expect(vatTypeLabel('standard', '2018-03-31')).toBe('Standard (14%)');
    expect(vatTypeLabel('zero_rated', '2026-11-19')).toBe('Zero-rated (0%)');
    expect(vatTypeLabel('exempt', '2026-11-19')).toBe('Exempt');
  });

  it('offers a document line the types its posting can honour', () => {
    expect([...DOCUMENT_LINE_VAT_TYPES]).toEqual(['standard', 'zero_rated', 'exempt']);
  });
});

describe('vatLineAmounts', () => {
  const D = '2026-11-19';

  it('adds VAT to an exclusive amount, rounded to the cent on the line', () => {
    expect(vatLineAmounts(14.29, 'standard', D)).toEqual({ net: 14.29, vat: 2.14, gross: 16.43, ratePct: 15 });
    expect(vatLineAmounts(2200, 'standard', D)).toEqual({ net: 2200, vat: 330, gross: 2530, ratePct: 15 });
  });

  it('rounds half away from zero, exactly (a float rounds 1.005 down)', () => {
    // 0.10 at 15% = 0.015 exactly
    expect(vatLineAmounts(0.1, 'standard', D).vat).toBe(0.02);
    expect(vatLineAmounts(-0.1, 'standard', D).vat).toBe(-0.02);
    expect(vatLineAmounts(1.005, 'zero_rated', D).net).toBe(1.01);
  });

  it('backs VAT out of an inclusive amount and keeps the gross whole', () => {
    expect(vatLineAmounts(115, 'standard', D, 'inclusive')).toEqual({ net: 100, vat: 15, gross: 115, ratePct: 15 });
    expect(vatLineAmounts(100, 'standard', D, 'inclusive')).toEqual({ net: 86.96, vat: 13.04, gross: 100, ratePct: 15 });
    expect(vatLineAmounts(100, 'exempt', D, 'inclusive')).toEqual({ net: 100, vat: 0, gross: 100, ratePct: 0 });
  });

  it('charges nothing on a type with no rate', () => {
    for (const t of ['zero_rated', 'exempt', 'export', 'no_vat'] as const) {
      expect(vatLineAmounts(500, t, D)).toEqual({ net: 500, vat: 0, gross: 500, ratePct: 0 });
    }
  });

  it('uses the rate of the document date', () => {
    expect(vatLineAmounts(100, 'standard', '2018-03-31').vat).toBe(14);
  });

  it('throws on an amount that is not a number', () => {
    expect(() => vatLineAmounts(Number.NaN, 'standard', D)).toThrow();
  });
});

describe('vatDocumentTotals', () => {
  it('sums the lines: a mixed document carries VAT only on its rated lines', () => {
    const D = '2026-11-19';
    const lines = [vatLineAmounts(1000, 'standard', D), vatLineAmounts(500, 'zero_rated', D), vatLineAmounts(250, 'exempt', D)];
    expect(vatDocumentTotals(lines)).toEqual({ subtotal: 1750, vat: 150, total: 1900 });
  });

  it('is the sum of the line VATs, not VAT on the subtotal', () => {
    const lines = Array.from({ length: 7 }, () => vatLineAmounts(14.29, 'standard', '2026-11-19'));
    // 7 x 2.14; VAT on the 100.03 subtotal would be 15.00
    expect(vatDocumentTotals(lines)).toEqual({ subtotal: 100.03, vat: 14.98, total: 115.01 });
  });

  it('has no float drift', () => {
    const lines = [vatLineAmounts(0.1, 'exempt', '2026-11-19'), vatLineAmounts(0.2, 'exempt', '2026-11-19')];
    expect(vatDocumentTotals(lines).subtotal).toBe(0.3);
  });
});

describe('lineAmount', () => {
  it('multiplies as decimals (the float product of 3 x 1.005 rounds down)', () => {
    expect(3 * 1.005).not.toBe(3.015);
    expect(lineAmount(3, 1.005)).toBe(3.02);
    expect(lineAmount(0.001, 499)).toBe(0.5);
    expect(lineAmount(2, 250)).toBe(500);
    expect(lineAmount(1.5, 0)).toBe(0);
  });

  it('throws on a number that is not finite', () => {
    expect(() => lineAmount(Number.NaN, 1)).toThrow();
    expect(() => lineAmount(1, Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('vatTotalLabel', () => {
  it('quotes the rate when the VAT is that rate on the whole subtotal', () => {
    expect(vatTotalLabel(1000, 15, 150)).toBe('VAT (15%)');
    expect(vatTotalLabel(800, 0, 0)).toBe('VAT (0%)');
    // seven lines of 14.29, VAT rounded per line: two cents under 15% of the subtotal
    expect(vatTotalLabel(100.03, 15, 14.98)).toBe('VAT (15%)');
  });

  it('drops the rate on a document mixing rated and unrated lines', () => {
    expect(vatTotalLabel(1750, 15, 150)).toBe('VAT');
    expect(vatTotalLabel(1000, 15, 149.89)).toBe('VAT');
  });
});
