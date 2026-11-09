/**
 * THE BREAK-PAIR CENSUS: the strings the pair table is held to (`packBreakPairs.test.ts` in the print tests' Chromium,
 * `printParity/packBreakPairsImage.test.ts` in production's image), the reading of breaks off a page, and the one way
 * the two Chromiums differ.
 *  - every character the table covers (`printParity/breakPairsDomain.ts`), after a word, a number, a bracket, a stop, a
 *    no-break space, a space or nothing, and before a word, a number, a capital, every opener, every opening quote, the
 *    inverted question mark, a currency sign before a number, a space, a footnote mark's digit or nothing;
 *  - random strings of them with spaces, soft hyphens, zero-width spaces and an ideograph (read by its stand-in);
 *  - the adversary's census of #1235's third round, as line counts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as fontkit from 'fontkit';
import { markedPieces, pieces } from '@/modules/accounting/services/packs/pages/packLineBreaks';
import { PAIR_DOMAIN } from '../../printParity/breakPairsDomain';
import { mulberry32 } from '../support/mulberry32';

const FACES = ['Regular', 'Medium', 'SemiBold'].map((w) => new Set<number>(fontkit.create(readFileSync(path.join(process.cwd(), 'public/fonts', `IBMPlexSans-${w}.woff2`))).characterSet));
// A noncharacter the faces set (U+FFFF) is not drawn with their glyph: Chromium sets it narrower, from no face.
const FACE_SET = new Set([...FACES[0]!].filter((c) => FACES.every((f) => f.has(c)) && !/\p{Cn}/u.test(String.fromCodePoint(c))));
export const DOMAIN = PAIR_DOMAIN().map((c) => String.fromCodePoint(c));
const DOMAIN_SET = new Set(DOMAIN);
const LEFTS = ['ab', '12', '', 'a ', '(', '.', '\u00A0'];
const RIGHTS = ['cd', '34', 'Cd', '(c', '[c', '{c', '\u201Cc', '\u00ABc', '\u2018c', '\u00BFc', '$5', '\u20AC5', ' x', '', '0'];
export const CENSUS = DOMAIN.flatMap((x) => LEFTS.flatMap((l) => RIGHTS.map((r) => `${l}${x}${r}`))).filter((t) => t.trim() !== '');

export function randomStrings(count: number): string[] {
  const random = mulberry32(1235);
  const next = (): number => random.next().value as number;
  const extra = [' ', ' ', '\u00AD', '\u200B', '\u65E5', 'a', '1', '-', '('];
  return Array.from({ length: count }, () => Array.from({ length: 3 + Math.floor(next() * 8) }, () => {
    const pool = next() < 0.3 ? extra : DOMAIN;
    return pool[Math.floor(next() * pool.length)]!;
  }).join('')).filter((t) => t.trim() !== '');
}

/**
 * The breaks the pair table decides: between two characters the faces set. A break at a soft hyphen or a zero-width
 * space is `packSoftBreaks.test.ts`'s to hold, one beside a character the faces lack `packLineBreaks.test.ts`'s
 * (`packBreakRanges.ts`), one at a space is every model's.
 */
export const covered = (t: string, at: number): boolean => DOMAIN_SET.has(t[at - 1]!) && DOMAIN_SET.has(t[at]!);

/** Every character the table covers with a variation selector 16 after it (an emoji presentation), in five contexts. */
export const VS16_CENSUS = DOMAIN.flatMap((x) => [`ab${x}\uFE0Fcd`, `${x}\uFE0F${x}\uFE0F`, `12${x}\uFE0F34`, `\u4E2D${x}\uFE0F\u4E2D`, `(${x}\uFE0F)`]);

/**
 * The census strings where both Chromiums break otherwise than the base the model reads them by: a variation selector 16
 * after nine ASCII signs (Chromium breaks after "!\uFE0F" before a letter, between "$\uFE0F$\uFE0F", and not after
 * "-\uFE0F"). No account name carries one; held as they are, so a change shows.
 */
