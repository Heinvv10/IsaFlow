/**
 * THE CENSUSES BEYOND THE PAIR TABLE'S OWN (`breakPairsCensus.ts` holds those):
 *  - the stand-ins' other members and the rules beside the table, compared on every break (`allDifferences`), in the
 *    print tests' Chromium (`packBreakPairs.test.ts`) and in production's image (`printParity/packBreakPairsImage.test.ts`);
 *  - labels holding a mark (the marked census), which are printed to break anywhere and held as line counts in
 *    production (`printParity/packAnywhereLabelImage.test.ts`);
 *  - the variation selector 16 as Unicode's emoji data says the pack should print it (`asPrinted`), the unit test's
 *    reading of `packPrintedText.printedText` apart from its own.
 */
import { pieces } from '@/modules/accounting/services/packs/pages/packLineBreaks';
import { DOMAIN, FACE_SET } from './breakPairsCensus';
import { EMOJI_VARIATION_BASES } from './emojiVariationBases';

const VARIATION_BASES = new Set(EMOJI_VARIATION_BASES);

/**
 * `text` as the pack should print it, read from Unicode's own data and not from `packPrintedText.ts`: composed, and a
 * U+FE0F only after a code point emoji-variation-sequences.txt gives an emoji style (`emojiVariationBases.ts`).
 */
export function asPrinted(text: string): string {
  const out: string[] = [];
  for (const c of text) if (c !== '\uFE0F' || VARIATION_BASES.has(out[out.length - 1]?.codePointAt(0) ?? -1)) out.push(c);
  return out.join('').normalize('NFC');
}

/** Every character the table covers with a variation selector 16 after it, in eleven contexts (the blind review's six of round 4 among them), as typed. */
export const VS16_TYPED: readonly string[] = DOMAIN.flatMap((x) => [
  `ab${x}\uFE0Fcd`, `${x}\uFE0F${x}\uFE0F`, `12${x}\uFE0F34`, `\u4E2D${x}\uFE0F\u4E2D`, `(${x}\uFE0F)`, `Gross${x}\uFE0Fmargin`,
  `Gross ${x}\uFE0F margin`, `${x}\uFE0FGross`, `Gross${x}\uFE0F12`, `12${x}\uFE0Fab`, `ab${x}\uFE0F${x}\uFE0Fcd`,
]);

/**
 * A mark (U+0301, U+FE0E, U+FE00, U+034F, U+20D7) on an ASCII character, before or after it, in eight contexts (#1235
 * round 5's blind probe), its labels, and the adversary's strings of the same round: labels printed to break anywhere,
 * held to their line counts in production (`packAnywhereLabelImage.test.ts`).
 */
export function markedCensus(): string[] {
  const marks = ['\u0301', '\uFE0E', '\uFE00', '\u034F', '\u20D7'];
  const ascii = DOMAIN.filter((c) => c.codePointAt(0)! < 0x7f);
  const texts = ascii.flatMap((x) => marks.flatMap((m) => [`ab${x}${m}cd`, `12${x}${m}34`, `ab${x}${m}(c`, `12${x}${m}$5`, `a${m}${x}cd`, `1${m}${x}34`, `1${m}${x}(c`, `a${m}${x}(c`]));
  return [...texts, 'Telecoms*\uFE0E(Telecommunications)', 'Telecoms#\uFE0E(Telecommunications)', 'Telecoms=\u0301(Telecommunications)', ...adversaryMarks()];
}

/**
 * #1235 round 5's adversary (`genvs.ts`, `gencm.ts`): a U+FE0F on an emoji-style base (# * 0 5 9 \u00A9 \u00AE \u2122 \u2194
 * \u21A9) beside every ASCII and Latin-1 character; U+FE0E or U+FE00 between every two ASCII characters; a letter or
 * digit with U+0301, U+0308 or U+0327 before every ASCII character and a letter, a digit or a year ("Cafe\u0301-2024");
 * U+0301 between every two ASCII characters.
 */
function adversaryMarks(): string[] {
  const out = new Set<string>();
  const ascii = Array.from({ length: 0x7f - 0x21 }, (unused, i) => String.fromCharCode(0x21 + i));
  const latin1 = Array.from({ length: 0x100 - 0xa1 }, (unused, i) => String.fromCharCode(0xa1 + i));
  for (const b of ['#', '*', '0', '5', '9', '\u00A9', '\u00AE', '\u2122', '\u2194', '\u21A9']) {
    for (const q of [...ascii, ...latin1]) for (const [pre, suf] of [['ab', 'cd'], ['12', '34'], ['', '']]) { out.add(`${pre}${b}\uFE0F${q}${suf}`); out.add(`${pre}${q}${b}\uFE0F${suf}`); }
  }
  for (const vs of ['\uFE0E', '\uFE00']) for (const p of ascii) for (const q of ascii) out.add(`ab${p}${vs}${q}cd`);
  for (const pre of ['Caf', 'ab', '12', '']) for (const base of ['e', '5', 'E']) for (const m of ['\u0301', '\u0308', '\u0327']) {
    for (const p of ascii) for (const f of ['a', '5', '2024', '']) out.add(`${pre}${base}${m}${p}${f}`);
  }
  for (const p of ascii) for (const q of ascii) out.add(`ab${p}\u0301${q}cd`);
  return [...out];
}

/**
 * Members of each stand-in's kind other than the stand-in itself (`packBreakPairs.SCRIPT_STAND_INS`): two ideographs,
 * two Hangul syllables, two full-width letters, a compatibility ideograph, a supplementary-plane ideograph and a
 * supplementary private-use character, each beside every punctuation mark and symbol the faces set, a letter and a digit;
 * and the rules beside the table (below). Compared on every break (`allDifferences`), not only those between two of the
 * table's own characters.
 */
export function standInCensus(): string[] {
  const members = ['\u65E5', '\u6536', '\uAC00', '\uD7A3', '\uFF3A', '\uFF5A', '\uF900', '\u{20000}', '\u{F0000}'];
  const marks = [...FACE_SET].map((c) => String.fromCodePoint(c)).filter((c) => /[\p{P}\p{S}]/u.test(c));
  const stands = members.flatMap((m) => [`ab${m}cd`, `12${m}34`, `${m}${m}`, ...marks.flatMap((p) => [`${m}${p}ab`, `ab${p}${m}`, `${m}${p}1`, `${p}${m}`, `${m}${p}`])]);
  // The space separators the faces lack before a character the table lacks (an emoji, a Thai letter, Linear B: read by
  // their own rule, beside the table, #1235 round 4).
  const spaces = ['\u3000', '\u205F', '\u1680'].flatMap((sp) => ['\u{1F600}', '\u0E01', '\u{10000}'].flatMap((y) => [`ab${sp}${y}`, `${sp}${y}`, `ab${sp}${y}cd`]));
  return [...stands, ...spaces];
}

/** Each of `texts` whose breaks the model and `breaksOf`'s answer (`raw`) disagree on, but where none can be read. */
export function allDifferences(texts: readonly string[], raw: readonly number[][]): string[] {
  return texts.flatMap((t, i) => {
    const blind = new Set(raw[i]!.filter((b) => b < 0).map((b) => -b));
    const real = raw[i]!.filter((b) => b > 0 && !blind.has(b));
    let at = 0;
    const model: number[] = [];
    pieces(t).forEach((p, k) => { const from = t.indexOf(p.text, at); if (k > 0 && !blind.has(from)) model.push(from); at = from + p.text.length; });
    return model.join(',') === real.join(',') ? [] : [t];
  });
}

