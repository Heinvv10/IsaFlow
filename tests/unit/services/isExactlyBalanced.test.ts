import { describe, expect, it } from 'vitest';
import { isExactlyBalanced } from '@/modules/accounting/services/bank/reconciliationBalanced';

describe('isExactlyBalanced', () => {
  it.each([
    [0, true], [-0, true], ['0', true], ['0.00', true],
    [0.01, false], [-0.01, false], ['0.01', false], ['-0.01', false],
    [0.005, false], [1e-9, true], [-1e-9, true], [NaN, false], ['abc', false], ['', false], ['  ', false], [-0.005, false],
  ] as const)('%s -> %s', (d, expected) => {
    expect(isExactlyBalanced(d)).toBe(expected);
  });
});
