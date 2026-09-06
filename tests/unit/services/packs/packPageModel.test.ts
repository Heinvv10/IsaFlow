import { describe, expect, it } from 'vitest';
import { assertPageTitleIsAMessage, isContentPage } from '@/modules/accounting/services/packs/pages/packPageModel';

describe('assertPageTitleIsAMessage', () => {
  it('rejects a bare label', () => {
    // Rubric criterion 1. These are the exact titles the rejected pack shipped.
    for (const bad of ['Financial Ratios', 'Commentary', 'Income Statement', 'Balance Sheet', 'KPI Scorecard']) {
      expect(() => assertPageTitleIsAMessage(bad, 6), bad).toThrow();
    }
  });

  it('accepts a title that states a conclusion about the period', () => {
    expect(() => assertPageTitleIsAMessage(
      'Revenue up 12% but the operating loss widened to R5.8m', 3)).not.toThrow();
  });

  it('exempts the cover, contents and basis pages, which are navigation', () => {
    expect(() => assertPageTitleIsAMessage('Contents', 2)).not.toThrow();
    expect(() => assertPageTitleIsAMessage('Basis of preparation and definitions', 12)).not.toThrow();
  });

  // R-P30: the exemption covers four spec-mandated cases, not two. Page 1's
  // title is the company's legal name — arbitrary text, data we do not
  // choose, exempted by NUMBER — and 'Matters requiring board attention'
  // (page 11) joins the exact-match navigation set.
  it('exempts page 1 by number, whatever its title reads', () => {
    expect(() => assertPageTitleIsAMessage('Velocity Fibre (Pty) Ltd', 1)).not.toThrow();
  });

  it('exempts the exact navigation title for page 11', () => {
    expect(() => assertPageTitleIsAMessage('Matters requiring board attention', 11)).not.toThrow();
  });
});

describe('isContentPage', () => {
  it('excludes the cover and contents from the density rule', () => {
    expect(isContentPage(1)).toBe(false);
    expect(isContentPage(2)).toBe(false);
    expect(isContentPage(3)).toBe(true);
  });
});