export const VS16_RESIDUAL: ReadonlySet<string> = new Set([
  '$\uFE0F$\uFE0F', '%\uFE0F%\uFE0F', '+\uFE0F+\uFE0F', '-\uFE0F-\uFE0F', '12!\uFE0F34', '12-\uFE0F34', '12|\uFE0F34', '12}\uFE0F34', '\\\uFE0F\\\uFE0F', 'ab!\uFE0Fcd', 'ab/\uFE0Fcd', 'ab|\uFE0Fcd', 'ab}\uFE0Fcd',
]);

/** Each of `texts` whose breaks the model and `breaksOf`'s answer (`raw`) disagree on, but where none can be read. */
export function vs16Differences(texts: readonly string[], raw: readonly number[][]): string[] {
  return texts.flatMap((t, i) => {
    const blind = new Set(raw[i]!.filter((b) => b < 0).map((b) => -b));
    const real = raw[i]!.filter((b) => b > 0 && !blind.has(b));
    let at = 0;
    const model: number[] = [];
    pieces(t).forEach((p, k) => { const from = t.indexOf(p.text, at); if (k > 0 && !blind.has(from)) model.push(from); at = from + p.text.length; });
    return model.join(',') === real.join(',') ? [] : [t];
  });
}

/** `breaksOf`'s answer for `text`: the breaks the table decides, and the offsets no break can be read at. */
export function readBreaks(text: string, raw: readonly number[]): { real: number[]; blind: Set<number> } {
  const blind = new Set(raw.filter((b) => b < 0).map((b) => -b));
  return { real: raw.filter((b) => b > 0 && !blind.has(b) && covered(text, b)), blind };
}

/** Every character of `text` is one all three faces set, or a space, a soft hyphen or a zero-width space. */
export function inFaces(text: string): boolean {
  return Array.from(text).every((c) => FACE_SET.has(c.codePointAt(0)!) || /[ \u00AD\u200B]/.test(c));
}

/** The model's breaks the table decides: where each piece but the first starts, in UTF-16 offsets. */
export function modelBreaks(text: string): number[] {
  const out: number[] = [];
  let at = 0;
  pieces(text).forEach((piece, i) => {
    const from = text.indexOf(piece.text, at);
    if (i > 0) out.push(from);
    at = from + piece.text.length;
  });
  return out.filter((b) => covered(text, b));
}

/**
 * The word-opening hyphens production's Chromium (Gotenberg's, Chromium 151) holds to a letter after them and the print
 * tests' (Playwright's) breaks after: the en and figure dashes and the Armenian, Hebrew, Canadian and double hyphens
 * (Unicode 16's rule against a break after a word-initial hyphen). Found by the census, held in the image.
 */
const OPENING_HYPHEN = '[\\u058A\\u05BE\\u1400\\u2012\\u2013\\u2E17\\u2E40\\u2E5D]';
/** What a word-opening hyphen can follow: a space, a zero-width space or a character that glues (a no-break space or hyphen). */
const BEFORE_OPENING = '[ \\t\\n\\r\\u200B\\u00A0\\u2007\\u2011\\u202F\\u034F\\u180E\\u0F08\\u0F0C\\u0F12]';
const OPENS_A_WORD = new RegExp(`(^|${BEFORE_OPENING})${OPENING_HYPHEN}`, 'u');

/**
 * The breaks of `text` the print tests' Chromium takes, read as production's: the break after a word-opening hyphen
 * before a letter ("\u2013cd", "a \u2012Cd", "\u00A0\u058Acd", "ab\u2011\u2013cd") dropped. The table is production's; the image test
 * holds the model to production's Chromium on the whole census with nothing dropped.
 */
export function asProduction(text: string, breaks: readonly number[]): number[] {
  const hyphen = new RegExp(`^${OPENING_HYPHEN}$`, 'u');
  const opening = new RegExp(`^${BEFORE_OPENING}$`, 'u');
  // Before a letter that is not an ideograph, a kana, a Hangul syllable or a full-width form (Chromium breaks before those).
  const letter = /^(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\uFF00-\uFFEF])\p{L}$/u;
  return breaks.filter((b) => !(hyphen.test(text[b - 1]!) && (b === 1 || opening.test(text[b - 2]!)) && letter.test(text[b]!)));
}

/** Production's Chromium breaks either side of the braille blank (U+2800) and the print tests' does not: a text holding one is the image's alone. */
export const readable = (text: string): boolean => !text.includes('\u2800');

