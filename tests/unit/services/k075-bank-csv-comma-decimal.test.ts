/**
 * The K-075 defect, in its second home.
 *
 * `bankCsvParserUtils.parseAmount` carries the identical non-global
 * `.replace(',', '.')`: with both a comma thousands separator and a comma
 * decimal, only the first comma became a point and `parseFloat` stopped at the
 * thousands group. A statement row of R1 234,56 imported as 1.23.
 */
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@/modules/accounting/utils/bankCsvParserUtils';

describe('K-075 bank CSV comma decimals', () => {
  it('reads comma thousands together with a comma decimal', () => {
    expect(parseAmount('1,234,56')).toBe(1234.56);
  });

  it('still reads the space-thousands SA form', () => {
    expect(parseAmount('1 234,56')).toBe(1234.56);
  });

  it('still reads the US point-decimal form', () => {
    expect(parseAmount('1,234.56')).toBe(1234.56);
  });

  it('leaves a whole-rand amount alone', () => {
    expect(parseAmount('1234')).toBe(1234);
  });

  it('keeps a negative sign', () => {
    expect(parseAmount('-1,234,56')).toBe(-1234.56);
  });

  it('returns null on an empty cell', () => {
    expect(parseAmount('')).toBeNull();
  });
});
