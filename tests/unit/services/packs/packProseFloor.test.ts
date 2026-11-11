/**
 * THE FLOOR UNDER PROSE THE FACES DO NOT FULLY SET (#1264 round 9, Hein 11-11): a text holding one code point the pack's
 * faces do not set is priced at max(the width model, the pre-#1263 em model) in lines, in the page model
 * (`proseLines`), the commentary gate (`proseLinesBound`) and the commentary cost; a text the faces set in full keeps the
 * width model's lines. Nothing here names a script or a sequence: the trigger is the code point, the floor the em model.
 */
import { describe, expect, it } from 'vitest';
import { commentaryCost } from '@/modules/accounting/services/commentary/commentaryLimits';
import { proseLinesBound } from '@/modules/accounting/services/packs/pages/packProseBound';
import { holdsUnsetCodePoint } from '@/modules/accounting/services/packs/pages/packProseFloor';
import { PAST_ANY_PAGE, PROSE_TEXT_CAP } from '@/modules/accounting/services/packs/pages/packProseFill';
import { proseLines } from '@/modules/accounting/services/packs/pages/packProseLines';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { GUTTER_MM, PAGE_WIDTH_MM, PT_MM, wrappedLines } from '@/modules/accounting/services/packs/pages/packTextMetrics';

const S = String.fromCodePoint;
const W = PAGE_WIDTH_MM.portrait;
const NARROW_MEASURE = ((W - GUTTER_MM) * 2) / 3;
const CELLS = [
  ['narrative', PROSE.narrativeBody, W], ['narrative, beside the panel', PROSE.narrativeBody, NARROW_MEASURE],
  ['matters cell', PROSE.mattersCell, 52.8], ['disclosure', PROSE.disclosureBody, W],
] as const;
/** Narrow letters: the faces set them at far less than the em model charges (7 lines against 9 at the narrative's measure). */
const NARROW = 'i l i l '.repeat(150);
const em = (text: string, style: { pt: number }, mm: number): number => wrappedLines(text, style.pt, mm);