/** A text the two Chromiums lay out alike outright: readable, and no hyphen opening a word. */
export const alike = (text: string): boolean => readable(text) && !OPENS_A_WORD.test(text);

/**
 * A page script: `breaksOf(list)`, each text's breaks set at width 0 (every opportunity taken), the UTF-16 offsets of
 * the visible characters that start a line but the first. A character Chromium sets with no width (one no face on the
 * host draws) still holds its line, but its line cannot be read: the offsets either side of it come back negated, as
 * blind (`readBreaks`). Run in either Chromium.
 */
export const BREAKS_OF = `function breaksOf(list) {
  var host = document.querySelector('.pack-page');
  var box = document.createElement('div'); box.style.cssText = 'width:0;white-space:normal;font-size:12px';
  host.appendChild(box);
  var spans = list.map(function (t) { var s = document.createElement('span'); s.style.display = 'block'; s.textContent = t; box.appendChild(s); return s; });
  var out = spans.map(function (s, k) {
    var text = list[k]; var node = s.firstChild; var breaks = []; var prevTop = null;
    for (var i = 0; i < text.length; i += 1) {
      var r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
      var rects = r.getClientRects();
      if (rects.length === 0) continue;
      if (rects[rects.length - 1].width === 0) { breaks.push(-i, -(i + 1)); continue; }
      var top = rects[rects.length - 1].top;
      if (prevTop !== null && top > prevTop + 4) breaks.push(i);
      prevTop = top;
    }
    return breaks;
  });
  host.removeChild(box);
  return out;
}`;

/**
 * THE ADVERSARY'S CENSUS (#1235 round 3, `zzR3Census`): every character the regular face sets and every punctuation mark,
 * symbol, space and format character to U+30FF, in fifteen contexts (after a word, a number, an ideograph, a space or
 * nothing; before a word, a number, an ideograph, a footnote mark or nothing; doubled), and every pair of the faces'
 * punctuation and symbols between letters and before a mark. Held as line counts: the model's pieces that hold anything
 * visible against Chromium's lines, a mark on a line of its own counted.
 */
export function adversaryCensus(): Array<{ text: string; marked: boolean }> {
  const files = FACES;
  const set = new Set<number>(files[0]);
  for (let c = 0x20; c < 0x3100; c += 1) if (/[\p{P}\p{S}\p{Z}\p{Cf}\p{Pd}]/u.test(String.fromCodePoint(c))) set.add(c);
  const chars = [...set].filter((c) => c > 0x20 && c !== 0x7f && !(c >= 0x80 && c < 0xa0) && !(c >= 0xd800 && c < 0xe000)).map((c) => String.fromCodePoint(c));
  const contexts: Array<[(x: string) => string, boolean]> = [
    [(x) => `ab${x}cd`, false], [(x) => `12${x}34`, false], [(x) => `ab${x}12`, false], [(x) => `12${x}ab`, false], [(x) => `${x}ab`, false],
    [(x) => `ab${x}`, false], [(x) => `ab${x}`, true], [(x) => `12${x}`, true], [(x) => `ab${x}${x}cd`, false], [(x) => `ab ${x}cd`, false],
    [(x) => `ab${x} cd`, false], [(x) => `ab ${x}`, true], [(x) => `ab${x}${x}`, true], [(x) => `\u4E2D${x}ab`, false], [(x) => `ab${x}\u4E2D`, false],
  ];
  const out = contexts.flatMap(([make, marked]) => chars.map((x) => ({ text: make(x), marked })));
  const punct = [...files[0]!].filter((c) => files.every((s) => s.has(c)) && /[\p{P}\p{S}]/u.test(String.fromCodePoint(c))).map((c) => String.fromCodePoint(c));
  for (const y of punct) for (const x of punct) out.push({ text: `ab${x}${y}cd`, marked: false }, { text: `ab${x}${y}`, marked: true });
  return out;
}

/**
 * How many lines the model sets `text` (and its mark) in at width 0: its pieces that hold anything visible, a drawn
 * hyphen too, and the last when a mark follows (the mark is set on its line). `hidden`: the offsets of characters the
 * host draws with no width (no face on it has them), read as invisible, as `linesOf` reads Chromium's.
 */
