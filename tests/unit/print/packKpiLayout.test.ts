/**
 * THE FIT MODEL'S KPI BLOCK IS CHROMIUM'S, ROW BY ROW.
 *
 * `packKpiLayout.ts` says how wide each of the four columns is and how tall each row of tiles and the block are.
 * This prints a stratified sample of packs (net-debit and ordinary revenue, profit and loss, with and without a
 * budget, a prior and trend panels, scales 1 to 3e8) and holds every KPI block to what Chromium made of it
 * (`kpiLayoutCheck.ts`): columns within a pixel, rows and the block never short, never more than `MOST_OVER` over
 * but in the one-line band. "What Chromium made of it" is production's layout: text set at fractional advances
 * (`launchPrintChromium`, as Gotenberg sets it) across the width production prints a page at (`PRINT_CONTENT_PX`, by
 * `measureKpiBlocks`), in portrait and, with the page turned, landscape. The whole adversarial grid, 11,520 packs, is
 * `packKpiLayoutGrid.test.ts` (opt-in).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { stampFigureFits } from '@/modules/accounting/services/packs/pages/packFigureFitStamp';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { input, type Shape } from '../services/packs/fixtures/packGridInputs';
import { build, check, MOST_OVER, tally, turned } from './kpiLayoutCheck';
import { launchPrintChromium } from './printChromium';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const SHAPES: Shape[] = [];
for (const k of [1, 30, 1000, 30000, 300000, 3e7, 2.7e8]) for (const negative of [false, true]) for (const loss of [false, true])
  for (const sg of [[1, 1, 1, 1], [-1, -1, 1, 1], [1, -1, -1, 1]]) for (const tr of ['demo', 'none'] as const)
    for (const [budget, prior] of [[true, true], [false, false]] as const) SHAPES.push({ k, negative, loss, plug: 0.05, sg, budget, prior, tr });

/**
 * The blocks of this sample in the one-line band, pinned: a width model that drifts moves the count either way, and
 * the near ties are named in the failure. Portrait: two net-debit packs at k=300,000 ("Gross margin" and its mark,
 * a unit over its column) and two at k=3e7.
 */
const IN_BAND = { portrait: 4, landscape: 0 } as const;

describe('the KPI block of a stratified sample of packs', () => {
  it.each(['portrait', 'landscape'] as const)(`${SHAPES.length} packs, %s: columns within 1px, rows and the block never short, within ${MOST_OVER}mm but the band`, async (orientation) => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const t = tally();
    for (const shape of SHAPES) {
      const doc = build(shape);
      if (doc !== null) await check(orientation === 'portrait' ? doc : turned(doc), browser, JSON.stringify(shape), t);
    }
    expect(t.blocks).toBeGreaterThan(200);
    if (orientation === 'portrait') expect(t.squeezed, 'the sample must hold a squeezed column (a reason or a label holding its column open)').toBeGreaterThan(5);
    expect(t.wrong.slice(0, 12)).toEqual([]);
    expect(t.banded.length, `in the band: ${t.banded.join('; ')}`).toBe(IN_BAND[orientation]);
    process.stdout.write(`KPIGAP ${orientation} ${t.shortest.toFixed(3)} ${t.tallest.toFixed(3)} blocks=${t.blocks} squeezed=${t.squeezed} banded=${t.banded.length}\n`);
  }, 1_800_000);
});

describe('packs on an edge (#1196: the adversary\'s two, and a delta line at its column), at production\'s width', () => {
  it.each<[string, Shape]>([
    ['a reason in column 2 the 657.6px model wrapped a line more than the print (read 5mm tall)', { tr: 'none', budget: true, prior: true, negative: true, loss: true, k: 30000, plug: 0.05, sg: [-1, -1, 1, -1] }],
    ['a pack the 657.6px model read 0.07mm short of the print', { tr: 'demo', budget: false, prior: false, negative: true, loss: false, k: 30000, plug: 0.2, sg: [-1, 1, -1, -1] }],
    ['a delta line that fits its column measured whole (summed piece by piece, it took a second line: 4.35mm tall)', { tr: 'demo', budget: true, prior: true, negative: false, loss: false, k: 1, plug: 0.2, sg: [-1, 1, -1, 1] }],
  ])('%s', async (_name, shape) => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const t = tally();
    await check(buildBoardPackPages(input(shape)), browser, JSON.stringify(shape), t);
    expect(t.blocks).toBe(1);
    expect(t.wrong).toEqual([]);
    expect(t.banded).toEqual([]);
  }, 300_000);
});

/**
 * A pack whose KPI tiles carry `text`: as every other tile's not-meaningful reason, every label, or every delta's basis.
 * The pack's own wording has no soft hyphen or zero-width space; these hold the model to where Chromium breaks at one.
 */
function withText(text: string, where: 'reason' | 'label' | 'delta'): PackPagesDocument {
  const doc = structuredClone(buildBoardPackPages(input({ tr: 'none', budget: true, prior: true, negative: true, loss: true, k: 30000, plug: 0.05, sg: [-1, -1, 1, -1] })));
  const page = doc.pages.find((p) => p.blocks.some((b) => b.kind === 'kpiTiles'))!;
  const block = page.blocks.find((b) => b.kind === 'kpiTiles')!;
  if (block.kind !== 'kpiTiles') throw new Error('no tiles');
  block.tiles = block.tiles.map((t, i) => {
    if (where === 'label') return { ...t, label: text };
    if (where === 'delta') return t.delta === null ? t : { ...t, delta: { ...t.delta, basis: text } };
    return i % 2 === 1 ? { ...t, figure: { ...t.figure, value: null, unavailable: `Not meaningful: ${text} ${text}.` } } : t;
  });
  return stampFigureFits(doc);
}

describe('a zero-width space and a soft hyphen in a tile\'s text (where Chromium breaks, a hyphen shown at the soft one)', () => {
  const ZWSP = 'zero\u200Bwidth\u200Bspace\u200Bwords\u200Bhere';
  const SHY = 'soft\u00ADhyphen\u00ADated\u00ADwording';
  it.each([
    ['zero-width spaces in a reason', ZWSP, 'reason'], ['soft hyphens in a reason', SHY, 'reason'],
    ['zero-width spaces in a label', ZWSP, 'label'], ['soft hyphens in a label', SHY, 'label'],
    ['zero-width spaces in a delta', ZWSP, 'delta'], ['soft hyphens in a delta', SHY, 'delta'],
  ] as const)('%s: columns, rows and the block as Chromium sets them', async (_name, text, where) => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const t = tally();
    await check(withText(text, where), browser, `${where} ${JSON.stringify(text)}`, t);
    expect(t.blocks).toBe(1);
    expect(t.wrong).toEqual([]);
    expect(t.banded).toEqual([]);
  }, 300_000);
});
