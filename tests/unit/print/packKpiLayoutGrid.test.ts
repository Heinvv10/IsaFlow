/**
 * THE KPI MODEL OVER THE WHOLE ADVERSARIAL GRID (opt-in: about an hour on velo).
 *
 *   KPI_GRID=1 ./node_modules/.bin/vitest run --config vitest.print.config.ts tests/unit/print/packKpiLayoutGrid.test.ts
 *
 * Every pack of the grid (`allShapes`: 11,520), each distinct KPI block measured once in production's layout and
 * held to `kpiLayoutCheck.ts`: columns within a pixel, every row and the block never short, never more than
 * `MOST_OVER` over but in the one-line band (pinned, `IN_BAND`). Then every pack is composed again with its KPI block
 * charged at exactly its printed height: where that changes the pack and the changed pack prints inside its sheets, the
 * model's excess dropped something that fits; only the known near-tie packs below may, and exactly that many. These
 * are the numbers `kpiLayoutCheck.ts` quotes.
 *
 * KNOWN LIMIT (#1196, accepted): 40 packs (0.35% of the grid, all net-debit at k=300,000) drop one page-3 note that
 * fits. Every one is in the band: the "Gross margin" tile's label and its footnote mark, which Chromium sets on one line
 * from a 76.046875px column, while the shaping model's width for it is 76.109375 (the exact advance sum ceiled to the
 * 1/64px unit, plus the unit of slack that keeps a width never short; 76.078125 without that unit): Chromium fits a
 * line 2 to 4 units narrower than the model's sum, and the column the figures leave reads 0.05px narrower for the same
 * slack. The model charges the line twice and the page drops a note. Fitting lines on the exact sums the way Chromium's
 * line breaker compares them is #1169's width model, a follow-up.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { log } from '@/lib/logger';
import { allShapes, h, key, type Shape } from '../services/packs/fixtures/packGridInputs';
import { build, check, tally } from './kpiLayoutCheck';
import { launchPrintChromium } from './printChromium';
import { printBoardPack } from './renderPackPdf';

const corr = vi.hoisted(() => ({ mm: 0 }));
vi.mock('@/modules/accounting/services/packs/pages/packKpiLayout', async (orig) => {
  const real = await orig<typeof import('@/modules/accounting/services/packs/pages/packKpiLayout')>();
  return { ...real, kpiBlockMm: (...args: Parameters<typeof real.kpiBlockMm>) => real.kpiBlockMm(...args) - corr.mm };
});

/** The grid's packs whose block reads one line over Chromium's (40 sets of tiles). */
const IN_BAND = 80;
/** Of those, the packs that drop a page-3 note that fits for it (the known limit above). */
const NEAR_TIE_OVER_TRIM = 40;

let browser: Browser;
beforeAll(async () => { if (process.env.KPI_GRID === '1') browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

describe.skipIf(process.env.KPI_GRID !== '1')('the KPI block of every pack of the grid', () => {
  it('never short, within MOST_OVER but the pinned band, and charged at its printed height no pack drops what fits but the known near ties', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    const seen = new Map<string, { overMm: number; banded: boolean }>();
    const band: Shape[] = [];
    let packs = 0;
    let shortest = Infinity;
    let tallest = -Infinity;
    const changed: string[] = [];
    const fitsAndDrops: string[] = [];
    for (const shape of allShapes()) {
      corr.mm = 0;
      const doc = build(shape);
      if (doc === null) { wrong.push(`${key(shape)}: refused`); continue; }
      packs += 1;
      const page = doc.pages.find((p) => p.blocks.some((b) => b.kind === 'kpiTiles'))!;
      const block = page.blocks.find((b) => b.kind === 'kpiTiles')!;
      const hash = h(block.kind === 'kpiTiles' ? block.tiles : null);
      if (!seen.has(hash)) {
        const t = tally();
        await check(doc, browser, key(shape), t);
        wrong.push(...t.wrong);
        shortest = Math.min(shortest, t.shortest);
        tallest = Math.max(tallest, t.tallest);
        seen.set(hash, { overMm: t.overMm[0]!, banded: t.banded.length > 0 });
      }
      const block3 = seen.get(hash)!;
      if (block3.banded) band.push(shape);
      // The pack again, its KPI block charged at exactly its printed height: it must be the same pack. Where it is not,
      // the model's excess decided something; a pack that then prints inside its sheets lost a note that fits.
      corr.mm = block3.overMm;
      const atPrint = build(shape)!;
      corr.mm = 0;
      if (JSON.stringify(atPrint.pages) !== JSON.stringify(doc.pages)) {
        changed.push(key(shape));
        const printed = await printBoardPack(atPrint, browser);
        const i = atPrint.pages.findIndex((p) => p.blocks.some((b) => b.kind === 'kpiTiles'));
        if (printed.sheets === atPrint.pages.length && printed.overflow.length === 0 && printed.heights[i]!.overMm <= 0.2) {
          fitsAndDrops.push(block3.banded ? key(shape) : `${key(shape)}: NOT a near tie`);
        }
      }
    }
    process.stdout.write(`KPIGRID packs=${packs} blocks=${seen.size} shortest=${shortest.toFixed(4)} tallest=${tallest.toFixed(4)} banded=${band.length} changedAtPrint=${changed.length} droppedThatFits=${fitsAndDrops.length}\n`);
    expect(packs).toBe(11_520);
    expect(wrong.slice(0, 12)).toEqual([]);
    expect(fitsAndDrops.filter((k) => k.endsWith('NOT a near tie')), 'only a near tie may cost a note that fits').toEqual([]);
    expect(fitsAndDrops.length, 'the near-tie packs that drop a note that fits').toBe(NEAR_TIE_OVER_TRIM);
    expect(band.length).toBe(IN_BAND);
  }, 14_400_000);
});
