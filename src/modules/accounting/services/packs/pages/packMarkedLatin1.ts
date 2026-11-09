/**
 * A LATIN-1 PAIR WITH A MARK IN IT, AS PRODUCTION'S CHROMIUM BREAKS IT (#1235 rounds 5 and 6).
 *
 * Chromium sets a pair of two Latin-1 characters by its own table, from the two characters alone (and, for a hyphen
 * before a digit, the character before them: "1-34" breaks after the hyphen); the pair table holds that. A mark on the
 * pair's FIRST character (U+0301, a variation selector, ...) makes the character before the break a non-Latin-1 code
 * point, and Chromium hands the pair to ICU's rules, which read the marked character as its base and look further:
 *  - the pair itself: `packMarkedLatin1Data.ts`, probed in production's image with a letter either side, and opening a
 *    word, where a hyphen holds to a letter ("-\u0301A" does not break at a word's start, nor after a no-break space, a
 *    hyphen or a question mark), and after a Hebrew letter, where it holds to anything (probed against one character of
 *    every pair class before the hyphen);
 *  - Unicode's numeric rule, now for Latin-1 too ("1)\u0301$" and "$\u0301(1" hold): `packNumericHold.heldByNumber`;
 * A mark on the character after the pair, or two places off, changes nothing; a mark on the character before a hyphen
 * holds the hyphen to a digit after it ("1\u0301-34", "Cafe\u0301-2024") and breaks it before a Latin-1 character past
 * ASCII.
 */
import { bytesOf } from './packBreakPairsReader';
import { pairClass } from './packBreakPairs';
import {
  MARKED_HYPHEN_HOLDS_AFTER, MARKED_HYPHEN_OPENS_AFTER, MARKED_LATIN1_BREAKS, MARKED_LATIN1_CODES, MARKED_LATIN1_HYPHEN_AFTER, MARKED_LATIN1_OPENING,
} from './packMarkedLatin1Data';
import { heldByNumber } from './packNumericHold';

const INDEX = new Int16Array(0x100).fill(-1);
MARKED_LATIN1_CODES.forEach((c, i) => { INDEX[c] = i; });
const BITS = bytesOf(MARKED_LATIN1_BREAKS);
const OPENING_BITS = bytesOf(MARKED_LATIN1_OPENING);
const HYPHEN_BITS = bytesOf(MARKED_LATIN1_HYPHEN_AFTER);
const N = MARKED_LATIN1_CODES.length;

const classesOf = (codes: readonly number[]): Set<number | null> => new Set(codes.map((c) => pairClass(c)));
/** The classes a marked hyphen opens a word after (a no-break space, a hyphen, a question mark: probed), and holds after. */
const OPENS_AFTER = classesOf(MARKED_HYPHEN_OPENS_AFTER);
const HOLDS_AFTER = classesOf(MARKED_HYPHEN_HOLDS_AFTER);
const ZWSP = 0x200b;

/**
 * Does Chromium break between `codes[i]` (its cluster `sizes[i]` code points long) and `codes[i + 1]` where a mark makes the
 * Latin-1 pair one of ICU's? Null where none does (the pair table decides). `codes`: each cluster's base code point;
 * `sizes`: each cluster's length in code points; `opening`: `codes[i]` opens a word.
 */
export function markedLatin1Breaks(codes: readonly number[], sizes: readonly number[], i: number, opening: boolean): boolean | null {
  const a = codes[i]!;
  const b = codes[i + 1]!;
  if (a >= 0x100 || b >= 0x100) return null;
  if (sizes[i]! === 1) {
    // Chromium's own table, but for a hyphen after a marked character, which breaks as probed (`MARKED_LATIN1_HYPHEN_AFTER`:
    // it holds to a digit, "1\u0301-34", and breaks before "\u00B2" after "?\u0301", which the bare "?-\u00B2" holds).
    if (a !== 0x2d || i === 0 || sizes[i - 1]! === 1) return null;
    const c = INDEX[codes[i - 1]!] ?? -1;
    const y = INDEX[b]!;
    if (c < 0 || y < 0) return b >= 0x30 && b <= 0x39 ? false : null;
    const h = c * N + y;
    return ((HYPHEN_BITS[h >> 3]! >> (7 - (h & 7))) & 1) === 1;
  }
  const x = INDEX[a]!;
  const y = INDEX[b]!;
  // A character the table lacks (a control, the soft hyphen): no break taken that production may not take.
  if (x < 0 || y < 0) return false;
  const k = x * N + y;
  const before = codes[i - 1];
  if (a === 0x2d && before !== undefined && HOLDS_AFTER.has(pairClass(before))) return false;
  const opens = opening || (a === 0x2d && before !== undefined && (before === ZWSP || OPENS_AFTER.has(pairClass(before))));
  if ((((opens ? OPENING_BITS : BITS)[k >> 3]! >> (7 - (k & 7))) & 1) === 0) return false;
  return !heldByNumber(codes, i, false);
}
