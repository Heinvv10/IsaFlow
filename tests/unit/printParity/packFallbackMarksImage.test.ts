/**
 * WHAT A COMBINING MARK ADDS, IN PRODUCTION'S IMAGE, FOR EVERY SCRIPT THE FALLBACK FACES SET (#1263 rounds 3 and 4).
 * The fallback tables hold each code point's advance ALONE, where a mark is drawn on a dotted circle: Devanagari's AA
 * (U+093E) costs a whole em there, half again what it adds in a word, and Lao YAMAKKAN (U+0ECE), which the general
 * category calls zero-width, prints with width. So every mark of a script (not Common or Inherited) the faces lack is
 * measured where it is written, after a letter of its own script, and where it is not: after itself, and after a Latin
 * letter. Whole pixels at the tables' 12px, rounded up, the larger of the regular and the semibold, in
 * `packFallbackMarkData` with each script's code points (to tell a base of the mark's own script):
 * REGENERATE_FALLBACK_MARKS=1 SCRIPTS_TXT=<Unicode 17 Scripts.txt> rewrites it; without them, the committed rows are
 * measured afresh and compared. `packFallbackWidthCore` prices the marks by it. Velo only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FALLBACK_MARKS, SCRIPT_BASES, SCRIPT_NAMES, SCRIPT_RANGES } from '@/modules/accounting/services/packs/pages/packFallbackMarkData';
import { SELF_HOSTED } from '@/modules/accounting/services/packs/pages/packFallbackWidthData';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';
import { paritySkip } from './paritySkip';

const ROOT = path.resolve(__dirname, '../../..');
const faces = (cp: number): boolean => SELF_HOSTED.some(([a, b]) => cp >= a && cp <= b);
type Row = readonly [number, number, number, number];

/** Scripts.txt: each script's code points (Common, Inherited and Unknown left out). */
function scripts(text: string): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>();
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0]!.trim();
    if (line === '') continue;
    const [range, name] = line.split(';').map((s) => s.trim()) as [string, string];
    if (name === 'Common' || name === 'Inherited') continue;
    const [from, to] = range.split('..');
    const list = out.get(name) ?? [];
    list.push([parseInt(from!, 16), parseInt(to ?? from!, 16)]);
    out.set(name, list);
  }
  return out;
}

/** The marks to measure, each with its script's index, and each script's base (its first letter) and code points. */
function plan(): { rows: Array<[number, number]>; names: string[]; bases: number[]; ranges: Array<[number, number, number]> } {
  const all = scripts(readFileSync(process.env.SCRIPTS_TXT!, 'utf8'));
  const names: string[] = [];
  const bases: number[] = [];
  const rows: Array<[number, number]> = [];
  for (const [name, list] of [...all].sort((a, b) => a[0].localeCompare(b[0]))) {
    const cps = list.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (unused, i) => a + i));
    const marks = cps.filter((cp) => /^\p{M}$/u.test(String.fromCodePoint(cp)) && !faces(cp));
    const base = cps.find((cp) => /^\p{Lo}$/u.test(String.fromCodePoint(cp))) ?? cps.find((cp) => /^\p{L}$/u.test(String.fromCodePoint(cp)));
    if (marks.length === 0 || base === undefined) continue;
    names.push(name);
    bases.push(base);
    for (const cp of marks) rows.push([cp, names.length - 1]);
  }
  const sorted = names.flatMap((name, idx) => all.get(name)!.map(([a, b]) => [a, b, idx] as [number, number, number])).sort((x, y) => x[0] - y[0]);
  // Consecutive ranges of one script merge (across what no other of these scripts holds): the table only says whose a
  // base is.
  const ranges: Array<[number, number, number]> = [];
  for (const r of sorted) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last[2] === r[2]) last[1] = r[1]; else ranges.push([...r]);
  }
  return { rows: rows.sort((x, y) => x[0] - y[0]), names, bases, ranges };
}

