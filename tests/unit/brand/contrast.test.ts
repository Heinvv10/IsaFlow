import { describe, expect, it } from 'vitest';
import {
  assertCarriesWhiteText, contrastRatio, relativeLuminance, NEUTRAL_BRAND_PRIMARY,
} from '@/lib/brand/contrast';

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('matches the WCAG worked example for mid grey', () => {
    // #808080 -> 0.2158 per the WCAG 2.1 relative-luminance definition.
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2158, 3);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#1a3a5c', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#1a3a5c'), 6);
  });
});

describe('assertCarriesWhiteText', () => {
  it('accepts the neutral default', () => {
    expect(() => assertCarriesWhiteText(NEUTRAL_BRAND_PRIMARY, 'primaryColour')).not.toThrow();
  });

  it('rejects a near-white primary that would print an unreadable cover', () => {
    // The exact failure this exists to stop: a company saves #f5f5f5 and the
    // cover prints white on white. There is no UI at render time to warn.
    expect(() => assertCarriesWhiteText('#f5f5f5', 'primaryColour'))
      .toThrow(/primaryColour/);
  });

  it('names the measured ratio in the error so the message is actionable', () => {
    expect(() => assertCarriesWhiteText('#f5f5f5', 'primaryColour'))
      .toThrow(/1\.\d+:1|contrast/i);
  });

  it('accepts a colour exactly at the 4.5:1 threshold', () => {
    // #767676 on white is the canonical 4.54:1 boundary case.
    expect(() => assertCarriesWhiteText('#767676', 'primaryColour')).not.toThrow();
  });
});
