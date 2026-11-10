/**
 * WHAT A MARK OF A DICTIONARY-BROKEN SCRIPT ADDS, IN PRODUCTION'S IMAGE (#1263 round 3). The fallback tables hold each
 * code point's advance ALONE, where a combining mark is drawn on a dotted circle; in a word it may add nothing (a Thai
 * tone mark) or its own width (a Myanmar vowel sign, Lao YAMAKKAN, U+0ECE, which the general category called
 * zero-width). So each mark of the SA scripts (`packDictionaryBreakData`) is measured where it is written, after a
 * consonant of its own script, and where it is not: after itself, and after a Latin letter. Whole pixels at the tables'
 * 12px, rounded up, the larger of the regular and the semibold, in `packFallbackMarkData` (REGENERATE_FALLBACK_MARKS=1
 * rewrites it): [in a word, anywhere else]. `packFallbackWidthCore` prices the marks by it. Velo only.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DICTIONARY_BREAK_RANGES } from '@/modules/accounting/services/packs/pages/packDictionaryBreakData';
import { FALLBACK_MARKS } from '@/modules/accounting/services/packs/pages/packFallbackMarkData';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';
import { paritySkip } from './paritySkip';
import { markBase } from './saMarks';

const ROOT = path.resolve(__dirname, '../../..');
const marks = (): number[] => DICTIONARY_BREAK_RANGES.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (unused, i) => a + i))
  .filter((cp) => /\p{M}/u.test(String.fromCodePoint(cp)) && markBase(String.fromCodePoint(cp)) !== null);

async function measure(gotenberg: Gotenberg): Promise<Array<[number, number, number]>> {
  const cps = marks();
  const texts = cps.flatMap((cp) => { const m = String.fromCodePoint(cp); const b = markBase(m)!; return [b, b + m, b + m + m, 'm', `m${m}`]; });
  const script = `function answer() { var host = document.getElementById('scan'); var out = []; [400, 600].forEach(function (w) { ${JSON.stringify(texts)}.forEach(function (t) {
    var s = document.createElement('span'); s.style.cssText = 'white-space:pre;font-size:12px;font-weight:' + w; s.textContent = t; host.appendChild(s);
    out.push('W|' + s.getBoundingClientRect().width); host.removeChild(s); }); }); return out; }`;
  const got = (await inImage(gotenberg, script)).filter((l) => l.startsWith('W|')).map((l) => Number(l.slice(2)));
  if (got.length !== texts.length * 2) throw new Error(`${got.length} widths for ${texts.length * 2} texts`);
  const up = (px: number): number => Math.max(0, Math.ceil(px - 1e-6));
  return cps.map((cp, i) => {
    const at = (weight: number, k: number): number => got[weight * texts.length + i * 5 + k]!;
    const d = (weight: number): [number, number] => [up(at(weight, 1) - at(weight, 0)), Math.max(up(at(weight, 2) - at(weight, 1)), up(at(weight, 4) - at(weight, 3)))];
    const [a, b] = [d(0), d(1)];
    return [cp, Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  });
}

function source(rows: ReadonlyArray<readonly [number, number, number]>): string {
  const lines = Array.from({ length: Math.ceil(rows.length / 8) }, (unused, i) => `  ${rows.slice(i * 8, i * 8 + 8).map(([cp, a, b]) => `[0x${cp.toString(16)}, ${a}, ${b}]`).join(', ')},`);
  return `/**
 * GENERATED in production's image by tests/unit/printParity/packFallbackMarksImage.test.ts: do not edit by hand.
 * Regenerate (velo): REGENERATE_FALLBACK_MARKS=1 npx vitest run --config vitest.print.config.ts tests/unit/printParity/packFallbackMarksImage.test.ts
 *
 * Each combining mark of the dictionary-broken (SA) scripts: [code point, what it adds in a word (after a consonant of
 * its own script), what it adds anywhere else (after itself, or after a Latin letter)], in whole pixels at 12px, rounded
 * up, the larger of the regular and the semibold. \`packFallbackWidthCore\` reads it. ${rows.length} marks. Client-safe data.
 */
export const FALLBACK_MARKS: ReadonlyArray<readonly [number, number, number]> = [
${lines.join('\n')}
];
`;
}

const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

describe.skipIf(unavailable !== null)(`the SA marks' widths in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('are packFallbackMarkData, measured afresh', async () => {
    const rows = await measure(gotenberg!);
    if (process.env.REGENERATE_FALLBACK_MARKS === '1') writeFileSync(path.join(ROOT, 'src/modules/accounting/services/packs/pages/packFallbackMarkData.ts'), source(rows));
    expect(FALLBACK_MARKS).toEqual(rows);
  }, 600_000);
});
