/**
 * WHAT A COMBINING MARK ADDS, IN PRODUCTION'S IMAGE, FOR EVERY SCRIPT THE FALLBACK FACES SET (#1263 rounds 3 and 4).
 * The fallback tables hold each code point's advance ALONE, where a mark is drawn on a dotted circle: Devanagari's AA
 * (U+093E) costs a whole em there, half again what it adds in a word, and Lao YAMAKKAN (U+0ECE), which the general
 * category calls zero-width, prints with width. So every mark is measured where it is written, after
 * every letter of its own script (a width can depend on the consonant: Devanagari RA with U+0941; Myanmar's medial ra and ya with U+102D, U+102F)
 * and Myanmar's medials, a Common or Inherited mark after the letters of the scripts a tenant writes, and where it is not
 * written: after itself, and after a Latin letter. Whole pixels at the tables' 12px, rounded up, the larger of the regular and the semibold, in
 * `packFallbackMarkData` with each script's code points (to tell a base of the mark's own script):
 * REGENERATE_FALLBACK_MARKS=1 SCRIPTS_TXT=<Unicode 17 Scripts.txt> INDIC_SYLLABIC_TXT=<IndicSyllabicCategory.txt>
 * rewrites it; without them, the committed rows are
 * measured afresh and compared. `packFallbackWidthCore` prices the marks by it. Velo only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FALLBACK_MARKS } from '@/modules/accounting/services/packs/pages/packFallbackMarkData';
import { SCRIPT_BASES, SCRIPT_NAMES, SCRIPT_RANGES } from '@/modules/accounting/services/packs/pages/packFallbackScriptData';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';
import { paritySkip } from './paritySkip';

const ROOT = path.resolve(__dirname, '../../..');
type Row = readonly [number, number, number, number];

/** Scripts.txt: each script's code points (Common and Inherited too: their marks go on any script's letters). */
function scripts(text: string): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>();
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0]!.trim();
    if (line === '') continue;
    const [range, name] = line.split(';').map((s) => s.trim()) as [string, string];
    const [from, to] = range.split('..');
    const list = out.get(name) ?? [];
    list.push([parseInt(from!, 16), parseInt(to ?? from!, 16)]);
    out.set(name, list);
  }
  return out;
}

const ANY_SCRIPT = new Set(['Common', 'Inherited']);
/** The letters a Common or Inherited mark is measured on, and the only bases it is priced as written on. */
const ANY_BASES = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 'ก', 'क', 'र', '一', 'ب', 'а', 'α', 'א', 'က', 'ក', 'অ'];
const MYANMAR_MEDIALS = ['ျ', 'ြ', 'ွ', 'ှ'];
const MYANMAR_VOWELS = ['ါ', 'ာ', 'ိ', 'ီ', 'ု', 'ူ', 'ေ', 'ဲ'];
/** The Indic syllabic categories a mark is written on: a consonant (not an independent vowel, which takes none). */
const CONSONANTS = new Set(['Consonant', 'Consonant_Dead', 'Consonant_With_Stacker', 'Consonant_Head_Letter', 'Consonant_Initial_Postfixed']);

/** IndicSyllabicCategory.txt: each code point's category. */
function syllabic(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0]!.trim();
    if (line === '') continue;
    const [range, cat] = line.split(';').map((s) => s.trim()) as [string, string];
    const [from, to] = range.split('..');
    for (let cp = parseInt(from!, 16); cp <= parseInt(to ?? from!, 16); cp += 1) out.set(cp, cat);
  }
  return out;
}

/**
 * The marks to measure, each with its script's index and the bases it is measured after: every letter of its script (in
 * a script Unicode gives syllabic categories, every consonant), for Myanmar each consonant with each medial, and with a
 * medial and a vowel (medial ra and ya set the vowels after them wider: #1263 round 4); a Common or Inherited mark,
 * ANY_BASES. A mark is priced as written only on a base it was measured on: `ranges` are those bases, by script.
 */
