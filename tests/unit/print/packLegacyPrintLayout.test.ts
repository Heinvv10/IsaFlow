/**
 * HOW THE LEGACY (MANAGEMENT) PRINT VIEW FLOWS ONTO PAPER.
 *
 *  - A label and its value never split across a page (a row of ratio labels
 *    once sat at a page foot with every value on the next page).
 *  - Short portrait sections share a sheet instead of one section per page
 *    (pages were 60-90% blank).
 *  - A heading never sits alone at a page foot.
 *  - A draft pack carries the DRAFT mark on every sheet.
 *
 * Printed by Chromium from the real `PackPrintPage`; read back with
 * `pdftotext`. Mutations: restore the forced break, drop `break-inside`, drop
 * `break-after: avoid`, drop the watermark.
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
import { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';
import { ratioLines } from '@/modules/accounting/services/reports/ratioPresentation';

const run = promisify(execFile);
let browser: Browser;
let bundle: string;
let dir: string;
beforeAll(async () => {
  bundle = await bundlePrintPages();
  browser = await chromium.launch();
  dir = mkdtempSync(path.join(tmpdir(), 'pack-layout-'));
}, 180_000);
afterAll(async () => {
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface Printed { pages: string[]; raw: string[][] }

async function print(tag: string, opts: { draft?: boolean; extraCss?: string } = {}): Promise<Printed> {
  const file = path.join(dir, `${tag}.pdf`);
  writeFileSync(file, await printLegacyPack(browser, bundle, DEMO, opts));
  const { stdout: info } = await run('pdfinfo', [file]);
  const n = Number(/Pages:\s+(\d+)/.exec(info)![1]);
  const pages: string[] = [];
  const raw: string[][] = [];
  for (let p = 1; p <= n; p++) {
    pages.push((await run('pdftotext', ['-f', String(p), '-l', String(p), file, '-'])).stdout);
    raw.push((await run('pdftotext', ['-raw', '-f', String(p), '-l', String(p), file, '-'])).stdout
      .split('\n').map((l) => l.replace(/\u00a0/g, ' ').trim()).filter(Boolean));
  }
  return { pages, raw };
}

const ratios = () => ratioLines(buildReportPack('management', DEMO, '2026-01-01', '2026-08-31')
  .sections.find((s) => s.type === 'ratios')!.data).slice(0, 12);

/** Where the ratios section starts on the page decides whether its rows straddle
 *  a page foot, so sweep it: every offset must keep a label with its value and a
 *  heading with its first rows. (One fixed layout would pass by luck.) */
const OFFSETS_MM = Array.from({ length: 18 }, (_, i) => i * 14);
const spacer = (mmv: number) => `#pack-section-ratios, #pack-section-kpis, #pack-section-cash_flow { margin-top: ${mmv}mm; }`;

const HEADINGS = ['Statement of Comprehensive Income', 'Statement of Financial Position', 'Cash Flow', 'Financial Ratios', 'KPI Scorecard', 'Profit Bridge'];

describe('the legacy print view flows', () => {
  let flowed: Printed;
  let forced: Printed;
  const swept: Array<{ mmv: number; printed: Printed }> = [];
  beforeAll(async () => {
    flowed = await print('flowed');
    forced = await print('forced', {
      extraCss: 'html.print-mode section[id^="pack-section-"]:not([data-print-landscape]) { break-before: page; }',
    });
    for (const mmv of OFFSETS_MM) swept.push({ mmv, printed: await print(`sweep-${mmv}`, { extraCss: spacer(mmv) }) });
  }, 170_000);

  it('puts every ratio label on the same page as its value, at every offset', () => {
    const lines = ratios();
    expect(lines.length).toBeGreaterThan(5);
    for (const { mmv, printed } of swept) {
      for (const line of lines) {
        const hits = printed.raw.flatMap((page, p) => page.flatMap((l, i) => (l === line.label ? [{ p, next: page[i + 1] }] : [])));
        expect(hits.length, `${line.label} is not printed (offset ${mmv}mm)`).toBeGreaterThan(0);
        const value = line.text.replace(/\u00a0/g, ' ');
        for (const hit of hits) {
          expect(hit.next, `${line.label}: its value is not on the same page (offset ${mmv}mm)`).toBeDefined();
          expect(value.startsWith(hit.next!.slice(0, 10)) || hit.next!.startsWith(value.slice(0, 10)),
            `${line.label}: followed by "${hit.next}", not its value "${value}" (offset ${mmv}mm)`).toBe(true);
        }
      }
    }
  });

  it('uses fewer sheets than one section per page', () => {
    expect(flowed.pages.length).toBeLessThan(forced.pages.length);
  });

  it('leaves no heading alone at a page foot, at every offset', () => {
    for (const { mmv, printed } of swept) {
      for (const [p, raw] of printed.raw.entries()) {
        expect(HEADINGS, `"${raw[raw.length - 1]}" is alone at the foot of page ${p + 1} (offset ${mmv}mm)`)
          .not.toContain(raw[raw.length - 1]);
      }
    }
  });
});

describe('spacing and the contents page', () => {
  it('sets a section that follows another well apart from it, and the contents does not stand alone', async () => {
    const file = path.join(dir, 'spacing.pdf');
    writeFileSync(file, await printLegacyPack(browser, bundle, DEMO));
    const { stdout } = await run('pdftotext', ['-bbox', '-f', '2', '-l', '4', file, '-']);
    const pages = stdout.split('<page ').slice(1).map((chunk) =>
      [...chunk.matchAll(/yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({ y0: +m[1]!, y1: +m[2]!, t: m[3]! })));
    const text = (p: number) => pages[p]!.map((w) => w.t).join(' ');
    // The contents and the first section share page 2.
    expect(text(0)).toContain('Contents');
    expect(text(0)).toContain('Statement of Comprehensive Income');
    // On that page, the second heading ("Statement of Financial Position") starts at
    // least 7mm (20pt) below the last line of the block above it.
    const words = pages[0]!;
    // The LAST match: the contents list names it too, further up the same page.
    const headingIdx = words.map((w, i) => (w.t === 'Statement' && words[i + 2]?.t === 'Financial' ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
    expect(headingIdx, 'the second section did not start on the same sheet').toBeGreaterThanOrEqual(0);
    {
      const top = words[headingIdx]!.y0;
      const above = Math.max(...words.filter((w) => w.y1 <= top).map((w) => w.y1));
      expect(words[headingIdx]!.y0 - above, 'the heading sits right under the block above').toBeGreaterThan(20);
    }
  }, 60_000);
});

describe('the DRAFT mark', () => {
  it('is on every sheet of a draft pack, and on none of a final one', async () => {
    const draft = await print('draft', { draft: true });
    const final = await print('final', { draft: false });
    expect(draft.pages.every((t) => /D\s*R\s*A\s*F\s*T/.test(t)), 'a sheet has no DRAFT mark').toBe(true);
    expect(final.pages.some((t) => /D\s*R\s*A\s*F\s*T/.test(t))).toBe(false);
  }, 120_000);
});
