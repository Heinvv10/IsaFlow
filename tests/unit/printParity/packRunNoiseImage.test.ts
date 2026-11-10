/**
 * HOW FAR PAST ITS EXACT SUM CHROMIUM SETS ONE RUN, IN PRODUCTION'S IMAGE (#1235 round 7): words of 6 to 19 letters
 * and accented letters, and the blind review's four, at 12px in each weight. The never-short width (`NEVER_SHORT`, the
 * exact sum rounded up and a unit more), which the KPI share is taken at (`packKpiLayout.kpiColumnBoundsPx`), is never
 * under production's; `CHROMIUM_LEAST` never over it. `CHROMIUM_MOST`, a sixteenth of a unit over, can be a unit under,
 * and is no longer used where that matters. Velo only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROMIUM_LEAST } from '@/modules/accounting/services/packs/pages/packGlyphRuler';
import { textPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';
import { paritySkip } from './paritySkip';
import { runNoiseWords } from '../print/fixtures/runNoiseWords';

const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

describe.skipIf(unavailable !== null)(`one run's width in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('8,000 words at each weight: the never-short width never under production, the least never over', async () => {
    const words = runNoiseWords();
    const wrong: string[] = [];
    for (const weight of [400, 500, 600] as const) {
      const script = `function answer() { var host = document.getElementById('scan'); return ${JSON.stringify(words)}.map(function (t) { var s = document.createElement('span'); s.style.cssText = 'white-space:pre;font-size:12px;font-weight:${weight}'; s.textContent = t; host.appendChild(s); var w = s.getBoundingClientRect().width; host.removeChild(s); return 'W|' + w; }); }`;
      const got = (await inImage(gotenberg!, script)).filter((l) => l.startsWith('W|')).map((l) => Number(l.slice(2)));
      expect(got.length, 'the image\'s widths came back incomplete').toBe(words.length);
      words.forEach((t, i) => {
        if (textPx(t, 12, weight) < got[i]! - 1e-9) wrong.push(`${JSON.stringify(t)}/${weight}: never short ${textPx(t, 12, weight)}, production ${got[i]}`);
        if (textPx(t, 12, weight, false, CHROMIUM_LEAST) > got[i]! + 1e-9) wrong.push(`${JSON.stringify(t)}/${weight}: least ${textPx(t, 12, weight, false, CHROMIUM_LEAST)}, production ${got[i]}`);
      });
    }
    expect(wrong.slice(0, 20), `${wrong.length} of ${words.length * 3}`).toEqual([]);
  }, 1_800_000);
});
