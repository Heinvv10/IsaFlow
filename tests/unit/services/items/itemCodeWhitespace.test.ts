/**
 * ITEM_CODE_WHITESPACE is exactly what JS String.prototype.trim() strips (the BMP code points that trim to ''), so the
 * SQL btrim and the JS trim agree on what a stored code is.
 */
import { describe, expect, it } from 'vitest';
import { ITEM_CODE_WHITESPACE } from '@/modules/accounting/services/items/itemCodeWhitespace';

describe('ITEM_CODE_WHITESPACE', () => {
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
