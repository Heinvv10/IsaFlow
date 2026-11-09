/**
 * GRAPHEMES THAT HOLD SEVERAL GLYPHS THAT ADVANCE (#1235 round 8, adversarial H1). The print never breaks inside a
 * grapheme, so one of these is as wide as all its glyphs together: seven emoji joined by ZWJ and VS16, a run of Sutton
 * SignWriting marks or Brahmi number joiners on a letter, Tamil viramas off their script (a dotted circle each), a
 * GB9c conjunct chain, a run of Hangul leading jamo under a mark, a run of prepended Arabic marks, stacked spacing
 * marks. Each at several lengths, alone and after the words the adversary put before them, and the same shapes without
 * a mark after a marked word (their run is priced by the ruler). `packAnywhereLabelImage.test.ts` sets every one in
 * production; `packBreakPairsImage.test.ts` prints `ROUND_EIGHT_LABELS` in a statement table.
 */
import { JOINING_FALLBACK } from '@/modules/accounting/services/packs/pages/packJoiningData';

const cp = (...points: number[]): string => String.fromCodePoint(...points);
const times = (text: string, n: number): string => Array.from({ length: n }, () => text).join('');

/** The seven families of the adversarial review and the blind review's three, each at the lengths measured and past them. */
export const FAMILIES: ReadonlyArray<(n: number) => string> = [
  (n) => `${times(cp(0x1f600, 0xfe0f, 0x200d), n)}${cp(0x1f600)}`,
  (n) => `q${times(cp(0x1da00), n)}`,
  (n) => `q${times(cp(0x1107f), n)}`,
  (n) => `q${times(cp(0x0bcd), n)}`,
  (n) => `${times(cp(0x0915, 0x094d), n)}${cp(0x0915)}`,
  (n) => `${times(cp(0x1100), n)}${cp(0x0301)}`,
  (n) => `${times(cp(0x0600), n)}q${cp(0x0301)}`,
  // The blind review's (round 8, L1): hearts joined by ZWJ, each with VS16; Brahmi number joiners and Kannada viramas on "a".
  (n) => `${times(cp(0x2764, 0xfe0f, 0x200d), n)}${cp(0x2764, 0xfe0f)}`,
  (n) => `a${times(cp(0x1107f), n)}`,
  (n) => `a${times(cp(0x0ccd), n)}`,
];
const LENGTHS = [1, 2, 5, 6, 8, 9, 12, 14, 16, 20, 24, 40];

/** Spacing marks (\p{Mc}) of several scripts, stacked on their own script's letter and on Latin. */
const SPACING = [0x0903, 0x093e, 0x0940, 0x0bbe, 0x0d3e, 0x0f7f, 0x102b, 0x1b35, 0x11000, 0x1d165];
const SPACING_BASES = ['q', cp(0x0915), cp(0x0ba4), cp(0x0d15)];

/** Wide graphemes without a mark, after a marked word (the review's "checked and fine" shapes). */
const UNMARKED = [
  (n: number) => `${times(cp(0x1f600, 0x200d), n)}${cp(0x1f600)}`,
  (n: number) => ` ${times(cp(0x1100), n)}`,
  (n: number) => times(cp(0x0600), n) + 'q',
  (n: number) => ` ${cp(0x1f1ff, 0x1f1e6)}${times(cp(0x4e2d), n)}`,
];

/**
 * Letters that join, which production sets wider joined than the fallback tables measure them alone (#1235 round 9,
 * adversarial H1 and M1): runs of one letter, the review's Mongolian and Arabic pairs, Syriac words, each alone, after a
 * mark and after words.
 */
const JOINING_RUNS = [0x0728, 0x071d, 0x08a7, 0x185a, 0x189e, 0x1863, 0x1835, 0x1877, 0x1868, 0x06fc, 0x075d, 0x075e, 0x075f];
const JOINING_PAIRS = [[0x1863, 0x1833], [0x1863, 0x1835], [0x185a, 0x1835], [0x06d2, 0x0624], [0x0728, 0x0728]];

export function joiningFamilies(): string[] {
  const out: string[] = [];
  for (const n of [1, 2, 8, 17, 23, 40, 120]) {
    for (const letter of JOINING_RUNS) out.push(times(cp(letter), n), `q\u0301 ${times(cp(letter), n)}`, `Rent ${times(cp(letter), n)}`);
    for (const [a, b] of JOINING_PAIRS) out.push(times(cp(a!, b!), n), `Telecommunications ${times(cp(a!, b!), n)}`);
    out.push(`${cp(0x0728, 0x0730)}${times(cp(0x0728), n)}`, `${times(cp(0x0728), n)}${cp(0x0730)}`, `${cp(0x08a7, 0x064e)}${times(cp(0x08a7), n)}`,
      `${cp(0x185a, 0x180b)}${times(cp(0x185a), n)}`, `${cp(0x189e, 0x18a9)}${times(cp(0x189e), n)}`, times(`${times(cp(0x0728), 6)} `, Math.ceil(n / 4)));
  }
  return out;
}

const PREFIXES = ['', 'A', 'A ', 'Ren', 'Rent', 'Rent ', 'Rent and ', 'Telecommunications', 'Telecommunications '];