describe('a text the faces set in full keeps the width model (not floored)', () => {
  it('lines of narrow letters are fewer than the em model reads, in the page model and the gate', () => {
    for (const [name, style, mm] of CELLS) {
      expect(proseLines(NARROW, style, mm), name).toBeLessThan(em(NARROW, style, mm));
      if (style.weight === 400) expect(proseLinesBound(NARROW, style, mm), name).toBeLessThan(em(NARROW, style, mm));
    }
  });

  it('white space that prints nothing (a tab, a line feed, a carriage return) is no code point the faces lack', () => {
    const paragraphs = Array.from({ length: 150 }, () => 'i l i l').join('\n\n').concat('\t\r\n');
    expect(paragraphs).toContain('\n\n');
    for (const [name, style, mm] of CELLS) expect(proseLines(paragraphs, style, mm), name).toBeLessThan(em(paragraphs, style, mm));
  });

  it('holdsUnsetCodePoint: a control character the faces lack (NUL, vertical tab, escape) is a glyph production draws in a fallback face', () => {
    for (const cp of [0x00, 0x0b, 0x0c, 0x1b, 0x7f, 0x85]) expect(holdsUnsetCodePoint(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe(true);
  });

  it('holdsUnsetCodePoint: Latin, Latin-1, Cyrillic, Greek and the pack\'s punctuation are set; collapsible space is no glyph', () => {
    for (const text of ['Plain text, 123.', 'Café Ñoño ń Ł', 'Привет Αβγ', '– ‘q’ … € → ✓', 'a b­c​d‌e‍f', 'a\nb\tc\rd', '']) {
      expect(holdsUnsetCodePoint(text), JSON.stringify(text)).toBe(false);
    }
  });
});

describe('a text with one code point the faces do not set is priced at least at the em model, in lines', () => {
  const ONE_UNSET: Array<[string, string]> = [
    ['CJK at the end', `${NARROW}${S(0x4e2d)}`], ['an astral emoji at the end', `${NARROW}${S(0x1f600)}`], ['a noncharacter at the start', `${S(0xffff)}${NARROW}`],
    ['Khmer consonants joined by ZWNJ (blind M1 of round 8)', `${S(0x1780, 0x200c, 0x1780)} ${NARROW}`],
    ['a keycap mark after a letter, then symbols the primary face lacks (H1 of round 8)', `${S(0x61, 0x20e3, 0x20)}${`${S(0x266e)} `.repeat(200)}${NARROW}`],
    ['dakuten after kana, then symbols (H1)', `${S(0x3042, 0x3099, 0x20)}${`${S(0x266e)} `.repeat(200)}`],
  ];

  it.each(ONE_UNSET)('%s: the page model\'s lines are at least the em model\'s', (name, text) => {
    expect(holdsUnsetCodePoint(text), name).toBe(true);
    for (const [cell, style, mm] of CELLS) expect(proseLines(text, style, mm), `${name} / ${cell}`).toBeGreaterThanOrEqual(em(text, style, mm));
  });

  it.each(ONE_UNSET)('%s: the gate\'s lines are at least the em model\'s (and the page model\'s)', (name, text) => {
    for (const [cell, style, mm] of CELLS.filter(([, style]) => style.weight === 400)) {
      expect(proseLinesBound(text, style, mm), `${name} / ${cell}`).toBeGreaterThanOrEqual(em(text, style, mm));
      expect(proseLinesBound(text, style, mm), `${name} / ${cell}`).toBeGreaterThanOrEqual(proseLines(text, style, mm));
    }
  });

  it('raises the lines of text the width model reads fewer: narrow letters and one ideograph are the em model\'s lines (9), not 7', () => {
    const text = `${NARROW}${S(0x4e2d)}`;
    expect(proseLines(NARROW, PROSE.narrativeBody, W)).toBe(7);
    expect(proseLines(text, PROSE.narrativeBody, W)).toBe(em(text, PROSE.narrativeBody, W));
    expect(proseLines(text, PROSE.narrativeBody, W)).toBe(9);
    expect(proseLinesBound(text, PROSE.narrativeBody, W)).toBe(9);
  });

  it('a short text (under the lines cache\'s 1,000 characters) is floored too: 40 narrow words and one ideograph are 3 lines, not 2', () => {
    const faces = 'i l i l '.repeat(40);
    const text = `${faces}${S(0x4e2d)}`;
    expect(proseLines(faces, PROSE.narrativeBody, W)).toBe(2);
    expect(proseLines(text, PROSE.narrativeBody, W)).toBe(3);
    expect(proseLinesBound(text, PROSE.narrativeBody, W)).toBe(3);
    expect([proseLines(faces, PROSE.mattersCell, 52.8), proseLines(text, PROSE.mattersCell, 52.8)]).toEqual([5, 7]);
  });

  it('prices segments as the text they join (a note\'s heading in the bold, its body in the regular)', () => {
    const segments = [{ text: `${NARROW}`, weight: PROSE.tableNoteLabel.weight }, { text: `${S(0x4e2d)} ${NARROW}`, weight: PROSE.tableNote.weight }];
    const joined = segments.map((s) => s.text).join('');
    expect(proseLines(segments, PROSE.tableNote, 100)).toBeGreaterThanOrEqual(em(joined, PROSE.tableNote, 100));
    const faces = [{ text: NARROW, weight: PROSE.tableNoteLabel.weight }, { text: NARROW, weight: PROSE.tableNote.weight }];
    expect(proseLines(faces, PROSE.tableNote, 100)).toBeLessThan(em(NARROW + NARROW, PROSE.tableNote, 100));
  });

  it('a text past the prose cap is still charged past any page, not lowered to the em model', () => {
    expect(proseLines(`${S(0x4e2d)}${'a'.repeat(PROSE_TEXT_CAP)}`, PROSE.narrativeBody, W)).toBe(PAST_ANY_PAGE);
  });
});

describe('the commentary cost carries the floor', () => {
  const MEASURES_MM = [W, NARROW_MEASURE];
  const floorEms = (text: string): number => Math.max(...MEASURES_MM.map((mm) => em(text, PROSE.narrativeBody, mm) * (mm / (PROSE.narrativeBody.pt * PT_MM))));

  it('is never under the em model\'s lines x measure for a text holding a code point the faces lack', () => {
    for (const text of [`${NARROW}${S(0x4e2d)}`, `${S(0x61, 0x20e3, 0x20)}${`${S(0x23d0)} `.repeat(300)}`, `${S(0x1000, 0x200c, 0x1000)} `.repeat(150)]) {
      expect(commentaryCost([text])).toBeGreaterThanOrEqual(floorEms(text) - 1e-9);
    }
  });

  it('is lower for the same narrow letters when the faces set them all', () => {
    expect(commentaryCost([NARROW])).toBeLessThan(floorEms(NARROW));
    expect(commentaryCost([`${NARROW}${S(0x4e2d)}`])).toBeGreaterThan(commentaryCost([NARROW]));
  });
});
