/**
 * THE LEGACY (MANAGEMENT) PRINT VIEW EMBEDS ONLY THE PACK'S OWN FACE.
 *
 * It reuses screen components — statement rows, KPI tiles — whose figures are
 * set in `var(--ff-fig-font)`, IBM Plex Mono, which the print page does not
 * load. Chromium substituted DejaVuSansMono, and the printed management pack
 * carried a fallback typeface in every figure column. The board pack is held
 * to one face by `packOneTypeface.test.ts`; this holds the other print view.
 *
 * The REAL `PackPrintPage` is bundled for the browser, mounted in Chromium with
 * the print stylesheet, printed through `page.pdf`, and `pdffonts` reads which
 * faces the file embeds.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { bundlePrintPages } from './support/bundlePrintPages';
import { DEMO, printLegacyPack } from './support/printLegacyPack';
import type { ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';

const run = promisify(execFile);

/** Negative revenue and equity, a loss, no cash flow read: Brightsphere's shape. */
const BRIGHTSPHERE_SHAPED: ReportPackInput = {
  ...DEMO, companyName: 'Brightsphere', revenue: -5_535_000, costOfSales: 0, operatingExpenses: 3_717_000,
  netProfit: -1_407_763, totalEquity: -1_300_000, totalAssets: 700_000, totalLiabilities: 2_000_000,
  cash: -530_836, operatingCashFlow: undefined, investingCashFlow: undefined, financingCashFlow: undefined,
};

let browser: Browser;
let bundle: string;
let dir: string;
beforeAll(async () => {
  bundle = await bundlePrintPages();
  browser = await chromium.launch();
  dir = mkdtempSync(path.join(tmpdir(), 'pack-fonts-'));
}, 180_000);
afterAll(async () => {
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The faces the printed management pack embeds, one name per line. */
async function embeddedFaces(input: ReportPackInput, tag: string, extraCss = ''): Promise<string[]> {
  const file = path.join(dir, `${tag}.pdf`);
  writeFileSync(file, await printLegacyPack(browser, bundle, input, { extraCss }));
  const { stdout } = await run('pdffonts', [file]);
  return stdout.split('\n').slice(2).map((l) => l.trim().split(/\s+/)[0] ?? '').filter(Boolean);
}

const stripSubset = (name: string) => name.replace(/^[A-Z]{6}\+/, '');

describe('the printed management pack embeds only IBM Plex Sans', () => {
  it.each([
    ['the composed demo', DEMO],
    ['a Brightsphere-shaped pack', BRIGHTSPHERE_SHAPED],
  ] as const)('%s', async (name, input) => {
    const faces = await embeddedFaces(input, name.replace(/\W+/g, '_'));
    expect(faces.length, 'no font was embedded at all').toBeGreaterThan(0);
    expect(faces.map(stripSubset).filter((f) => !f.startsWith('IBMPlexSans'))).toEqual([]);
  }, 90_000);

  it('is red when a figure is set in the screen monospace again (mutation)', async () => {
    const faces = await embeddedFaces(DEMO, 'mutant',
      'html.print-mode { --ff-fig-font: "IBM Plex Mono", ui-monospace, monospace; }');
    expect(faces.map(stripSubset).filter((f) => !f.startsWith('IBMPlexSans')).length).toBeGreaterThan(0);
  }, 90_000);
});
