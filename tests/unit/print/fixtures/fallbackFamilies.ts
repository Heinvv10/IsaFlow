/**
 * LABELS OF CHARACTERS THE PACK'S FACES DO NOT SET, which the pair table read short and now print to break anywhere
 * (#1235's follow-up, Hein's "proven set + safe fallback"): the round-10 adversarial review's three faults and the
 * items #1235 deferred. Held in production's image only (`printParity/packAnywhereLabelImage.test.ts`, through
 * `anywhereFamilies`; the statement tables in `printParity/packBreakPairsImage.test.ts`): a fallback face's widths are
 * the host's, and GitHub's are not production's.
 *  - M1: Noto Sans CJK kerns some kana pairs apart (U+30D0 U+30F3 +0.61px, U+30D1 U+30F3, U+304F U+307F, U+30CF U+30C8,
 *    U+3063 U+306E, U+304E U+304F, U+30C0 U+30B7), in runs, words and the review's real labels.
 *  - M2: a run of fallback characters is set in the face Chromium takes for its first (U+23B0 then U+2350..2377,
 *    U+1D670 or U+1D6C6 then U+1D650..1D677, U+1D57D and U+1D595 leads, Georgian U+10FE then U+10D0.., enclosed
 *    numerals after U+2480 or U+246A, and the pairs U+1D537 U+1D538, U+2333 U+2334, U+150F U+1510).
 *  - L1: Cherokee kerning ((U+13A0 U+13AD) x15).
 *  - Deferred: full-width punctuation and wide currency; a hyphen after a line or paragraph separator; breaks beside an
 *    emoji or a compatibility jamo.
 */
const cp = (...points: number[]): string => String.fromCodePoint(...points);
const times = (text: string, n: number): string => Array.from({ length: n }, () => text).join('');
const range = (from: number, count: number): string => cp(...Array.from({ length: count }, (unused, i) => from + i));

const KANA_PAIRS = [[0x30d0, 0x30f3], [0x30d1, 0x30f3], [0x304f, 0x307f], [0x30cf, 0x30c8], [0x3063, 0x306e], [0x304e, 0x304f], [0x30c0, 0x30b7]];

/** The review's Japanese account names, and its long mixed label (missed a line at 145px). */
export const JAPANESE = [
  '\u30D0\u30F3\u30AF\u624B\u6570\u6599', '\u30D1\u30F3\u30C7\u30DF\u30C3\u30AF\u95A2\u9023\u8CBB\u7528',
  '\u30D1\u30F3\u30D5\u30EC\u30C3\u30C8\u5370\u5237\u8CBB',
  '\u30AC\u30B9\u4EE3\u3068\u30D0\u30F3\u30AF\u624B\u6570\u6599\u3001\u30D1\u30F3\u30D5\u30EC\u30C3\u30C8\u5370\u5237\u8CBB\u3001\u30CF\u30C8\u30E1\u52A0\u5DE5\u8CBB\u3001\u30C0\u30B7\u539F\u6599\u8CBB\u306E\u5408\u8A08',
];

/** U+23B0 then U+2350.., U+1D670 then U+1D650..: a lead and `n - 1` of the others (the review's tables). */
export const symbolRun = (n: number): string => `${cp(0x23b0)}${range(0x2350, n - 1)}`;
export const mathRun = (n: number): string => `${cp(0x1d670)}${range(0x1d650, n - 1)}`;

export function fallbackFamilies(): string[] {
  const out = new Set<string>();
  for (const [a, b] of KANA_PAIRS) {
    for (const n of [1, 2, 8, 15, 20, 26, 30, 40]) out.add(times(cp(a!, b!), n));
    out.add(times(`${cp(a!, b!)}\u30AF `, 15));
  }
  for (const label of JAPANESE) { out.add(label); out.add(`Rent ${label}`); }
  for (const n of [12, 30, 33, 36, 39]) out.add(symbolRun(n));
  for (const n of [12, 18, 21, 27, 30]) out.add(mathRun(n));
  for (const lead of [0x1d6c6, 0x1d57d, 0x1d595]) out.add(`${cp(lead)}${range(0x1d650, 40)}`);
  out.add(`${cp(0x10fe)}${range(0x10d0, 40)}`);
  for (const lead of [0x2480, 0x246a]) out.add(`${cp(lead)}${range(0x2460, 30)}`);
  for (const pair of [[0x1d537, 0x1d538], [0x2333, 0x2334], [0x150f, 0x1510]]) for (const n of [1, 8, 20]) out.add(times(cp(...pair), n));
  for (const n of [5, 15, 30]) out.add(times(cp(0x13a0, 0x13ad), n));
  // Full-width punctuation and wide currency, between and after words.
  for (const sign of [0xff08, 0xff09, 0xff0c, 0xff04, 0xff05, 0xffe0, 0xffe1, 0xffe5, 0xffe6, 0xfe69, 0xfe6a, 0xa838]) {
    out.add(`Fees${cp(sign)}net`); out.add(`Rent ${cp(sign)}100 water`); out.add(`${times(`Telecommunications${cp(sign)}`, 3)}`);
  }
  out.add('Fees\uFF08net\uFF09\uFF0Cwater \uFF04100 \uFF05');
  // A hyphen after a line or paragraph separator (#1235 round 4, L1), and after one carrying a mark.
  for (const sep of ['\u2028', '\u2029']) for (const dash of ['-', '\u2013', '\u2010']) for (const tail of ['\u00E9x', 'ax', 'cd', '2024']) out.add(`ab${sep}${dash}${tail}`);
  for (const t of ['-\u0301cd', '12-\u030112', 'Telecommunications-\u0301Telecommunications']) out.add(t);
  // Breaks beside an emoji or a compatibility jamo.
  for (const x of ['\u{1F600}', '\u2764', '\u3131', '\u314F', '\u3164']) for (const t of [`Revenue${x}Total`, `ab${x}-cd`, `ab-${x}cd`, `Rent ${x}/${x} water`, `${x}(${x})${x}`]) out.add(t);
  return [...out];
}

/**
 * The review's statement-table labels: the kana runs that printed a line more than the model (9 and 12 digits), the
 * runs set in their first character's face that printed past the page (665-698px, 671-680px), Cherokee and full-width
 * punctuation.
 */
export const ROUND_TEN_LABELS: ReadonlyArray<readonly [string, boolean]> = [
  [times(cp(0x30d0, 0x30f3), 26), false],
  [`${times(cp(0x30d0, 0x30f3, 0x30af, 0x20), 6)}${cp(0x30d0, 0x30f3, 0x30af)}`, false],
  [JAPANESE[0]!, true],
  ...[12, 30, 33, 36, 39].map((n) => [symbolRun(n), false] as const),
  ...[12, 18, 21, 27, 30].map((n) => [mathRun(n), false] as const),
  [times(cp(0x13a0, 0x13ad), 15), false],
  ['Fees\uFF08net\uFF09\uFF0Cwater \uFF04100 \uFF05', false],
  ['ab\u2028-\u00E9x', false],
];
