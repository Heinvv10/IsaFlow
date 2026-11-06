/**
 * REGENERATES `packReasonWidthData.ts` (`reasonWidthGenerator.ts` says how). Not a check: it runs only when asked, and
 * `packFigureWidth.test.ts` is what holds the committed tables to Chromium.
 *
 *   REGENERATE_REASON_WIDTHS=1 npx vitest run --config vitest.print.config.ts tests/unit/print/packReasonWidthData.generate.test.ts
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, it } from 'vitest';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { dataModuleSource, measureReasonAdvances, reasonWidthData } from './reasonWidthGenerator';

const TARGET = path.resolve(__dirname, '../../../src/modules/accounting/services/packs/pages/packReasonWidthData.ts');
const asked = process.env.REGENERATE_REASON_WIDTHS === '1';

let browser: Browser | undefined;
beforeAll(async () => { if (asked) browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });

it.runIf(asked)('writes packReasonWidthData.ts from this Chromium', async () => {
  const data = reasonWidthData(await measureReasonAdvances(browser!));
  writeFileSync(TARGET, dataModuleSource(data, `Playwright's Chromium ${browser!.version()}`));
}, 600_000);
