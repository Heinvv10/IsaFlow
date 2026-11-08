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
import { runPx, scriptRuns, type FaceWeight } from '@/modules/accounting/services/packs/pages/packGlyphRuler';
import { launchPrintChromium } from './printChromium';
import { measure } from './measureWidths';
import { mulberry32 } from './support/mulberry32';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 120_000);
afterAll(async () => { await browser?.close(); });

const face = fontkit.create(readFileSync(path.join(process.cwd(), 'public/fonts/IBMPlexSans-Regular.woff2')));
const GLYPHS = face.characterSet.filter((c) => c > 0x20 && c !== 0xad && !/[\p{M}\p{C}\p{Z}]/u.test(String.fromCodePoint(c)));

/** A fixed pseudo-random sequence, so a failure names the same strings every run. */

const SIZES = [6, 8, 9.3333, 10, 10.5757, 12, 13.3333, 14.6667, 16, 22, 29.3333];
const WEIGHTS: FaceWeight[] = [400, 500, 600];
const outside = (cluster: string): number => { throw new Error(`not in the face: ${cluster}`); };

it('never short of Chromium, at most 1/32px over', async () => {
  const random = mulberry32(7);
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

it('the 630-case grid (15 strings x 14 sizes x 3 weights): never short of Chromium, at most 1/32px over', async () => {
  const texts = ['(133 500 000)', '9 000 000', 'Telecommunications', 'AVATAR WAVE', 'Revenue', '45.0%', 'To', 'xy', 'Operating expenses', 'W', 'nnnnnnnnnnnnnnnnnnnn', 'R&D', 'Ff', 'office', 'VAT'];
  const sizes = [6, 7, 9, 10, 10.5757, 11, 12, 13.3333, 14.6667, 16, 17, 20.5, 29.3333, 40];
  const items = texts.flatMap((text) => sizes.flatMap((fontPx) => WEIGHTS.map((weight) => ({ text, fontPx, weight }))));
  expect(items).toHaveLength(630);
  const res = await measure(browser, items.map((it) => ({ probe: 'td' as const, ...it, html: `<span style="white-space:pre">${it.text.replace(/&/g, '&amp;')}</span>` })));
  const wrong = items.flatMap((it, i) => {
    const model = runPx(it.text, it.fontPx, it.weight, outside);
    return model < res[i]!.widthPx - 1e-6 || model > res[i]!.widthPx + 2 / 64 + 1e-6 ? [`${it.text} at ${it.fontPx}px/${it.weight}: model ${model}, Chromium ${res[i]!.widthPx}`] : [];
  });
  expect(wrong).toEqual([]);
}, 300_000);

it('U+2044 FRACTION SLASH makes a fraction only between two digits, as HarfBuzz does (fontkit makes one beside any digit): never short of Chromium, at most 1/32px over', async () => {
  const fixed = ['a \u20441', 'a 1\u2044', 'a 1\u20442', 'a 12\u2044345', 'a 1\u2044a', 'a a\u20441', 'a \u2044', 'a 1\u20442\u20443', 'a \u2044\u20441',
    'a 1 \u2044 2', 'a 1\u20442 \u20443', 'a 3\u20444 of 10\u2044', 'a 0\u20440', 'a (1\u20442)', 'a 1\u20442%',
    // What Chromium sets as nothing still stands between the digit and the slash: no fraction (#1235 round 2, M1).
    'a 1\u00AD\u20442', 'a 1\u2044\u00AD2', 'a 1\u200B\u20442', 'Loan 3\u00AD\u20444 share', 'a 11\u00AD1\u204422', 'a 1\u00AD2\u20443', 'a 1\u2060\u20442', 'a 1\u2044\u20612'];
  const random = mulberry32(2044);
  const next = (): number => random.next().value as number;
  const tokens = ['1', '23', '\u2044', '\u2044', 'a', 'x', ' ', '0', '(', ')', '%', '\u00BD', '7'];
  const texts = [...fixed, ...Array.from({ length: 200 }, () => `a ${Array.from({ length: 2 + Math.floor(next() * 6) }, () => tokens[Math.floor(next() * tokens.length)]!).join('')}`)];
  // Non-vacuous: slashes with a digit on one side only (where the two shapers differ), and true fractions.
  expect(texts.filter((t) => /(^|[^0-9])\u2044[0-9]|[0-9]\u2044($|[^0-9])/.test(t)).length).toBeGreaterThan(50);
  expect(texts.filter((t) => /[0-9]\u2044[0-9]/.test(t)).length).toBeGreaterThan(12);
  const items = texts.flatMap((text, i) => [12, 14.6667, 10.6667, SIZES[i % SIZES.length]!].map((fontPx, j) => ({ text, fontPx, weight: WEIGHTS[(i + j) % 3]! })));
  const res = await measure(browser, items.map((it) => ({ probe: 'td' as const, ...it, html: `<span style="white-space:pre">${it.text}</span>` })));
  const wrong = items.flatMap((it, i) => {
    const model = runPx(it.text, it.fontPx, it.weight, outside);
    return model < res[i]!.widthPx - 1e-6 || model > res[i]!.widthPx + 2 / 64 + 1e-6 ? [`${JSON.stringify(it.text)} at ${it.fontPx}px/${it.weight}: model ${model}, Chromium ${res[i]!.widthPx}`] : [];
  });
  expect(wrong).toEqual([]);
}, 300_000);

it('what Chromium sets as nothing (the soft hyphen, the zero-width space, the word joiner, the invisible operators, the left-to-right controls) is nothing, and kerned across: never short of Chromium, at most 1/32px over', async () => {
  const invisible = ['\u00AD', '\u200B', '\u200E', '\u202A', '\u202C', '\u2060', '\u2061', '\u2062', '\u2063', '\u2064', '\u2066', '\u2069', '\u206A', '\u206F'];
  const texts = invisible.flatMap((x) => [`A${x}V`, `a${x}b office`, `Rev${x}enue ${x}${x}T${x}o`, `12${x}345`]);
  const items = texts.flatMap((text, i) => [12, 14.6667, 10.6667].map((fontPx, j) => ({ text, fontPx, weight: WEIGHTS[(i + j) % 3]! })));
  const res = await measure(browser, items.map((it) => ({ probe: 'td' as const, ...it, html: `<span style="white-space:pre">${it.text}</span>` })));
  const wrong = items.flatMap((it, i) => {
    const model = runPx(it.text, it.fontPx, it.weight, outside);
    return model < res[i]!.widthPx - 1e-6 || model > res[i]!.widthPx + 2 / 64 + 1e-6 ? [`${JSON.stringify(it.text)} at ${it.fontPx}px/${it.weight}: model ${model}, Chromium ${res[i]!.widthPx}`] : [];
  });
  expect(wrong).toEqual([]);
}, 300_000);

it('a character whose Script Extensions leave out the run\'s script starts a new run, and a closing bracket goes with its opener, as Chromium shapes them: never short of Chromium, at most 1/32px over', async () => {
  // The middle dot (Latin, Greek; not Cyrillic), the modifier apostrophe (Latin, Cyrillic; not Greek), the caron (Latin)
  // and the narrow no-break space (Latin) between Cyrillic or Greek letters and the superscripts the faces kern with them.
  // One run kerned "⁵Ј" 33 units under Chromium's width ("ой×·⁵Ј").
  const texts = ['·⁵Ј', 'ї·⁵Ј', 'ї×·⁵Ј', 'ой×·⁵Ј', 'x·⁵Ј', 'α·⁵Ω', 'о\u202f⁵Ј', 'Ты\u202fТы', 'оʼ⁵Ј', 'αʼ⁵Ω', 'Ав·Ав', 'Тˇ⁵Ј', 'Выручка 1\u202f234',
    // A closing bracket goes with its opening bracket's run.
    '(13 of Җ) llll', 'Ж(a) Ж', '(a Ж) l', '(Ж (a) Ж) l', 'Ж)l', '[Ж] l',
    // The nearest opener of the closer's kind; the opener stays open after its pair closes, so the last ")" here
    // closes the inner "(" again and is kerned with "Т" (15 units under, were it Latin).
    'x(Ж(Ж)Т)', 'x[Ж(Ж)Т]', 'x(Ж(Т)Ж)', 'x(Ж[Т)', 'x[Ж(Т]',
    // Chromium keeps 32 open brackets: the 33rd drops the "(" and the ")" falls in with the Cyrillic run.
    `x(${'Ж['.repeat(31)}Т)`, `x(${'Ж['.repeat(32)}Т)`];
  const items = texts.flatMap((text) => WEIGHTS.map((weight) => ({ text, fontPx: 12, weight })));
  const res = await measure(browser, items.map((it) => ({ probe: 'td' as const, ...it, html: `<span style="white-space:pre">${it.text}</span>` })));
  const wrong = items.flatMap((it, i) => {
    const model = runPx(it.text, it.fontPx, it.weight, outside);
    return model < res[i]!.widthPx - 1e-6 || model > res[i]!.widthPx + 2 / 64 + 1e-6 ? [`${JSON.stringify(it.text)} /${it.weight}: model ${model * 64}/64, Chromium ${res[i]!.widthPx * 64}/64`] : [];
  });
  expect(wrong).toEqual([]);
}, 120_000);

it('splits a line of 100 000 brackets in linear time: a closer never searches past the 32 brackets Chromium keeps open', () => {
  // Table labels carry tenant GL account names. 50 000 openers then 50 000 closers that match none of them: a search
  // of the whole open stack per closer is 1.25 billion steps; a bounded one is 1.6 million.
  const hostile = 'Ж('.repeat(25_000) + 'x]'.repeat(25_000);
  const started = performance.now();
  const runs = scriptRuns(hostile);
  const ms = performance.now() - started;
  expect(runs.join('')).toBe(hostile);
  expect(ms).toBeLessThan(500); // 20ms here; the unbounded search took 4 000ms
});
