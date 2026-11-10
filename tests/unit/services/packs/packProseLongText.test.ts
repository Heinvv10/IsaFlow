/**
 * A JOURNAL DESCRIPTION OF ANY LENGTH COMPOSES AT ONCE (#1263 round 2, the adversary's M1). Matters carry a journal's
 * description, unbounded text, into the page model on every fit attempt; three paths took time that grew faster than it:
 * `Intl.Segmenter` on one long run (astral ideographs, emoji, flags, Hangul, marks), the ruler on a long run of marks, a
 * trailing-run regex on ideographic spaces, and a long text measured anew each attempt (and the blind review's families). Each of the adversary's inputs (and the worst below
 * the cap) is timed here through the segmenter, one `proseLines` and the whole dense pack. Prose past `PROSE_TEXT_CAP` is
 * charged as fitting no page, unmeasured; below it, as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { graphemes } from '@/modules/accounting/services/packs/pages/packGraphemes';
import { pieces } from '@/modules/accounting/services/packs/pages/packLineBreaks';
import { IGNORABLE_CAP, PAST_ANY_PAGE, PROSE_TEXT_CAP } from '@/modules/accounting/services/packs/pages/packProseFill';
import { keptLongLines, proseLines } from '@/modules/accounting/services/packs/pages/packProseLines';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { denseInput } from './fixtures/boardPackInputs';

const INPUTS: ReadonlyArray<readonly [string, string]> = [
  ['"e" and 200,000 acute accents', `e${'\u0301'.repeat(200_000)}`],
  ['"e" and 100,000 acute accents', `e${'\u0301'.repeat(100_000)}`],
  ['"e" and 49,000 acute accents (under the cap)', `e${'\u0301'.repeat(49_000)}`],
  ['U+20000 x 100,000', '\u{20000}'.repeat(100_000)],
  ['U+20000 x 24,000 (under the cap)', '\u{20000}'.repeat(24_000)],
  ['thumbs up, skin tone, x 50,000', '\u{1F44D}\u{1F3FD}'.repeat(50_000)],
  ['thumbs up, skin tone, x 12,000 (under the cap)', '\u{1F44D}\u{1F3FD}'.repeat(12_000)],
  ['a regional indicator x 100,000', '\u{1F1FF}'.repeat(100_000)],
  ['a Hangul syllable x 49,000 (under the cap)', '\uAC01'.repeat(49_000)],
  ['a Hangul syllable x 128,000', '\uAC00'.repeat(128_000)],
  ['U+3000 x 128,000 and a ZWSP', `${'\u3000'.repeat(127_999)}\u200B`],
  ['U+3000 x 48,000 and a ZWSP (under the cap)', `${'\u3000'.repeat(47_999)}\u200B`],
  ['"a" with an acute accent x 64,000', 'a\u0301'.repeat(64_000)],
  ['"a" with an acute accent x 24,000 (under the cap)', 'a\u0301'.repeat(24_000)],
  ['a grinning face x 64,000', '\u{1F600}'.repeat(64_000)],
  ['a grinning face x 24,000 (under the cap)', '\u{1F600}'.repeat(24_000)],
];
const elapsed = (fn: () => unknown): number => { const start = performance.now(); fn(); return performance.now() - start; };

describe('tenant text of any length', () => {
  it.each(INPUTS)('%s: segmented and measured well under a second', (unused, text) => {
    expect(elapsed(() => graphemes(text))).toBeLessThan(1_000);
    expect(elapsed(() => proseLines(text, PROSE.mattersCell, 90.7))).toBeLessThan(1_000);
  });

  it.each(INPUTS)('%s: the dense company\'s pack, with it in every journal description, composes (or is refused) in seconds, not minutes', (unused, text) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const input = { ...denseInput, matters: denseInput.matters.map((m) => ({ ...m, issue: `Journal JE-2026-00061 (recorded well after its entry date): ${text}` })) };
      // Master composed these in 7 to 16ms of model time; the round-1 branch took 27s to 175s. The bound leaves room for a
      // loaded machine: the work is under half a second here.
      expect(elapsed(() => { try { buildBoardPackPages(input); } catch (err) { if (!(err instanceof PackRefusal)) throw err; } })).toBeLessThan(3_000);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it.each(['\uFEFF', '\u200B', '\u2060', '\u200E', '\u2061', '\u2062', '\u2063', '\u2064', '\u206A', '\u206F', '\u2066', '\u2067', '\u2068', '\u2069', '\u00AD'])(
    'U+%s, characters that print nothing, at the cap and at IGNORABLE_CAP in every journal: the pack composes in well under a second',
    (ch) => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      try {
        for (const n of [PROSE_TEXT_CAP - 160, IGNORABLE_CAP]) {
          const input = { ...denseInput, matters: denseInput.matters.map((m) => ({ ...m, issue: `Journal JE-2026-00061 (recorded well after its entry date): ${ch.repeat(n)}` })) };
          expect(elapsed(() => { try { buildBoardPackPages(input); } catch (err) { if (!(err instanceof PackRefusal)) throw err; } }), `${n}`).toBeLessThan(1_000);
        }
      } finally {
        warn.mockRestore();
      }
    },
    30_000,
  );

  it('splits a long run of ideographic spaces before a ZWSP in linear time (the trailing-run regex was quadratic)', () => {
    expect(elapsed(() => pieces(`${'\u3000'.repeat(127_999)}\u200B`))).toBeLessThan(1_000);
  });

  it('keeps the lines of the long texts it has measured, a bounded few, so the fit\'s attempts do not measure them again', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const text = `Revenue grew on the rollout. ${'x'.repeat(1_200)}`;
      try {
        buildBoardPackPages({ ...denseInput, matters: denseInput.matters.map((m) => ({ ...m, issue: `Journal JE-2026-00061 (recorded well after its entry date): ${text}` })) });
      } catch (err) {
        if (!(err instanceof PackRefusal)) throw err;
      }
    } finally {
      warn.mockRestore();
    }
    expect(keptLongLines()).toBeGreaterThan(0);
    expect(keptLongLines()).toBeLessThanOrEqual(32);
  });

  it('is measured in full up to PROSE_TEXT_CAP, and past it charged as fitting no page', () => {
    const under = 'i '.repeat(PROSE_TEXT_CAP / 2);
    expect(under.length).toBe(PROSE_TEXT_CAP);
    const lines = proseLines(under, PROSE.footnote, PAGE_MM);
    expect(lines).toBeGreaterThan(60);
    expect(lines).toBeLessThan(PAST_ANY_PAGE);
    expect(proseLines(`${under}i`, PROSE.footnote, PAGE_MM)).toBe(PAST_ANY_PAGE);
  });
});

const PAGE_MM = 168;
