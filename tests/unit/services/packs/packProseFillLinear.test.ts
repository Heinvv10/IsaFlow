/**
 * THE FILL'S WORK IS LINEAR IN THE TEXT, ON WHAT A TENANT CAN TYPE (#1263 security review). One long token with no break
 * in it is filled grapheme by grapheme, and the server's approval gate costs tenant commentary with it: work that grew
 * with the square of the token (a copy of what was left of it, per grapheme) let one request hold a CPU. Counted here
 * by what the fill asks its width function, and timed at two lengths against each other, so a quadratic step shows as
 * a ratio, whatever the machine's load. The caches beside it keep only short texts (`KEPT_CHARS`).
 */
import { describe, expect, it } from 'vitest';
import { KEPT_CHARS, proseFill } from '@/modules/accounting/services/packs/pages/packProseFill';
import { keptBoundLongest, proseLinesBound } from '@/modules/accounting/services/packs/pages/packProseBound';
import { keptWidthLongest, proseLines } from '@/modules/accounting/services/packs/pages/packProseLines';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';

/** A width function that counts what it is asked, at a flat 0.5em a character. */
function counting(): { calls: number; chars: number; longest: number; widthOf: (t: string, px: number) => number } {
  const out = {
    calls: 0, chars: 0, longest: 0,
    widthOf: (t: string, px: number): number => { out.calls += 1; out.chars += t.length; out.longest = Math.max(out.longest, t.length); return t.length * px * 0.5; },
  };
  return out;
}

const fillMs = (n: number): number => {
  const text = 'x'.repeat(n);
  let best = Infinity;
  for (let run = 0; run < 3; run += 1) {
    const start = performance.now();
    proseFill(text, PROSE.narrativeBody, 110, (t, px) => t.length * px * 0.5);
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

describe('a 100,000-character token with no break in it', () => {
  it('asks for a bounded number of widths, each of a grapheme or two but for the token once', () => {
    const n = 100_000;
    const c = counting();
    const lines = proseFill('x'.repeat(n), PROSE.narrativeBody, 110, c.widthOf);
    expect(lines).toBeGreaterThan(100);
    expect(c.calls).toBeLessThanOrEqual(4 * n);
    // The whole token is measured twice (does it fit; is it wider than the line), every other ask is a grapheme and
    // its neighbour.
    expect(c.chars).toBeLessThanOrEqual(2 * n + 4 * 2 * n);
    expect(c.longest).toBe(n);
  });

  it('takes time linear in its length: four times the token, at most about four times the work', () => {
    fillMs(5_000);
    const quarter = fillMs(25_000);
    const whole = fillMs(100_000);
    // Linear is 4; a step that copies what is left of the token per grapheme is 16.
    expect(whole / Math.max(quarter, 1)).toBeLessThan(9);
  }, 120_000);

  it('leaves nothing longer than KEPT_CHARS in the caches beside the fill, the gate\'s and the page model\'s', () => {
    const long = `Note ${'m'.repeat(5_000)} and ${Array.from({ length: 300 }, (unused, i) => `word${i}`).join('-')}`;
    expect(proseLinesBound(long, PROSE.narrativeBody, 110)).toBeGreaterThan(10);
    expect(proseLines(long, PROSE.narrativeBody, 110)).toBeGreaterThan(10);
    expect(keptBoundLongest()).toBeGreaterThan(0);
    expect(keptBoundLongest()).toBeLessThanOrEqual(KEPT_CHARS);
    expect(keptWidthLongest()).toBeGreaterThan(0);
    expect(keptWidthLongest()).toBeLessThanOrEqual(KEPT_CHARS);
  });
});
