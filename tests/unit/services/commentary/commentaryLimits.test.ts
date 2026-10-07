/**
 * The ONE function every layer costs commentary with. Numbers are pinned so a
 * change to the page's ruler (`packTextMetrics`) that moves the budget is a
 * visible diff here, not a silent shift in what the editor and the server allow.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_APPROVED_PACK_EMS, approxCharsLeft, commentaryEms, editedTextProblem, packEmsUsed,
} from '@/modules/accounting/services/commentary/commentaryLimits';
import { textWidthEms } from '@/modules/accounting/services/packs/pages/packTextMetrics';

describe('commentaryEms', () => {
  it('is the page ruler on the trimmed text plus one joining space', () => {
    expect(commentaryEms('abc')).toBeCloseTo(3 * 0.47 + 0.26, 6);
    expect(commentaryEms('  abc \n')).toBe(commentaryEms('abc'));
    expect(commentaryEms('')).toBeCloseTo(0.26, 6);
    expect(commentaryEms('Revenue grew')).toBeCloseTo(textWidthEms('Revenue grew') + 0.26, 6);
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
    expect(approxCharsLeft(MAX_APPROVED_PACK_EMS)).toBe(1000);
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
    for (const bad of ['a\u0000', '\u0001', 'a\rb', '\u007f', '\ud800', 'a\udfffb']) expect(editedTextProblem(bad)).toBe('invalid');
  });
});
