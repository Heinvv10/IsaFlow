/**
 * WHAT A COMBINING MARK COSTS IN PRODUCTION'S IMAGE (#1235 round 6): each mark, on each of a few bases, in each style the
 * fit model prices, measured in a throwaway container of the image (`fallbackWidths.measureMarks`); the committed
 * `packFallbackMarkData.ts` must be what the image measures now (with REGENERATE_FALLBACK_MARKS=1 it writes it instead),
 * and every mark on five bases, alone and in a word, is never priced under production's width.
 * Velo only; re-run it whenever the gotenberg image or the fonts change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AS_CHROMIUM_SETS } from '@/modules/accounting/services/packs/pages/packGlyphRuler';
import { textPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { printedText } from '@/modules/accounting/services/packs/pages/packPrintedText';
import { MARK_BASES, measureMarks, STYLES } from './fallbackWidths';
import { inImage } from './inImage';
import { ascii } from './lineBreakClasses';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { paritySkip } from './paritySkip';

const TARGET = path.resolve(__dirname, '../../../src/modules/accounting/services/packs/pages/packFallbackMarkData.ts');
const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

/** The data file's source: per style, the runs of marks that add the same whole pixels (those that add none left out). */
function markSource(adds: Awaited<ReturnType<typeof measureMarks>>): string {
  const styles = STYLES.map(([style]) => {
    const runs: Array<[number, number, number]> = [];
    for (const [cp, px] of [...adds[style]].filter(([, v]) => v > 0).sort((a, b) => a[0] - b[0])) {
      const last = runs[runs.length - 1];
      if (last !== undefined && last[1] === cp - 1 && last[2] === px) last[1] = cp; else runs.push([cp, cp, px]);
    }
    const text = runs.map(([a, b, px]) => `${a.toString(36)}${a === b ? '' : `-${b.toString(36)}`}:${px.toString(36)}`).join(',');
    const lines = Array.from({ length: Math.ceil(text.length / 150) }, (unused, i) => `    '${text.slice(i * 150, (i + 1) * 150)}',`).join('\n');
    return `  ${style}: [\n${lines}\n  ].join(''),`;
  });
  return ascii(`/**
 * GENERATED in production's Gotenberg image by \`tests/unit/printParity/packFallbackMarksImage.test.ts\`
 * (REGENERATE_FALLBACK_MARKS=1): do not edit by hand. Read by \`packFallbackWidth.ts\`. Per style, the whole pixels each
 * combining mark adds at most to a base (${MARK_BASES.length} bases: ${MARK_BASES.join(' ')}), at the size the style is
 * measured at: "from[-to]:px" runs in base 36, the marks that add nothing left out.
 */
import type { FallbackStyle } from './packFallbackWidthData';

export const MARK_ADDS: Readonly<Record<FallbackStyle, string>> = {
${styles.join('\n')}
};
`);
}

/** Every combining mark on a few bases, alone and inside a word, as the pack prints it: the texts the widths are held on. */
function markTexts(): string[] {
  const out = new Set<string>();
  for (let cp = 0x300; cp <= 0x1ffff; cp += 1) {
    const m = String.fromCodePoint(cp);
    if (!/^\p{M}$/u.test(m)) continue;
    for (const b of ['q', 'A', 'x', '&', 'n']) { out.add(printedText(`${b}${m}`)); out.add(printedText(`Telecom${b}${m}munications`)); }
  }
  return [...out];
}

describe.skipIf(unavailable !== null)(`the combining marks of production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('every combining mark on five bases, alone and in a word, at 12px in each weight: the model never under production\'s width', async () => {
    const texts = markTexts();
    const wrong: string[] = [];
    for (const weight of [400, 500, 600] as const) {
      for (let at = 0; at < texts.length; at += 8000) {
        const slice = texts.slice(at, at + 8000);
        const script = `function answer() { var host = document.getElementById('scan'); return ${JSON.stringify(slice)}.map(function (t) { var s = document.createElement('span'); s.style.cssText = 'white-space:pre;font-size:12px;font-weight:${weight}'; s.textContent = t; host.appendChild(s); var w = s.getBoundingClientRect().width; host.removeChild(s); return 'W|' + w; }); }`;
        const got = (await inImage(gotenberg!, script)).filter((l) => l.startsWith('W|')).map((l) => Number(l.slice(2)));
        expect(got.length, 'the image\'s widths came back incomplete').toBe(slice.length);
        slice.forEach((t, i) => {
          const never = textPx(t, 12, weight);
          const set = textPx(t, 12, weight, false, AS_CHROMIUM_SETS);
          // Never short; as Chromium sets it, at most its one unit of float noise under (the wrap guard's, `packLineWrap.WRAP_GUARD`).
          if (never < got[i]! - 1e-6 || set < got[i]! - 1 / 64 - 1e-6) wrong.push(`${JSON.stringify(t)}/${weight}: model ${set} (never short ${never}), production ${got[i]}`);
        });
      }
    }
    expect(wrong.slice(0, 20), `${wrong.length} of ${texts.length * 3}`).toEqual([]);
  }, 3_600_000);


  it(process.env.REGENERATE_FALLBACK_MARKS === '1' ? 'writes packFallbackMarkData.ts' : 'the committed mark prices are what the image measures now', async () => {
    const source = markSource(await measureMarks(gotenberg!));
    if (process.env.REGENERATE_FALLBACK_MARKS === '1') writeFileSync(TARGET, source);
    else expect(readFileSync(TARGET, 'utf8') === source, 'packFallbackMarkData.ts differs from the image; regenerate it').toBe(true);
  }, 3_600_000);
});
