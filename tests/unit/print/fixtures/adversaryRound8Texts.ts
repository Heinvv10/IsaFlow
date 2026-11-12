/**
 * THE ROUND-8 ADVERSARY'S TEXTS (#1264): a mark or symbol the primary face lacks makes Chromium draw LATER symbols in a
 * fallback face, wider than each is alone (the state effect, H1), and a ZWNJ between Khmer, Myanmar or Thai consonants
 * (M1), from `/home/hein/audit-archive/p3fu/reviews-1263-r8/adversarial.md` (`adv-work/gen8.ts`, modes `pref`, `markpre`,
 * `anypre`, `nat`, `indic`). A state text is a prefix once, a separator, then the probe symbol repeated. Code points as hex.
 */
const cps = (row: string): string => String.fromCodePoint(...row.trim().split(/\s+/).map((h) => parseInt(h, 16)));

export interface StateText { readonly prefix: string; readonly probe: string; readonly sep: string }

/** The prefixes: a keycap mark after a letter, CJK, nothing, or a space; dakuten; Arabic and Indic marks; odd symbols. */
const PREFIXES = [
  '61 20e3', '4e2d 20e3', '20e3', '20 20e3', '61 20dd', '61 20de', '61 20e0', '61 20ea', '61 20d0', '61 20f0', '3042 3099', '4e2d 3099', '3042 309a', '61 302a', '4e2d 302f',
  '61 064b', '628 64e', '62d 651', '61 0652', '61 0670', '915 951', '915 953', '61 1cd0', '61 1ac1', '61 1dfa', '61 0890', '61 08ca', '61 13430', '61 1cf00',
  '61 10141', '61 2b1d', '61 2313', '61 2336', '61 1d2e0', '61 1f5a5', '61 1f7e0', '61 1fb00',
].map(cps);
/** The probes: symbols the later text is drawn wider for (tail of the report's list), and some common ones (always fine). */
const PROBES = ['23d0', '2999', '2af6', '22c5', '2308', '25dc', '266e', '275b', '27e8', '2982', '2b7b', '1d5c2', '2605', '2192', 'a9', '2122'].map(cps);

export const ROUND8_STATE: readonly StateText[] = [
  ...PREFIXES.flatMap((prefix) => PROBES.map((probe) => ({ prefix, probe, sep: ' ' }))),
  ...['\n', '\n\n'].flatMap((sep) => PROBES.slice(0, 8).map((probe) => ({ prefix: cps('61 20e3'), probe, sep }))),
];

/** The report's own cells (narrative 174mm and matters 52.8mm lines the model read: 5 to 7 and 14 to 20 against 7 to 12 and 20 to 35). */
export const ROUND8_CELLS: readonly StateText[] = [
  ['61 20e3', '23d0'], ['4e2d 20e3', '266e'], ['20e3', '25dc'], ['3042 3099', '266e'], ['3042 3099', '2605'], ['61 10141', '25dc'], ['61 064b', '25dc'],
].map(([prefix, probe]) => ({ prefix: cps(prefix!), probe: cps(probe!), sep: ' ' }));

/** M1: a consonant, ZWNJ, a consonant (Myanmar, Khmer, Thai), repeated; and ZWNJ beside letters of the Indic scripts. */
export const ROUND8_ZWNJ: readonly string[] = [
  '1000 200c 1000 20', '178e 200c 1780 20', 'e0a 200c e13 20', '1000 200c 1001 20', '1019 200c 1000 20', '1780 200c 1781 20', 'e01 200c e02 20', '1780 200c 1798 20',
  '915 200c 937 20', '995 200c 9b7 20', 'b95 200c bb7 20', 'd15 200c d37 20', '628 200c 62d 20', 'a985 200c a9b2 20', '1b05 200c 1b33 20', '61 200c 62 20',
].map(cps);

/** A text of `n` graphemes that opens with the prefix and then sets the probe, a space after each. */
export function stateTextTo(p: StateText, n: number): string {
  const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const body = `${p.prefix}${p.sep}${`${p.probe} `.repeat(n)}`;
  return Array.from(seg.segment(body), (g) => g.segment).slice(0, n).join('').trim();
}
