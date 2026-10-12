/**
 * One reading of a server's warning list for every screen that shows one:
 * coerced to text, never dropped — but a value that says nothing (blank, {},
 * [], false, 0, null) is no warning, so a clean answer never reads "with problems".
 */
import { describe, it, expect } from 'vitest';
import { warningMessages } from '@/lib/warningMessages';

describe('warningMessages', () => {
  it('a lone value is a list of one; strings are trimmed; repeats go', () => {
    expect(warningMessages('  Auto-post failed  ')).toEqual(['Auto-post failed']);
    expect(warningMessages(['A', ' A ', 'B', 'A'])).toEqual(['A', 'B']);
  });

  it('objects by their error or message, else as JSON; other scalars as text', () => {
    expect(warningMessages([{ error: 'E1' }, { message: 'M1' }, { code: 7 }, 7, true])).toEqual(['E1', 'M1', '{"code":7}', '7', 'true']);
  });

  it.each([[undefined], [null], [''], ['   '], [{}], [[]], [[[]]], [[{}]], [false], [0], [[null, '', ' ', {}, false, 0]]])('%j says nothing', (v) => {
    expect(warningMessages(v)).toEqual([]);
  });
});
