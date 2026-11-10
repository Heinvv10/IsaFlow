/**
 * THE EM TABLE CHARGES A CHARACTER THE FACES DO NOT SET THE WIDEST FALLBACK GLYPH (#1261 adversarial H1: page 6's
 * caption and its "Lines below zero" disclosure quote a row label, and U+FDFD, which production sets at about 7.2em,
 * was charged 1em; through the full pipeline Brightsphere printed a 13th sheet). `packTextMetrics.FALLBACK_EMS` is
 * `FALLBACK.widest` in ems of the size it was measured at.
 */
import { describe, expect, it } from 'vitest';
import { FALLBACK } from '@/modules/accounting/services/packs/pages/packFallbackWidthData';
import { FALLBACK_EMS, textWidthEms, wrappedLines } from '@/modules/accounting/services/packs/pages/packTextMetrics';

describe('the em table, for a character the faces do not set', () => {
  it('charges the widest fallback glyph, in ems of the size it was measured at', () => {
    const widest = Math.max(FALLBACK.label400.widest / 12, FALLBACK.label500.widest / 12, FALLBACK.label600.widest / 12, FALLBACK.reason.widest / ((11 * 96) / 72));
    expect(FALLBACK_EMS).toBe(widest);
    expect(FALLBACK_EMS).toBeGreaterThan(7.2);
    for (const ch of ['\uFDFD', '\u0E01', '\u4E2D', '\u{1F600}', '\u0915', '\u23B0', '\uFE0F']) expect(textWidthEms(ch), ch).toBe(FALLBACK_EMS);
    // Text the faces set keeps its classes; an ideographic space is the em it is.
    expect(textWidthEms('Revenue')).toBeLessThan(5);
    expect(textWidthEms('\u3000')).toBe(1);
  });

  it('wraps a run of U+FDFD at its production width: never fewer lines than 7.2em each takes', () => {
    const perLineEms = 60 / ((9 * 25.4) / 72);
    for (const n of [1, 5, 10, 30]) expect(wrappedLines('\uFDFD'.repeat(n), 9, 60), String(n)).toBeGreaterThanOrEqual(Math.ceil((n * 7.2) / perLineEms));
  });
});
