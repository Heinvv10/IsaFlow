/** shownPosition / numberLines: a row keeps the number the user saw, even after a form drops blank rows before sending. */
import { describe, it, expect } from 'vitest';
import { shownPosition, numberLines } from '@/lib/lineNumbers';

describe('shownPosition', () => {
  it.each([[4, 9, 4], [1, 9, 1], [0, 9, 9], [-1, 9, 9], [2.5, 9, 9], ['4', 9, 9], [null, 9, 9], [undefined, 9, 9], [NaN, 9, 9], [Number.MAX_SAFE_INTEGER + 2, 9, 9]])(
    'claimed %j, fallback %i -> %i', (claimed, fallback, want) => { expect(shownPosition(claimed, fallback)).toBe(want); });
});

describe('numberLines', () => {
  it('numbers by position before the blanks are dropped', () => {
    const lines = [{ d: 'a' }, { d: '' }, { d: 'c' }, { d: '' }, { d: 'e' }];
    expect(numberLines(lines, (l) => l.d !== '')).toEqual([{ d: 'a', lineNo: 1 }, { d: 'c', lineNo: 3 }, { d: 'e', lineNo: 5 }]);
  });
});
