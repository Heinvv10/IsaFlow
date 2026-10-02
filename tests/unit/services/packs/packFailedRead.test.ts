/**
 * WHICH FAILURES A DEGRADING READ MAY ANSWER WITH AN ABSENCE.
 *
 * The first version degraded on any SQLSTATE except 25P02. That let a missing
 * table (42P01), a missing column (42703), a bad cast (22P02) or a constraint
 * violation (23xxx) print as "no comparative" behind a single warn — defects
 * in this code or this schema, presented to a board as a quiet gap. And its
 * five-character test also matched Node's own error codes: `EPIPE` is five
 * capital letters.
 *
 * It is an ALLOWLIST of operational classes now. Everything else is thrown.
 */
import { describe, expect, it } from 'vitest';
import { isFailedRead } from '@/modules/accounting/services/packs/packFailedRead';

const withCode = (code: unknown): Error => Object.assign(new Error('x'), { code });

describe('isFailedRead', () => {
  it.each([
    ['08006', 'connection failure'],
    ['08P01', 'protocol violation'],
    ['40001', 'serialization failure'],
    ['40P01', 'deadlock detected'],
    ['53100', 'disk full'],
    ['53300', 'too many connections'],
    ['55P03', 'lock not available'],
    ['55006', 'object in use'],
    ['57014', 'statement timeout / query cancelled'],
    ['57P01', 'admin shutdown'],
    ['58000', 'system error'],
    ['58030', 'io error'],
  ])('degrades on %s (%s)', (code) => {
    expect(isFailedRead(withCode(code))).toBe(true);
  });

  it.each([
    ['42P01', 'undefined table'],
    ['42703', 'undefined column'],
    ['42883', 'undefined function'],
    ['42601', 'syntax error'],
    ['42501', 'insufficient privilege'],
    ['22P02', 'invalid text representation'],
    ['22008', 'datetime field overflow'],
    ['22012', 'division by zero'],
    ['23505', 'unique violation'],
    ['23503', 'foreign key violation'],
    ['XX000', 'internal error'],
    ['P0001', 'raise exception'],
    ['3B001', 'savepoint does not exist'],
    ['0A000', 'feature not supported'],
    ['25P02', 'the transaction was already aborted'],
    ['25006', 'read only transaction'],
    ['99999', 'a class nobody has defined'],
  ])('re-throws on %s (%s)', (code) => {
    expect(isFailedRead(withCode(code))).toBe(false);
  });

  it.each([
    ['EPIPE'], ['ECONNRESET'], ['ETIMEDOUT'], ['ENOTFOUND'], ['ERR_ASSERTION'],
  ])('does not mistake the Node error code %s for a SQLSTATE', (code) => {
    expect(isFailedRead(withCode(code))).toBe(false);
  });

  it.each([
    ['a five-letter code that only looks like a class', '57abc'],
    ['a code of the wrong length', '5701'],
    ['a longer code that starts like one', '570145'],
    ['a numeric code', 57014],
    ['no code at all', undefined],
  ])('does not degrade on %s', (_what, code) => {
    expect(isFailedRead(withCode(code))).toBe(false);
  });

  it('does not degrade on something that is not an Error, whatever it carries', () => {
    expect(isFailedRead({ code: '57014' })).toBe(false);
    expect(isFailedRead('57014')).toBe(false);
    expect(isFailedRead(null)).toBe(false);
    expect(isFailedRead(new TypeError('x is not a function'))).toBe(false);
  });
});
