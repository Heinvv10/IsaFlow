/**
 * WHERE UNICODE'S NUMERIC RULE HOLDS A BREAK THE PAIR TABLE WOULD TAKE (UAX 14 LB25, as production's Chromium applies it).
 *
 * The pair table (`packBreakPairs.ts`) reads one character either side of a pair. The numeric rule reads further: no
 * break before a postfix or prefix sign after a number and its separators and closing bracket ("1.)\u2030",
 * "1/:\u2033"), and none after a prefix or postfix sign before an opening bracket or a hyphen, a separator and a digit
 * ("\u20AC(.5", "\u2212(.5"). Measured in production's image: the table broke there in 930 of 18,630 numeric strings
 * (#1235 round 4), where production holds; with this rule, in none (`packBreakPairs.test.ts`,
 * `printParity/packBreakPairsImage.test.ts`). It only ever holds a break, never adds one.
 *
 * Classes are Unicode 17.0's (`packNumericClassData.ts`); a code point outside them is no part of a number.
 */
import { NUMERIC_CLASS_RANGES } from './packNumericClassData';

const NU = 0;
const SY = 1;
const IS = 2;
const CL = 3;
const CP = 4;
const PO = 5;
const PR = 6;
const OP = 7;
const HY = 8;

/** The numeric class of `code` (an index into `lineBreakClasses.NUMERIC_CLASSES`), or null. Binary search. */
export function numericClass(code: number | null): number | null {
  if (code === null) return null;
  let lo = 0;
  let hi = NUMERIC_CLASS_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to, cls] = NUMERIC_CLASS_RANGES[mid]!;
    if (code < from) hi = mid - 1;
    else if (code > to) lo = mid + 1;
    else return cls;
  }
  return null;
}

/**
 * Does the numeric rule hold the break between `codes[i]` and `codes[i + 1]`? `codes`: the base code point of each of
 * a word's clusters (null where a cluster has none that counts: a soft hyphen or zero-width space ends a number, as
 * in Chromium). Unicode 15.1's LB25 where it reads past the pair's neighbours (the pair table holds the rest):
 *  NU (SY|IS)* (CL|CP)? x (PO|PR);  (PO|PR) x (OP|HY)? IS? NU;  NU (SY|IS)* x NU.
 * Not between two Latin-1 characters (`latin1PairsExempt`; a marked one is ICU's, `packMarkedLatin1.ts`), and not for the code points production holds no number beside (left out of
 * `packNumericClassData.ts` when it was probed in the image).
 */
export function heldByNumber(codes: ReadonlyArray<number | null>, i: number, latin1PairsExempt = true): boolean {
  // Two Latin-1 characters meet by Chromium's own table, pair by pair, which the pair table holds as it is: "$(.5",
  // "1.)%" and "$\u00A1.5" break where production breaks them ("\u20AC(.5" and "1.)\u2030" are held).
  if (latin1PairsExempt && (codes[i] ?? 0x100) < 0x100 && (codes[i + 1] ?? 0x100) < 0x100) return false;
  const at = (k: number): number | null => (k < 0 || k >= codes.length ? null : numericClass(codes[k]!));
  const a = at(i);
  const b = at(i + 1);
  const numberEndsAt = (k: number): boolean => {
    let j = k;
    while (at(j) === SY || at(j) === IS) j -= 1;
    return at(j) === NU;
  };
  if (b === PO || b === PR) {
    if (numberEndsAt(a === CL || a === CP ? i - 1 : i)) return true;
  }
  if (a === PO || a === PR) {
    let k = i + 1;
    if (at(k) === OP || at(k) === HY) k += 1;
    if (at(k) === IS) k += 1;
    if (at(k) === NU) return true;
  }
  return b === NU && numberEndsAt(i);
}