export function modelLines(text: string, marked: boolean, hidden: ReadonlySet<number> = new Set()): number {
  let at = 0;
  return markedPieces(text, marked).filter((p, i, all) => {
    const from = p.text === '' ? -1 : text.indexOf(p.text, at);
    if (from >= 0) at = from + p.text.length;
    const shown = from < 0 ? p.text : p.text.split('').filter((c, k) => !hidden.has(from + k)).join('');
    return p.hyphen || (marked && i === all.length - 1) || shown.replace(/[\u00AD\u200B\u200C\u200D\u2060-\u2064\uFEFF]/gu, '') !== '' || (p.text === '' && i === all.length - 1);
  }).length;
}

/**
 * A page script: `linesOf(list)`, each [html] set at width 0 in a 12px span, as "lines|offsets": the lines that hold
 * anything drawn (a mark's own line counted), and the offsets of the characters drawn with no width.
 */
export const LINES_OF = `function linesOf(list) {
  var host = document.querySelector('.pack-page');
  return list.map(function (html) {
    var d = document.createElement('div'); d.className = 'pack-kpi-tile'; d.style.cssText = 'display:block;width:0px';
    d.innerHTML = html; host.appendChild(d);
    var sp = d.firstElementChild; var node = sp.firstChild; var zero = [];
    var n = new Set(Array.from(sp.getClientRects()).filter(function (r) { return r.width > 0; }).map(function (r) { return Math.round(r.top); })).size;
    for (var i = 0; node && node.nodeType === 3 && i < node.length; i += 1) {
      var r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
      var q = r.getClientRects(); if (q.length > 0 && q[q.length - 1].width === 0) zero.push(i);
    }
    host.removeChild(d);
    return n + '|' + zero.join(',');
  });
}`;

/** One `linesOf` answer for `text`: Chromium's lines, and the model's with what the host drew with no width hidden. */
export function heldLines(text: string, marked: boolean, answer: string): { chromium: number; model: number } {
  const [n, zero] = answer.split('|');
  const hidden = new Set(zero === undefined || zero === '' ? [] : zero.split(',').map(Number));
  return { chromium: Number(n), model: modelLines(text, marked, hidden) };
}

/** The span `text` (and a mark) is set in for `LINES_OF`. */
export const linesHtml = (text: string, marked: boolean): string => `<span style="font-size:12px;font-weight:400">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}${marked ? '<sup class="pack-footnote-marker">1</sup>' : ''}</span>`;

const n = (k: number): string => 'n'.repeat(k);

/**
 * The table labels #1235's round-3 reviews found short, [label, with a mark]: breaks after a dash, an ellipsis or a
 * question mark whatever stands before them, between an ideograph and a symbol (the pair table); a private-use character
 * priced as the fallback glyph Chromium sets (the blind review's texts2.json and texts3.json, exactly). Held in a
 * statement table in the print tests' Chromium (`packTableLayout.test.ts`) and in production's image.
 */
export const ROUND_THREE_LABELS: ReadonlyArray<readonly [string, boolean]> = [
  ['\u2013Telecommunications', false], ['\u2013Telecommunications', true], ['\u2026Telecommunications', false], ['Directors-"Telecommunications"', false],
  ['Telecommunications\u2026\u2026', true], [`${n(20)}\u2013\u2013${n(18)}`, false], [`\u4E2D-${n(30)}`, false], [`\u2026${n(30)}`, false],
  [`\u2013${n(30)}`, false], [`${n(30)}\u2013\u2013`, true], ['Equipment (net)-Telecommunications', false], ['VAT 15%-telecommunications', false],
  ['Net\uE044profit', false], ['Gross \uE044\uE044\uE044 margin', false], ['1\uE0442 share', false], ['Net profit \uE044', false],
  ['\uE000\uE001 cost', false], ['Loan \uF0B7 fees', false], [`${n(26)} \uE044\uE044\uE044 ${n(26)}`, false],
  [`Gross margin \uE044\uE044\uE044\uE044\uE044\uE044 ${n(26)}`, false], [`${n(26)}\uE044\uE044\uE044\uE044`, false],
];
