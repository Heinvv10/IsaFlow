/**
 * The ONE function every layer costs commentary with. Numbers are pinned so a
 * change to the page's ruler (`packTextMetrics`) that moves the budget is a
 * visible diff here, not a silent shift in what the editor and the server allow.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_APPROVED_PACK_EMS, approxCharsLeft, commentaryCost, editedTextProblem, normaliseEditedText,
} from '@/modules/accounting/services/commentary/commentaryLimits';
import {
  PAGE_WIDTH_MM, emsPerLine, wrapEms,
} from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { GUTTER_MM } from '@/modules/accounting/services/packs/pages/packDisclosureHeight';

describe('commentaryCost', () => {
  const PERLINE = [emsPerLine(10, PAGE_WIDTH_MM.portrait), emsPerLine(10, (PAGE_WIDTH_MM.portrait - GUTTER_MM) * (2 / 3))];

  it('is zero for nothing, and ignores blank rows and padding', () => {
    expect(commentaryCost([])).toBe(0);
    expect(commentaryCost(['', '  '])).toBe(0);
    expect(commentaryCost(['  abc \n'])).toBe(commentaryCost(['abc']));
  });

  it('IS the page wrapper: the worse of lines x line-ems at the two prose measures, on the joined paragraph', () => {
    const texts = ['Revenue grew on the Gauteng rollout.', 'Costs were held flat.', 'a'.repeat(46), 'W'.repeat(26), 'i'];
    const joined = texts.join(' ');
    expect(commentaryCost(texts)).toBe(Math.max(...PERLINE.map((p) => wrapEms(joined, p) * p)));
  });

  it('costs the JOIN, in order, not the rows one by one: two half-line rows share a line', () => {
    const half = 'word '.repeat(5).trim();
    expect(commentaryCost([half, half])).toBeLessThan(commentaryCost([half]) * 2);
  });

  it('charges alternating line-wide and short words what the page sets them in', () => {
    const alt = Array.from({ length: 30 }, () => `${'a'.repeat(46)} a`).join(' ');
    const uniform = Array.from({ length: 30 }, () => 'a'.repeat(46)).join(' ');
    expect(commentaryCost([alt])).toBeGreaterThanOrEqual(commentaryCost([uniform]));
  });

  it('charges by glyph width, not by count: capitals and CJK cost more than lowercase', () => {
    const run = (ch: string) => ch.repeat(300);
    expect(commentaryCost([run('W')])).toBeGreaterThan(commentaryCost([run('a')]) * 1.3);
    expect(commentaryCost([run('收')])).toBeGreaterThan(commentaryCost([run('a')]) * 1.5);
  });
});

describe('approxCharsLeft', () => {
  it('turns room into ordinary-prose characters, never negative', () => {
    expect(approxCharsLeft(MAX_APPROVED_PACK_EMS)).toBe(Math.floor(MAX_APPROVED_PACK_EMS / 0.45));
    expect(approxCharsLeft(0)).toBe(0);
    expect(approxCharsLeft(-50)).toBe(0);
  });
});

describe('editedTextProblem', () => {
  it('accepts ordinary text, newlines, tabs and a surrogate pair', () => {
    for (const ok of ['Fine.', 'a\nb', 'a\tb', 'x 😀']) expect(editedTextProblem(ok)).toBeNull();
  });
  it('calls text with no visible character empty', () => {
    for (const blank of ['', ' ', '​', '﻿⁠', ' ­ ']) expect(editedTextProblem(blank)).toBe('empty');
  });
  // ONE CASE PER CHARACTER OR RANGE, so removing any of them goes red on its own.
  it.each([
    ['Hangul choseong filler U+115F', '\u115f'], ['Hangul jungseong filler U+1160', '\u1160'],
    ['Hangul filler U+3164', '\u3164'], ['halfwidth Hangul filler U+FFA0', '\uffa0'],
    ['braille blank U+2800', '\u2800'],
    ['Khmer inherent vowel U+17B4', '\u17b4'], ['Khmer inherent vowel U+17B5', '\u17b5'],
    ['combining grapheme joiner U+034F', '\u034f'],
    ['variation selector U+FE00', '\ufe00'], ['variation selector U+FE0F', '\ufe0f'],
    ['Mongolian variation selector U+180B', '\u180b'], ['U+180C', '\u180c'], ['U+180D', '\u180d'],
    ['variation selector supplement U+E0100', '\u{e0100}'], ['U+E01EF', '\u{e01ef}'],
    ['a combining acute accent alone U+0301', '\u0301'], ['marks only U+0301 U+0308 U+20DD', '\u0301\u0308\u20dd'],
  ])('calls %s empty, alone and among spaces', (_name, ch) => {
    expect(editedTextProblem(ch)).toBe('empty');
    expect(editedTextProblem(` ${ch} ${ch}`)).toBe('empty');
  });
  it('but one visible character among blank ones is text, and a mark on a letter is text', () => {
    expect(editedTextProblem('\u3164a\u2800')).toBeNull();
    expect(editedTextProblem('e\u0301')).toBeNull();
  });
  it('calls control characters and lone surrogates invalid', () => {
    for (const bad of ['a\u0000', '\u0001', '\u007f', '\u0080', 'a\u0085b', '\u009f', '\ud800', 'a\udfffb']) expect(editedTextProblem(bad)).toBe('invalid');
  });
});

describe('normaliseEditedText', () => {
  it('turns CRLF and a lone CR into LF, then trims', () => {
    expect(normaliseEditedText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    expect(normaliseEditedText('  \r\n x \r ')).toBe('x');
  });
  it('leaves nothing for editedTextProblem to refuse as a carriage return', () => {
    expect(editedTextProblem(normaliseEditedText('line one\r\nline two\rthree'))).toBeNull();
  });
});