export function anywhereFamilies(): string[] {
  const out = new Set<string>();
  for (const family of FAMILIES) {
    for (const n of LENGTHS) for (const prefix of PREFIXES) out.add(`${prefix}${family(n)}`);
  }
  for (const mark of SPACING) {
    for (const base of SPACING_BASES) {
      for (const n of [1, 2, 4, 8]) for (const prefix of ['', 'Rent and ']) out.add(`${prefix}${base}${times(cp(mark), n)}`);
    }
  }
  for (const shape of UNMARKED) for (const n of [3, 6, 9, 12]) for (const prefix of ['q\u0301', 'Rq\u0301 ']) out.add(`${prefix}${shape(n)}`);
  out.add(`Telecommunications ${cp(0x1f1ff, 0x1f1e6, 0x0301, 0x1f1ff, 0x1f1e6, 0x0301)}`);
  out.add(`${cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466, 0xfe0f)}`);
  out.add(`Telecommunications ${cp(0x1f441, 0xfe0f, 0x200d, 0x1f5e8, 0xfe0f)}`);
  for (const label of joiningFamilies()) out.add(label);
  // A last line the ruler prices exactly, at every length: somewhere it ends so near the edge that a footnote mark after
  // it takes a line of its own (blind round 8, L2: the mark's line was held nowhere).
  for (let k = 1; k <= 80; k += 1) { out.add(`q\u0301 ${'n'.repeat(k)}`); out.add(`Rq\u0301 Telecommunications ${'m'.repeat(k)}`); }
  return [...out];
}

/**
 * The review's statement-table labels ([label, footnote mark]): the seven that printed a line more than the model, at
 * `fits: true`, and the three that ran past their column over the figures (the last 193.4px at 12 digits).
 */
export const ROUND_EIGHT_LABELS: ReadonlyArray<readonly [string, boolean]> = [
  [`A${FAMILIES[0]!(6)}`, false],
  [`A ${FAMILIES[0]!(6)}`, false],
  [`Ren${FAMILIES[0]!(6)}`, false],
  [`Rent${FAMILIES[0]!(6)}`, false],
  [`Rent${FAMILIES[1]!(9)}`, false],
  [`Telecommunications ${FAMILIES[0]!(7)}`, true],
  [`Rent${FAMILIES[1]!(20)}`, false],
  [`Rent ${FAMILIES[0]!(14)}`, false],
  [`Telecommunications ${FAMILIES[4]!(40)}`, false],
  [`Rent and ${FAMILIES[5]!(12)}`, false],
  [`Rent and ${FAMILIES[6]!(10)}`, false],
  [`Rent and q${times(cp(0x0bcd), 14)}`, false],
  [`Rent and q${times(cp(0x1107f), 5)}`, false],
  [`Rent and ${cp(0x0915)}${times(cp(0x093e), 4)}`, true],
];

/**
 * The families at lengths whose floor the figures still leave room for at 9 digits (two or three code points), so the
 * table prints: its lines, height, width and every label inside its cell are held in production
 * (`packBreakPairsImage.test.ts`; at 12 digits some are refused).
 */
export const ROUND_EIGHT_FITTING: ReadonlyArray<readonly [string, boolean]> = [
  [`Rent and \u263A\uFE0F`, false],
  [`Rent and ${FAMILIES[1]!(2)}`, false],
  [`Rent and ${FAMILIES[2]!(1)}`, true],
  [`Rent ${FAMILIES[3]!(2)}`, false],
  [`Telecommunications ${FAMILIES[4]!(1)}`, false],
  [`Telecommunications${FAMILIES[5]!(1)}`, true],
  [`Rent ${FAMILIES[6]!(1)}`, false],
  [`Rent and q\u093E\u093E`, false],
];

/**
 * The review's round-9 statement-table labels: the marked ones that printed a line or two more than the model where
 * master refuses the table (H1), and the unmarked ones that printed past the page or a line short (M1, master's too).
 */
export const ROUND_NINE_LABELS: ReadonlyArray<readonly [string, boolean]> = [
  [`${cp(0x0728, 0x0730)}${times(cp(0x0728), 120)}`, false],
  [`${cp(0x0728, 0x0730)}${times(cp(0x0728), 120)}`, true],
  [`${times(cp(0x0728), 121)}${cp(0x0730)}`, false],
  [`${cp(0x0728, 0x0730)}${times(cp(0x0728), 200)}`, false],
  [`${cp(0x08a7, 0x064e)}${times(cp(0x08a7), 200)}`, false],
  ...[14, 17, 20, 23, 26, 29, 32].map((n) => [times(cp(0x0728), n), false] as const),
  ...[12, 16, 20].map((n) => [times(`${times(cp(0x0728), 6)} `, n), false] as const),
];

/** Every letter of the joining table (`packJoiningData.JOINING_FALLBACK`), in order. */
export const joiningLetters = (): number[] => JOINING_FALLBACK.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (unused, i) => from + i));

/**
 * EVERY JOINING LETTER, REPEATED AND PAIRED (round 9): each alone, twice, 8 and 40 times, 8 times after a marked word;
 * and every pair of letters of one 128-code-point block, four times over.
 */
export function joiningSweep(): string[] {
  const letters = joiningLetters();
  const out: string[] = [];
  for (const letter of letters) for (const n of [1, 2, 8, 40]) out.push(times(cp(letter), n));
  for (const letter of letters) out.push(`q\u0301 ${times(cp(letter), 8)}`);
  for (const a of letters) for (const b of letters) if (a >> 7 === b >> 7) out.push(times(cp(a, b), 4));
  return out;
}
