/**
 * EVERY PACK PRINT TEST SETS TEXT AS PRODUCTION DOES: it launches `launchPrintChromium`, and that Chromium positions
 * glyphs at fractional advances (production's Gotenberg does; `printChromium.ts`). Exact parity with Gotenberg itself
 * is `tests/unit/printParity/packEngineParity.test.ts`, which needs velo; this holds the launcher everywhere.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, firefox, type Browser } from 'playwright';
import { launchPrintChromium, launchUnhintedControlChromium } from './printChromium';

const DIR = __dirname;

/**
 * A launch in source, however it is spelled: a call to launch* on chromium/firefox/webkit (an alias, a line break, a
 * bracket), or a launch* destructured from one. The run-time guard (`support/printChromiumGuard.ts`) is what holds; this
 * names the file before it runs.
 */
export const LAUNCH_IN_SOURCE = /(?:\b\w+|\))\s*(?:\.\s*|\[\s*['"`])launch\w*\b|\{[^}]*\blaunch\w*\b[^}]*\}\s*=\s*\w+/;

const EVASIONS = [
  'await chromium\n  .launch();',
  'const { launch } = chromium;\nawait launch();',
  "await chromium['launch']();",
  'import { chromium as c } from "playwright";\nawait c.launch();',
  'await chromium.launchServer();',
  'await chromium.launchPersistentContext("/tmp/x");',
  'await Object.getPrototypeOf(chromium).launch.call(chromium);',
];

describe('the print tests\' Chromium', () => {
  it('no file under tests/unit/print launches a browser any other way, however the launch is spelled', () => {
    for (const evasion of EVASIONS) expect(LAUNCH_IN_SOURCE.test(evasion), evasion).toBe(true);
    const files = readdirSync(DIR, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f)
      && !['printChromium.ts', 'printChromium.test.ts', path.join('support', 'printChromiumGuard.ts')].includes(f));
    const direct = files.filter((f) => LAUNCH_IN_SOURCE.test(readFileSync(path.join(DIR, f), 'utf8')));
    expect(files.length).toBeGreaterThan(20);
    expect(direct).toEqual([]);
  });

  it.each([
    ['chromium.launch()', () => chromium.launch()],
    ['chromium[\'launch\']()', () => chromium['launch']()],
    ['a destructured launch', () => { const { launch } = chromium; return launch.call(chromium); }],
    ['chromium.launchServer()', () => chromium.launchServer()],
    ['chromium.launchPersistentContext()', () => chromium.launchPersistentContext('/nonexistent-print-guard')],
    ['firefox.launch()', () => firefox.launch()],
    ['the prototype\'s launch', () => (Object.getPrototypeOf(chromium) as typeof chromium).launch.call(chromium)],
    ['--font-render-hinting=full', () => chromium.launch({ args: ['--font-render-hinting=full'] })],
    ['none, then full', () => chromium.launch({ args: ['--font-render-hinting=none', '--font-render-hinting=full'] })],
  ] as const)('at run time, %s without the flag is refused', async (unused, launch) => {
    await expect(launch()).rejects.toThrow(/print test/);
  });

  let print: Browser;
  let plain: Browser;
  beforeAll(async () => { print = await launchPrintChromium(); plain = await launchUnhintedControlChromium(); }, 120_000);
  afterAll(async () => { await print?.close(); await plain?.close(); });

  it('sets the pack\'s face at fractional advances, where a Chromium launched with full hinting rounds each to a whole pixel', async () => {
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
