/**
 * THE KPI MODEL OVER THE WHOLE ADVERSARIAL GRID (opt-in: about 40 minutes on velo).
 *
 *   KPI_GRID=1 ./node_modules/.bin/vitest run --config vitest.print.config.ts tests/unit/print/packKpiLayoutGrid.test.ts
 *
 * Every pack of the grid (`allShapes`: 11,520), each distinct KPI block measured once in production's layout and
 * held to `kpiLayoutCheck.ts`: columns within a pixel, every row and the block never short, never more than
 * `MOST_OVER` over but in the one-line band. The band is pinned (`IN_BAND`), and each pack in it is composed again with
 * its block charged at the printed height: the document must not change (no note, column or block it would have kept),
 * and it prints its twelve sheets. These are the numbers `kpiLayoutCheck.ts` quotes. Last run (2026-11-07): 5,760
 * distinct blocks, 0.008 to 0.057mm over, 80 packs in the band, none of them changed.
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

let browser: Browser;
beforeAll(async () => { if (process.env.KPI_GRID === '1') browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

describe.skipIf(process.env.KPI_GRID !== '1')('the KPI block of every pack of the grid', () => {
  it('never short, within MOST_OVER but the pinned band, and no pack in the band loses anything for it', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    const seen = new Map<string, number | null>();
    const band: Array<{ shape: Shape; overMm: number }> = [];
    let packs = 0;
    let shortest = Infinity;
    let tallest = -Infinity;
    for (const shape of allShapes()) {
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
        seen.set(hash, t.bandedOverMm[0] ?? null);
      }
      const overMm = seen.get(hash) ?? null;
      if (overMm !== null) band.push({ shape, overMm });
    }
    process.stdout.write(`KPIGRID packs=${packs} blocks=${seen.size} shortest=${shortest.toFixed(3)} tallest=${tallest.toFixed(3)} banded=${band.length}\n`);
    expect(packs).toBe(11_520);
    expect(wrong.slice(0, 12)).toEqual([]);

    const lost: string[] = [];
    for (const { shape, overMm } of band) {
      corr.mm = 0;
      const asIs = build(shape)!;
      corr.mm = overMm;
      const atPrint = build(shape)!;
      corr.mm = 0;
      if (JSON.stringify(atPrint.pages) !== JSON.stringify(asIs.pages)) lost.push(`${key(shape)}: composed at the printed height, the pack changes`);
      const printed = await printBoardPack(asIs, browser);
      if (printed.sheets !== asIs.pages.length || printed.overflow.length > 0) lost.push(`${key(shape)}: ${printed.sheets} sheets, ${printed.overflow.length} past the edge`);
    }
    expect(lost).toEqual([]);
    expect(band.length).toBe(IN_BAND);
  }, 14_400_000);
});
