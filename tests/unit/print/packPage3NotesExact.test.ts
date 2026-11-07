/**
 * PAGE 3 KEEPS THE NOTES IT PRINTS INSIDE ITS SHEET WITH.
 *
 * The KPI block was modelled 5.6 to 52.7mm too tall, so on 184 of the grid's packs master dropped one or two of
 * page 3's explanatory notes that pre-#1158 printed (clean, inside the sheet) and that fit. The block is modelled at
 * the lines Chromium sets its tiles in now: each of these keeps at least the notes pre-#1158 kept, and prints 12
 * sheets with nothing past the foot or the edge.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { input } from '../services/packs/fixtures/packGridInputs';
import { OVER_TRIMMED } from '../services/packs/fixtures/page3OverTrimmed';
import { launchPrintChromium } from './printChromium';
import { printBoardPack } from './renderPackPdf';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });
afterEach(() => { vi.restoreAllMocks(); });

describe(`${OVER_TRIMMED.length} packs master over-trimmed`, () => {
  it('each keeps at least the notes pre-#1158 kept, and prints clean', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    for (const { shape, preNotes, masterNotes } of OVER_TRIMMED) {
      const doc = buildBoardPackPages(input(shape));
      const index = doc.pages.findIndex((p) => p.navLabel === 'Highlights');
      const notes = doc.pages[index]!.blocks.flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes.length : 0)).reduce((a, b) => a + b, 0);
      const printed = await printBoardPack(doc, browser);
      const over = printed.heights.filter((h) => h.overMm > 0.2).map((h) => `${h.id}+${h.overMm}`);
      if (notes < preNotes) wrong.push(`${JSON.stringify(shape)}: keeps ${notes} notes, pre-#1158 kept ${preNotes} (master ${masterNotes})`);
      if (printed.sheets !== 12 || over.length > 0 || printed.overflow.length > 0) wrong.push(`${JSON.stringify(shape)}: ${printed.sheets} sheets, past the foot ${over}, past the edge ${printed.overflow.length}`);
    }
    expect(wrong).toEqual([]);
  }, 900_000);
});
