import { describe, it, expect } from 'vitest';
import {
  suggestCodeForName,
  suggestFromDescription,
  suggestFromType,
} from '@/components/accounting/createEntity/glAccountSuggestions';
import type { SelectOption } from '@/components/accounting/BankTxTable';

const opt = (id: string, code: string, name: string): SelectOption =>
  ({ id, code, name }) as SelectOption;

describe('suggestCodeForName', () => {
  it('returns range start when no peers exist', () => {
    expect(suggestCodeForName('expense', 'Anything', [])).toBe('5000');
  });

  it('appends after the highest peer when name sorts last', () => {
    const peers = [
      opt('1', '5100', 'Aaa'),
      opt('2', '5200', 'Bbb'),
    ];
    expect(suggestCodeForName('expense', 'Zzz', peers)).toBe('5210');
  });

  it('slots a free multiple-of-10 code between alphabetic neighbours', () => {
    const peers = [
      opt('1', '5100', 'Aaa'),
      opt('2', '5200', 'Ccc'),
    ];
    const result = suggestCodeForName('expense', 'Bbb', peers);
    expect(Number(result)).toBeGreaterThan(5100);
    expect(Number(result)).toBeLessThan(5200);
    expect(Number(result) % 10).toBe(0);
  });

  it('inserts before the first peer when name sorts first', () => {
    const peers = [
      opt('1', '5100', 'Bbb'),
      opt('2', '5200', 'Ccc'),
    ];
    const result = suggestCodeForName('expense', 'Aaa', peers);
    expect(Number(result)).toBeGreaterThanOrEqual(5000);
    expect(Number(result)).toBeLessThan(5100);
  });

  it('falls back to a free integer when no multiple of 10 is free in the gap', () => {
    const peers = [
      opt('1', '5100', 'Aaa'),
      opt('2', '5110', 'Bbb'),
    ];
    const result = suggestCodeForName('expense', 'Aab', peers);
    expect(Number(result)).toBeGreaterThan(5100);
    expect(Number(result)).toBeLessThan(5110);
    expect(peers.every(p => p.code !== result)).toBe(true);
  });

  it('searches past the boundary when peers fully occupy the alphabetic gap', () => {
    const peers = [
      opt('1', '5000', 'Aaa'),
      opt('2', '5001', 'Bbb'),
    ];
    const result = suggestCodeForName('expense', 'Aab', peers);
    expect(peers.every(p => p.code !== result)).toBe(true);
    expect(Number(result)).toBeGreaterThanOrEqual(5000);
    expect(Number(result)).toBeLessThanOrEqual(5999);
  });

  it('does not return a code already in use by an existing peer', () => {
    const peers = [
      opt('1', '5000', 'Aaa'),
      opt('2', '5010', 'Bbb'),
      opt('3', '5020', 'Ccc'),
    ];
    const result = suggestCodeForName('expense', 'Aab', peers);
    expect(peers.every(p => p.code !== result)).toBe(true);
  });

  it('respects the type range — uses 1000-1999 for asset', () => {
    const code = Number(suggestCodeForName('asset', 'Cash', []));
    expect(code).toBeGreaterThanOrEqual(1000);
    expect(code).toBeLessThanOrEqual(1999);
  });

  it('ignores peers outside the type range', () => {
    const peers = [
      opt('1', '1100', 'Asset'),
      opt('2', '5100', 'Expense'),
    ];
    const result = suggestCodeForName('expense', 'Office', peers);
    expect(Number(result)).toBeGreaterThanOrEqual(5000);
    expect(Number(result)).toBeLessThanOrEqual(5999);
  });

  it('ignores peers with non-numeric codes', () => {
    const peers = [opt('1', 'NA-X', 'Misc')];
    expect(suggestCodeForName('expense', 'Anything', peers)).toBe('5000');
  });

  it('returns next free code when name is empty (append at end)', () => {
    const peers = [
      opt('1', '5100', 'Aaa'),
      opt('2', '5200', 'Bbb'),
    ];
    expect(suggestCodeForName('expense', '   ', peers)).toBe('5210');
  });

  it('falls through to the type code when the type is unknown', () => {
    expect(suggestCodeForName('not-a-type', 'X', [])).toBe('5000');
  });
});

describe('suggestFromDescription', () => {
  it('matches keyword to known suggestion', () => {
    expect(suggestFromDescription('VODACOM AIRTIME 100')).toEqual({
      code: '5640', name: 'Telephone & Communications', type: 'expense',
    });
  });

  it('returns null for empty/missing description', () => {
    expect(suggestFromDescription(undefined)).toBeNull();
    expect(suggestFromDescription('')).toBeNull();
  });

  it('returns null when no keyword matches', () => {
    expect(suggestFromDescription('XYZZY1234567')).toBeNull();
  });
});

describe('suggestFromType', () => {
  it('uses the alphabetic slot for the given type', () => {
    const peers = [opt('1', '5100', 'Aaa')];
    const result = suggestFromType('expense', 'Bbb', peers);
    expect(result.type).toBe('expense');
    expect(Number(result.code)).toBeGreaterThan(5100);
  });

  it('uses the range default name when no account name is provided', () => {
    expect(suggestFromType('asset').name).toBe('Other Asset');
    expect(suggestFromType('liability').name).toBe('Other Liability');
  });
});
