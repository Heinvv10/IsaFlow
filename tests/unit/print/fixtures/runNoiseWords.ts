/**
 * Words a run's noise is measured on (#1235 round 7's blind review: production set "Bg\u00F1LkDLBQP\u00E0\u00E1mDQ\u00F1bm\u00F6" at 400 a
 * unit past its exact sum rounded up): 8,000 words of 6 to 19 letters, accented ones among them, composed, and the
 * review's four. Held in the print tests' Chromium (`packGlyphRuler.test.ts`) and in production's image
 * (`printParity/packRunNoiseImage.test.ts`).
 */
import { mulberry32 } from '../support/mulberry32';

export function runNoiseWords(): string[] {
  const random = mulberry32(11);
  const next = (): number => random.next().value as number;
  const letters = Array.from('qQjJxXfFbBdDpPhHkKmMtTvVwWyYzZlLrRsSnNgGcCaAeEiIoOuU\u00E9\u00E8\u00FC\u00F6\u00E7\u00F1\u00EC\u00ED\u00E0\u00E1');
  const out = new Set<string>(['Bg\u00F1LkDLBQP\u00E0\u00E1mDQ\u00F1bm\u00F6', 'Y\u030AWGoWE\u00DDwZdnHXGv\u0304lVOb\u0327', 'ywSZ\u0327O\u030ACTM\u0302rDbp\u030AQM\u030CcbnPJ\u0304', 'H\u010EWg\u0303qCR\u030A\u014CvW\u00C5\u1E81vX\u0303mDmBL']);
  while (out.size < 8000) {
    let w = '';
    const len = 6 + Math.floor(next() * 14);
    for (let i = 0; i < len; i += 1) w += letters[Math.floor(next() * letters.length)]!;
    out.add(w.normalize('NFC'));
  }
  return [...out];
}
