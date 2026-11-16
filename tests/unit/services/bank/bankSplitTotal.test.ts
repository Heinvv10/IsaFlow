/** WP2 row 11: the split-total rule both split paths ask — integer cents, exact, both totals named in rands. */
import { describe, it, expect } from 'vitest';
import { splitTotalMismatch } from '@/modules/accounting/services/bank/bankSplitTotal';

describe('splitTotalMismatch', () => {
  it('passes lines equal to the line in cents, float noise and either sign of the line', () => {
    expect(splitTotalMismatch([0.1, 0.2], -0.3)).toBeNull();
    expect(splitTotalMismatch([0.1, 0.2], 0.3)).toBeNull();
    expect(splitTotalMismatch([282543.34], -282543.34)).toBeNull();
  });

  it('refuses one cent either way, which the old 0.01 float tolerance let through', () => {
    expect(5.01 - 5.0).toBeLessThan(0.01); // the hole: IEEE-754 puts this under the old tolerance
    expect(splitTotalMismatch([2.51, 2.5], -5)).toBe(
      'Split lines total R 5.01 does not equal the transaction amount R 5.00. Nothing was posted.');
    expect(splitTotalMismatch([2.49, 2.5], -5)).toBe(
      'Split lines total R 4.99 does not equal the transaction amount R 5.00. Nothing was posted.');
  });
});