function plan(): { rows: Array<[number, number]>; names: string[]; bases: number[]; prefixes: string[][]; ranges: Array<[number, number, number]> } {
  const all = scripts(readFileSync(process.env.SCRIPTS_TXT!, 'utf8'));
  const isc = syllabic(readFileSync(process.env.INDIC_SYLLABIC_TXT!, 'utf8'));
  const names: string[] = [];
  const bases: number[] = [];
  const prefixes: string[][] = [];
  const valid: Array<[number, number]> = [];
  const rows: Array<[number, number]> = [];
  for (const [name, list] of [...all].sort((a, b) => a[0].localeCompare(b[0]))) {
    const cps = list.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (unused, i) => a + i));
    // Every mark, the faces' too: a cluster the faces do not wholly set (a Thai letter with an acute) is priced here.
    const marks = cps.filter((cp) => /^\p{M}$/u.test(String.fromCodePoint(cp)));
    const letters = cps.filter((cp) => /^\p{L}$/u.test(String.fromCodePoint(cp)));
    const syllabicScript = letters.some((cp) => isc.has(cp));
    const on = ANY_SCRIPT.has(name) ? [] : letters.filter((cp) => !syllabicScript || CONSONANTS.has(isc.get(cp) ?? ''));
    if (marks.length === 0 || (!ANY_SCRIPT.has(name) && on.length === 0)) continue;
    const idx = names.length;
    const kept = ANY_SCRIPT.has(name) ? ANY_BASES : on.map((cp) => String.fromCodePoint(cp));
    const extra = name === 'Myanmar' ? kept.flatMap((b) => MYANMAR_MEDIALS.flatMap((m) => [b + m, ...MYANMAR_VOWELS.map((v) => b + m + v)])) : [];
    names.push(name);
    bases.push(kept[0]!.codePointAt(0)!);
    prefixes.push([...kept, ...extra]);
    for (const cp of on) valid.push([cp, idx]);
    for (const cp of marks) rows.push([cp, idx]);
  }
  const ranges: Array<[number, number, number]> = [];
  for (const [cp, idx] of valid.sort((x, y) => x[0] - y[0])) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last[2] === idx && last[1] === cp - 1) last[1] = cp; else ranges.push([cp, cp, idx]);
  }
  return { rows: rows.sort((x, y) => x[0] - y[0]), names, bases, prefixes, ranges };
}

/**
 * Each mark's [in a word: the most it adds after any of its prefixes; anywhere else: after itself, or after "m"], in
 * whole pixels at 12px rounded up, the larger of the regular and the semibold. Measured in the page, a script at a time.
 */
async function measure(gotenberg: Gotenberg, rows: ReadonlyArray<readonly [number, number]>, prefixes: readonly string[][]): Promise<Row[]> {
  const out = new Map<number, [number, number]>();
  for (let idx = 0; idx < prefixes.length; idx += 1) {
    const marks = rows.filter(([, i]) => i === idx).map(([cp]) => cp);
    if (marks.length === 0) continue;
    const script = `function answer() { var host = document.getElementById('scan'); var s = document.createElement('span'); host.appendChild(s);
      var widths = {}; function w(t, weight) { var k = weight + '|' + t; if (widths[k] === undefined) { s.style.cssText = 'white-space:pre;font-size:12px;font-weight:' + weight; s.textContent = t; widths[k] = s.getBoundingClientRect().width; } return widths[k]; }
      function up(px) { return Math.max(0, Math.ceil(px - 1e-6)); }
      var prefixes = ${JSON.stringify(prefixes[idx])}; var lines = [];
      ${JSON.stringify(marks)}.forEach(function (cp) { var m = String.fromCodePoint(cp); var inWord = 0; var elsewhere = 0; [400, 600].forEach(function (weight) {
        prefixes.forEach(function (p) { inWord = Math.max(inWord, up(w(p + m, weight) - w(p, weight))); });
        var b = prefixes[0]; elsewhere = Math.max(elsewhere, up(w(b + m + m, weight) - w(b + m, weight)), up(w('m' + m, weight) - w('m', weight))); });
        lines.push('R|' + cp + '|' + inWord + '|' + elsewhere); });
      return lines; }`;
    for (const line of await inImage(gotenberg, script)) {
      if (!line.startsWith('R|')) continue;
      const [, cp, a, b] = line.split('|').map(Number) as [number, number, number, number];
      out.set(cp, [a, b]);
    }
  }
  return rows.map(([cp, idx]) => {
    const got = out.get(cp);
    if (got === undefined) throw new Error(`no width for U+${cp.toString(16)}`);
    return [cp, got[0], got[1], idx];
  });
}

const chunked = <T>(items: readonly T[], per: number, show: (t: T) => string): string => Array.from({ length: Math.ceil(items.length / per) },
  (unused, i) => `  ${items.slice(i * per, i * per + per).map(show).join(', ')},`).join('\n');

const HEADER = `GENERATED in production's image by tests/unit/printParity/packFallbackMarksImage.test.ts from Unicode 17's
 * Scripts.txt and IndicSyllabicCategory.txt: do not edit by hand. Regenerate (velo): REGENERATE_FALLBACK_MARKS=1
 * SCRIPTS_TXT=<Scripts.txt> INDIC_SYLLABIC_TXT=<IndicSyllabicCategory.txt> npx vitest run
 * --config vitest.print.config.ts tests/unit/printParity/packFallbackMarksImage.test.ts`;

