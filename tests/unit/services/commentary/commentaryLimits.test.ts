/**
 * The ONE function every layer costs commentary with. Numbers are pinned so a
 * change to the page's ruler (`packTextMetrics`) that moves the budget is a
 * visible diff here, not a silent shift in what the editor and the server allow.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_APPROVED_PACK_EMS, approxCharsLeft, commentaryEms, editedTextProblem, normaliseEditedText, packEmsUsed,
} from '@/modules/accounting/services/commentary/commentaryLimits';
import { textWidthEms } from '@/modules/accounting/services/packs/pages/packTextMetrics';

describe('commentaryEms', () => {
  const JOIN = textWidthEms(' ');

  it('trims, and an empty text costs only the joining space', () => {
    expect(commentaryEms('  abc \n')).toBe(commentaryEms('abc'));
    expect(commentaryEms('')).toBeCloseTo(JOIN, 9);
    expect(JOIN).toBeCloseTo(0.26, 9);
  });

  it('never costs less than the width the page ruler gives the words', () => {
    for (const t of ['Revenue grew', 'WWWW MMMM', '收入增长是因为', 'a'.repeat(200), '1234 5678 90']) {
      expect(commentaryEms(t)).toBeGreaterThanOrEqual(textWidthEms(t.trim()) + JOIN - 1e-9);
    }
  });

  it('charges ordinary words about their width, so prose is nearly unaffected', () => {
    const prose = 'Revenue grew because the two largest contracts renewed and the Gauteng rollout reached full billing.';
    const ratio = (commentaryEms(prose) - JOIN) / textWidthEms(prose);
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(1.25);
  });

  it('charges a word a line cannot share by the line it takes: a word just over half a line costs about twice its width', () => {
    // 28 em lines beside the panel, 44 stacked. A 28-character word is ~13 ems: two to a line.
    const half = (n: number) => (commentaryEms('a'.repeat(n)) - JOIN) / textWidthEms('a'.repeat(n));
    expect(half(28)).toBeLessThan(1.15);
    expect(half(31)).toBeGreaterThan(1.8);
    // A word wider than any line is charged whole lines.
    const wide = 'a'.repeat(400);
    expect(commentaryEms(wide) - JOIN).toBeGreaterThanOrEqual(textWidthEms(wide));
  });

  it('charges by glyph width, not by count: capitals and CJK cost more than lowercase', () => {
    expect(commentaryEms('WWWW')).toBeGreaterThan(commentaryEms('aaaa') * 1.5);
    expect(commentaryEms('收入增长')).toBeGreaterThan(commentaryEms('aaaa') * 1.5);
  });
});

describe('packEmsUsed', () => {
  it('sums only approved rows with text', () => {
    const rows = [
      { status: 'approved', approvedText: 'one' },
      { status: 'draft', approvedText: 'not counted' },
      { status: 'rejected', approvedText: 'not counted either' },
      { status: 'approved', approvedText: null },
      { status: 'approved', approvedText: 'two' },
    ];
    expect(packEmsUsed(rows)).toBeCloseTo(commentaryEms('one') + commentaryEms('two'), 9);
  });

  it('is zero for no rows', () => {
    expect(packEmsUsed([])).toBe(0);
  });
});

describe('approxCharsLeft', () => {
  it('turns room into ordinary-prose characters, never negative', () => {
    expect(approxCharsLeft(MAX_APPROVED_PACK_EMS)).toBe(1244);
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
  it('calls control characters and lone surrogates invalid', () => {
    for (const bad of ['a\u0000', '\u0001', '\u007f', '\ud800', 'a\udfffb']) expect(editedTextProblem(bad)).toBe('invalid');
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
