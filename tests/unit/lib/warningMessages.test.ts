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
    expect(warningMessages([{ error: 'E1' }, { message: 'M1' }, { code: 7 }, 7])).toEqual(['E1', 'M1', '{"code":7}', '7']);
  });

  it.each([[undefined], [null], [''], ['   '], [{}], [[]], [[[]]], [[{}]], [false], [true], [[true, false]], [0], [[null, '', ' ', {}, false, 0]], [{ warnings: [] }], [{ error: '', message: '  ' }], [{ a: { b: [] }, c: '' }], [{ ok: true }]])('%j says nothing', (v) => {
    expect(warningMessages(v)).toEqual([]);
  });

  it('takes the first NON-EMPTY of error and message', () => {
    expect(warningMessages({ error: '', message: 'x' })).toEqual(['x']);
    expect(warningMessages({ error: '  ', message: ' y ' })).toEqual(['y']);
    expect(warningMessages({ error: 'E', message: 'M' })).toEqual(['E']);
  });

  it('an object with real content elsewhere is kept as JSON', () => {
    expect(warningMessages({ warnings: ['W'] })).toEqual(['{"warnings":["W"]}']);
  });
});
