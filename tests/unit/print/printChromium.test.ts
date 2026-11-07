/**
 * EVERY PACK PRINT TEST SETS TEXT AS PRODUCTION DOES: it launches `launchPrintChromium`, and that Chromium positions
 * glyphs at fractional advances (production's Gotenberg does; `printChromium.ts`). Exact parity with Gotenberg itself
 * is `tests/unit/printParity/packEngineParity.test.ts`, which needs velo; this holds the launcher everywhere.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';

const DIR = __dirname;

describe('the print tests\' Chromium', () => {
  it('no file under tests/unit/print launches Chromium any other way', () => {
    const files = readdirSync(DIR, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f) && f !== 'printChromium.ts');
    const direct = files.filter((f) => /chromium\.(launch|launchPersistentContext|connect)\w*\(/.test(readFileSync(path.join(DIR, f), 'utf8'))
      && f !== 'printChromium.test.ts');
    expect(files.length).toBeGreaterThan(20);
    expect(direct).toEqual([]);
  });

  let print: Browser;
  let plain: Browser;
  beforeAll(async () => { print = await launchPrintChromium(); plain = await chromium.launch(); }, 120_000);
  afterAll(async () => { await print?.close(); await plain?.close(); });

  it('sets the pack\'s face at fractional advances, where a Chromium launched without the flag rounds each to a whole pixel', async () => {
    const width = async (browser: Browser): Promise<number> => {
      const page = await browser.newPage();
      try {
        await page.route('http://face.print.local/**', (route) => (new URL(route.request().url()).pathname === '/'
          ? route.fulfill({ contentType: 'text/html', body: '<style>@font-face{font-family:P;src:url(/f.woff2)}</style><span id="f" style="font:12px P">(133 500 000) nnnnnnnnnnnnnnnnnnnn</span>' })
          : route.fulfill({ contentType: 'font/woff2', body: readFileSync(path.join(DIR, '../../../public/fonts/IBMPlexSans-Regular.woff2')) })));
        await page.goto('http://face.print.local/');
        await page.evaluate(async () => { await document.fonts.load('12px P'); await document.fonts.ready; });
        return await page.evaluate(() => document.getElementById('f')!.getBoundingClientRect().width);
      } finally {
        await page.close();
      }
    };
    const [fractional, whole] = [await width(print), await width(plain)];
    expect(Number.isInteger(whole), `without the flag: ${whole}`).toBe(true);
    expect(Number.isInteger(fractional), `with it: ${fractional}`).toBe(false);
  });
});