async function measure(gotenberg: Gotenberg, rows: ReadonlyArray<readonly [number, number]>, bases: readonly number[]): Promise<Row[]> {
  const texts = rows.flatMap(([cp, idx]) => { const m = String.fromCodePoint(cp); const b = String.fromCodePoint(bases[idx]!); return [b, b + m, b + m + m, 'm', `m${m}`]; });
  const script = `function answer() { var host = document.getElementById('scan'); var out = []; [400, 600].forEach(function (w) { ${JSON.stringify(texts)}.forEach(function (t) {
    var s = document.createElement('span'); s.style.cssText = 'white-space:pre;font-size:12px;font-weight:' + w; s.textContent = t; host.appendChild(s);
    out.push('W|' + s.getBoundingClientRect().width); host.removeChild(s); }); }); return out; }`;
  const got = (await inImage(gotenberg, script)).filter((l) => l.startsWith('W|')).map((l) => Number(l.slice(2)));
  if (got.length !== texts.length * 2) throw new Error(`${got.length} widths for ${texts.length * 2} texts`);
  const up = (px: number): number => Math.max(0, Math.ceil(px - 1e-6));
  return rows.map(([cp, idx], i) => {
    const at = (weight: number, k: number): number => got[weight * texts.length + i * 5 + k]!;
    const d = (weight: number): [number, number] => [up(at(weight, 1) - at(weight, 0)), Math.max(up(at(weight, 2) - at(weight, 1)), up(at(weight, 4) - at(weight, 3)))];
    const [a, b] = [d(0), d(1)];
    return [cp, Math.max(a[0], b[0]), Math.max(a[1], b[1]), idx];
  });
}

const chunked = <T>(items: readonly T[], per: number, show: (t: T) => string): string => Array.from({ length: Math.ceil(items.length / per) },
  (unused, i) => `  ${items.slice(i * per, i * per + per).map(show).join(', ')},`).join('\n');

function source(rows: readonly Row[], names: readonly string[], bases: readonly number[], ranges: ReadonlyArray<readonly [number, number, number]>): string {
  return `/**
 * GENERATED in production's image by tests/unit/printParity/packFallbackMarksImage.test.ts from Unicode 17's
 * Scripts.txt: do not edit by hand. Regenerate (velo): REGENERATE_FALLBACK_MARKS=1 SCRIPTS_TXT=<Scripts.txt> npx vitest
 * run --config vitest.print.config.ts tests/unit/printParity/packFallbackMarksImage.test.ts
 *
 * Each combining mark of a script the faces lack (not Common or Inherited): [code point, what it adds in a word (after a
 * letter of its own script), what it adds anywhere else (after itself, or after a Latin letter), its script], in whole
 * pixels at 12px, rounded up, the larger of the regular and the semibold; each script's name, the base it was measured
 * on, and its code points. \`packFallbackWidthCore\` reads it. ${rows.length} marks, ${names.length} scripts. Client-safe data.
 */
export const SCRIPT_NAMES: readonly string[] = [
${chunked(names, 8, (n) => `'${n}'`)}
];

export const SCRIPT_BASES: readonly number[] = [
${chunked(bases, 12, (b) => `0x${b.toString(16)}`)}
];

/** [from, to, script], sorted. */
export const SCRIPT_RANGES: ReadonlyArray<readonly [number, number, number]> = [
${chunked(ranges, 8, ([a, b, i]) => `[0x${a.toString(16)}, 0x${b.toString(16)}, ${i}]`)}
];

export const FALLBACK_MARKS: ReadonlyArray<readonly [number, number, number, number]> = [
${chunked(rows, 6, ([cp, a, b, i]) => `[0x${cp.toString(16)}, ${a}, ${b}, ${i}]`)}
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
      const { rows, names, bases, ranges } = plan();
      writeFileSync(path.join(ROOT, 'src/modules/accounting/services/packs/pages/packFallbackMarkData.ts'), source(await measure(gotenberg!, rows, bases), names, bases, ranges));
      return;
    }
    expect(FALLBACK_MARKS.length).toBeGreaterThan(1_000);
    expect(SCRIPT_NAMES.length).toBe(SCRIPT_BASES.length);
    expect(SCRIPT_RANGES.every(([a, b], i) => a <= b && (i === 0 || a > SCRIPT_RANGES[i - 1]![1]))).toBe(true);
    const fresh = await measure(gotenberg!, FALLBACK_MARKS.map(([cp, , , idx]) => [cp, idx] as const), SCRIPT_BASES);
    expect(fresh.filter((row, i) => JSON.stringify(row) !== JSON.stringify(FALLBACK_MARKS[i])).slice(0, 10)).toEqual([]);
  }, 1_200_000);
});
