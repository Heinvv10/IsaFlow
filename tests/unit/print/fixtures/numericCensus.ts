/**
 * THE NUMERIC CENSUS (#1235 round 4): the strings Unicode's numeric rule (UAX 14 LB25) decides past a pair's
 * neighbours, which the pair table alone cannot see (`packNumericHold.ts`). Held in the print tests' Chromium
 * (`packBreakPairs.test.ts`) and in production's image (`printParity/packNumericHoldImage.test.ts`):
 *  - the adversary's 18,630: a prefix sign before an opener or a hyphen and a decimal, an opener and a separator before
 *    a digit or a letter, a number with its separators and closer before a postfix or prefix sign;
 *  - a number's separators before a digit, past Latin-1 ("1./\u0665"), and a postfix sign before an opener and a decimal;
 *  - the blind review's labels, and its 60,000 random five-character strings of the faces' punctuation, digits and
 *    letters (`numericPool`).
 */
import { mulberry32 } from '../support/mulberry32';

const PR = ['$', '\u20AC', '\u00A3', '+', '\\', '\u00B1', '#', 'R'];
const PO = ['%', '\u2030', '\u00B0', '\u00A2', '\u2032', '\u2103'];
const OP = ['(', '[', '{', '\u00AB', '\u201C', '\u00A1', '\u00BF'];
const HY = ['-', '\u2010', '\u2013', '\u2212'];
const IS = ['.', ',', ':', ';'];
const CL = [')', ']', '}', '\u00BB', '\u201D'];

function adversaryNumbers(): string[] {
  const out = new Set<string>();
  const tails = ['5', 'a', '.5', '.a', ',5', '..5', '..a', '/5'];
  for (const l of ['ab', '12', '', 'a ', '1 ']) {
    for (const p of PR) for (const o of [...OP, ...HY]) for (const t of tails) { out.add(`${l}${p}${o}${t}`); out.add(`${l}${p}${o}-${t}`); }
    for (const o of [...OP, ...HY]) for (const i of [...IS, '']) for (const t of ['5', 'a']) out.add(`${l}${o}${i}${t}`);
    for (const mid of ['1', 'a', '1.', 'a.', '1..', 'a..', '1/', 'a/', '1./', 'a./', '1,.', '1.,', 'a.,']) {
      for (const c of [...CL, '']) for (const p of [...PO, ...PR]) { out.add(`${l}${mid}${c}${p}`); out.add(`${l}${mid}${c}${p}x`); }
    }
    for (const mid of ['1', 'a']) for (const s of ['.', '..', '/', './', '...', '.,.']) for (const t of ['5', 'a']) out.add(`${l}${mid}${s}${t}`);
  }
  return [...out];
}

const n = 'n'.repeat(36);
/** The reviews' labels: signed amounts and units a tenant can type. */
export const NUMERIC_LABELS = [
  'Discount \u20AC(.5m)', 'Units 1/:\u2033', 'Fx \u2212(.5)', 'Margin 2.)\u2032', 'ab\u20AC(.5', 'Telecommunications\u20AC(.5m)',
  'Telecommunications(1.)\u20AC', 'Fees 12.)\u2030', 'ab1.)\u2030', 'ab1.)\u20AC', 'ab1.]\u2103', 'ab1..)\u2030', 'ab1./\u2032',
  `\u2212(.5${n})`, `\u20AC(.5${n})`, `(.5${n})`, `Telecommunications ${n}1/:\u2033`, 'FX \u2212(.5%)', '\u20AC(.5m)',
];

/** A number's separators before a digit, with separators and digits past Latin-1 (where Chromium reads the rule). */
function separatorRuns(): string[] {
  const seps = ['.', ',', '/', ':', '\u060C', '\u037E', '\u2044'];
  return ['1', 'a', '\u0661', 'ab', '12'].flatMap((pre) => seps.flatMap((s1) => [...seps, ''].flatMap((s2) => ['5', '\u0665', '\u0967'].map((d) => `${pre}${s1}${s2}${d}`))));
}

/** A postfix sign before an opener or a hyphen and a decimal (#1235 round 5: the adversary's set has prefix signs only). */
function postfixBeforeOpener(): string[] {
  const tails = ['5', 'a', '.5', ',5', '..5', '/5'];
  return ['ab', '12', '', 'a ', '1 '].flatMap((l) => PO.flatMap((p) => [...OP, ...HY].flatMap((o) => tails.flatMap((t) => [`${l}${p}${o}${t}`, `${l}${p}${o}-${t}`]))));
}

export const NUMERIC_CENSUS: readonly string[] = [
  ...NUMERIC_LABELS, 'Rate %(.5)', 'Rate \u2030(.5)', 'Rise \u2032(.5)', ...adversaryNumbers(), ...separatorRuns(), ...postfixBeforeOpener(),
];

/** The blind review's pool (`zzR4Image`, SEED 7): 60,000 strings of five of these, those not all space. */
export function numericPool(): string[] {
  const pool = Array.from('-\u2013\u2014\u2026?!.,:;%$\u20AC\u00A3R()[]{}/\\\'"\u201C\u201D\u2018\u2019\u00AB\u00BB+=*&#@\u00B0\u00B1\u2030\u2032\u2033\u2116\u2212\u00BF\u00A1\u00B4^_|~`a1b2  ');
  const random = mulberry32(7);
  const next = (): number => random.next().value as number;
  return Array.from({ length: 60_000 }, () => Array.from({ length: 5 }, () => pool[Math.floor(next() * pool.length)]!).join('')).filter((t) => t.trim() !== '');
}
