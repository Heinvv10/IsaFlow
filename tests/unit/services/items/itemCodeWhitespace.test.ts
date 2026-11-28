/**
 * ITEM_CODE_WHITESPACE is exactly what JS String.prototype.trim() strips (the BMP code points that trim to ''), so the
 * SQL btrim and the JS trim agree on what a stored code is.
 */
import { describe, expect, it } from 'vitest';
import { ITEM_CODE_WHITESPACE } from '@/modules/accounting/services/items/itemCodeWhitespace';

describe('ITEM_CODE_WHITESPACE', () => {
  it('is exactly the ECMAScript WhiteSpace + LineTerminator set (hand-written, independent of the implementation)', () => {
    const spec = [
      0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
      0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
      0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
    ];
    const actual = [...ITEM_CODE_WHITESPACE].map((c) => c.charCodeAt(0)).sort((a, b) => a - b);
    expect(actual).toEqual(spec);
  });

  it('holds every code point trim() strips, and nothing else', () => {
    const expected: number[] = [];
    for (let i = 0; i <= 0xffff; i++) if (String.fromCharCode(i).trim() === '') expected.push(i);
    const actual = [...ITEM_CODE_WHITESPACE].map((c) => c.charCodeAt(0)).sort((a, b) => a - b);
    expect(actual).toEqual(expected);
    expect(expected).toContain(0x202f);
    expect(expected).toContain(0x3000);
    expect(expected).toContain(0x1680);
  });
});
