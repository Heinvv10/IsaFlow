/**
 * THE GLYPH RULER IS PRODUCTION'S CHROMIUM, IN THE PACK'S OWN FACE: for 600 strings drawn from every glyph the face
 * has (Latin, Greek, Cyrillic, punctuation, signs; one to fourteen characters, scripts mixed) and the pack's own
 * figures and words, at eleven sizes from 6 to 29.33px (whole and fractional) and the three weights, `runPx` is never
 * short of Chromium's width and at most 1/32px over (`packGlyphRuler.ts` says why one 1/64 unit is added).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as fontkit from 'fontkit';
import { runPx, type FaceWeight } from '@/modules/accounting/services/packs/pages/packGlyphRuler';
import { launchPrintChromium } from './printChromium';
import { measure } from './measureWidths';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 120_000);
afterAll(async () => { await browser?.close(); });

const face = fontkit.create(readFileSync(path.join(process.cwd(), 'public/fonts/IBMPlexSans-Regular.woff2')));
const GLYPHS = face.characterSet.filter((c) => c > 0x20 && c !== 0xad && !/[\p{M}\p{C}\p{Z}]/u.test(String.fromCodePoint(c)));

/** A fixed pseudo-random sequence, so a failure names the same strings every run. */
function* lcg(seed: number): Generator<number> { let s = seed; for (;;) { s = (s * 1103515245 + 12345) % 2147483648; yield s / 2147483648; } }

const SIZES = [6, 8, 9.3333, 10, 10.5757, 12, 13.3333, 14.6667, 16, 22, 29.3333];
const WEIGHTS: FaceWeight[] = [400, 500, 600];
const outside = (cluster: string): number => { throw new Error(`not in the face: ${cluster}`); };

it('never short of Chromium, at most 1/32px over', async () => {
  const random = lcg(7);
  const next = (): number => random.next().value as number;
  const texts: string[] = ['(133 500 000)', '9 000 000', 'Telecommunications', 'office', 'ffi', 'AVATAR WAVE', '45.0%', 'R&D', '…', '‰', 'Total equity and liabilities', '–1 234.5'];
  for (let i = 0; i < 600; i += 1) {
    let t = '';
    const n = 1 + Math.floor(next() * 14);
    for (let j = 0; j < n; j += 1) t += String.fromCodePoint(GLYPHS[Math.floor(next() * GLYPHS.length)]!);
    texts.push(t);
  }
  const items = texts.map((text, i) => ({ text, fontPx: SIZES[i % SIZES.length]!, weight: WEIGHTS[i % 3]! }));
  const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const res = await measure(browser, items.map((it) => ({ probe: 'td' as const, ...it, html: `<span style="white-space:pre">${esc(it.text)}</span>` })));
  const wrong = items.flatMap((it, i) => {
    const model = runPx(it.text, it.fontPx, it.weight, outside);
    const real = res[i]!.widthPx;
    return model < real - 1e-6 || model > real + 2 / 64 + 1e-6 ? [`${JSON.stringify(it.text)} at ${it.fontPx}px/${it.weight}: model ${model}, Chromium ${real}`] : [];
  });
  expect(wrong).toEqual([]);
}, 300_000);