/** The marks: `packFallbackMarkData.ts`, ten base-36 digits a mark (code point 4, in a word 2, elsewhere 2, script 2). */
function marksSource(rows: readonly Row[]): string {
  const encoded = rows.map(([cp, a, b, i]) => [cp.toString(36).padStart(4, '0'), a.toString(36).padStart(2, '0'), b.toString(36).padStart(2, '0'), i.toString(36).padStart(2, '0')].join('')).join('');
  const lines = Array.from({ length: Math.ceil(encoded.length / 110) }, (unused, i) => `  '${encoded.slice(i * 110, i * 110 + 110)}'`).join(' +\n');
  return `/**
 * ${HEADER}
 *
 * Each combining mark (but SignWriting's, which has no letters): [code point, what it adds in a word (the most after any
 * consonant of its own script; a Common or Inherited mark, after the letters of ANY_BASES; Myanmar's, after a medial
 * too), what it adds anywhere else (after itself, or after a Latin letter), its script (\`packFallbackScriptData\`)], in
 * whole pixels at 12px, rounded up, the larger of the regular and the semibold. ${rows.length} marks. Client-safe data.
 */
const ENCODED =
${lines};

export const FALLBACK_MARKS: ReadonlyArray<readonly [number, number, number, number]> = Array.from({ length: ENCODED.length / 10 }, (unused, i) => {
  const at = (from: number, to: number): number => parseInt(ENCODED.slice(i * 10 + from, i * 10 + to), 36);
  return [at(0, 4), at(4, 6), at(6, 8), at(8, 10)] as const;
});
`;
}

/** The scripts: `packFallbackScriptData.ts`, each one's name, first letter, and the bases its marks were measured on. */
function scriptsSource(names: readonly string[], bases: readonly number[], ranges: ReadonlyArray<readonly [number, number, number]>): string {
  return `/**
 * ${HEADER}
 *
 * The scripts of \`packFallbackMarkData\`'s marks: each one's name, its first letter, and the code points its marks are
 * priced as written on (\`SCRIPT_RANGES\`: its consonants, or every letter where Unicode gives it no syllabic
 * categories; only exactly adjacent ones merge); and the letters a Common or Inherited mark is (\`ANY_BASES\`).
 * ${names.length} scripts. Client-safe data.
 */
export const SCRIPT_NAMES: readonly string[] = [
${chunked(names, 8, (n) => `'${n}'`)}
];

export const SCRIPT_BASES: readonly number[] = [
${chunked(bases, 12, (b) => `0x${b.toString(16)}`)}
];

/** The letters a Common or Inherited mark is priced as written on. */
export const ANY_BASES: readonly number[] = [
${chunked(ANY_BASES.map((b) => b.codePointAt(0)!), 12, (b) => `0x${b.toString(16)}`)}
];

/** [from, to, script]: the bases each script's marks are priced as written on, sorted. */
export const SCRIPT_RANGES: ReadonlyArray<readonly [number, number, number]> = [
${chunked(ranges, 8, ([a, b, i]) => `[0x${a.toString(16)}, 0x${b.toString(16)}, ${i}]`)}
];
`;
}

const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

describe.skipIf(unavailable !== null)(`the combining marks' widths in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('are packFallbackMarkData, measured afresh', async () => {
    if (process.env.REGENERATE_FALLBACK_MARKS === '1') {
      const { rows, names, bases, prefixes, ranges } = plan();
      writeFileSync(path.join(ROOT, 'src/modules/accounting/services/packs/pages/packFallbackMarkData.ts'), marksSource(await measure(gotenberg!, rows, prefixes)));
      writeFileSync(path.join(ROOT, 'src/modules/accounting/services/packs/pages/packFallbackScriptData.ts'), scriptsSource(names, bases, ranges));
      return;
    }
    expect(FALLBACK_MARKS.length).toBeGreaterThan(1_500);
    expect(SCRIPT_NAMES.length).toBe(SCRIPT_BASES.length);
    expect(SCRIPT_RANGES.every(([a, b], i) => a <= b && (i === 0 || a > SCRIPT_RANGES[i - 1]![1]))).toBe(true);
    // Measured afresh on each script's first letter: the table (the most over all its letters) is never under it, and
    // what a mark adds elsewhere is what it measured.
    const fresh = await measure(gotenberg!, FALLBACK_MARKS.map(([cp, , , idx]) => [cp, idx] as const), SCRIPT_BASES.map((b) => [String.fromCodePoint(b)]));
    expect(fresh.filter((row, i) => row[1] > FALLBACK_MARKS[i]![1] || row[2] !== FALLBACK_MARKS[i]![2]).slice(0, 10)).toEqual([]);
  }, 1_200_000);
});
