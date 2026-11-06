/**
 * PAGE 6 PRINTS INSIDE ITS SHEET ON EVERY PACK THE ADVERSARY'S GRID FOUND IT OVERFLOWING, AND ON THE PACKS
 * THAT COMPOSE ONLY NOW.
 *
 * A budget company's page 6 (8 columns) ran 0.6 to 3.8mm past the foot of its sheet, and 35 of the packs printed
 * a thirteenth sheet, because the model never saw the label and the headings wrap. The table is now modelled at
 * the lines Chromium sets it in. Freeing the 4.4mm the old flat constants over-charged also lets packs compose
 * that were refused ("nothing left that may be dropped"), so they are printed here too: all must print 12
 * sheets with no page past its foot or its right edge.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { input, type Shape } from '../services/packs/fixtures/advInputs';
import { OVERFLOWED, WAS_REFUSED } from '../services/packs/fixtures/page6ExactShapes';
import { printBoardPack } from './renderPackPdf';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });

async function problems(shapes: Shape[]): Promise<string[]> {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const wrong: string[] = [];
  for (const shape of shapes) {
    const printed = await printBoardPack(buildBoardPackPages(input(shape)), browser);
    const over = printed.heights.filter((h) => h.overMm > 0.2).map((h) => `${h.id}+${h.overMm}`);
    const edge = printed.overflow.map((o) => `${o.id}+${o.over}px`);
    if (printed.sheets !== 12 || over.length > 0 || edge.length > 0) wrong.push(`${JSON.stringify(shape)}: ${printed.sheets} sheets, past the foot ${over}, past the edge ${edge}`);
  }
  return wrong;
}

describe('page 6 of a budget company', () => {
  it(`the adversary's ${OVERFLOWED.length} packs print 12 sheets, every page inside its sheet`, async () => {
    expect(await problems(OVERFLOWED)).toEqual([]);
  }, 900_000);

  it(`the ${WAS_REFUSED.length} packs that were refused compose and print 12 sheets, every page inside its sheet`, async () => {
    expect(await problems(WAS_REFUSED)).toEqual([]);
  }, 900_000);
});
