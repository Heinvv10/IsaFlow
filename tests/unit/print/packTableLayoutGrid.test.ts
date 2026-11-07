/**
 * THE TABLE LAYOUT OVER THE WHOLE ADVERSARIAL GRID (opt-in: about an hour on velo).
 *
 *   TABLE_GRID=1 ./node_modules/.bin/vitest run --config vitest.print.config.ts tests/unit/print/packTableLayoutGrid.test.ts
 *
 * Every statement table of every pack of the grid (`allShapes`: 11,520 packs, each distinct table printed once), held to
 * what Chromium makes of it: never a label line too few, never a line too many (a line is fitted as Chromium's line
 * breaker fits it, `textFitPx`), the same heading lines, columns within the portrait guard, the height never short.
 * `packTableLayout.test.ts` is the stratified sample of the same, in every run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { statementTableBodyMm, tableLayout } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { WRAP_GUARD } from '@/modules/accounting/services/packs/pages/packLineWrap';
import { allShapes, h, input, key } from '../services/packs/fixtures/packGridInputs';
import { measureTables } from './measureTables';
import { launchPrintChromium } from './printChromium';

let browser: Browser;
beforeAll(async () => { if (process.env.TABLE_GRID === '1') browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

describe.skipIf(process.env.TABLE_GRID !== '1')('every statement table of every pack of the grid', () => {
  it('never a line too few or too many, heading lines equal, columns within the guard, height never short', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    const seen = new Set<string>();
    let packs = 0;
    let widerBy = -Infinity;
    for (const shape of allShapes()) {
      let doc;
      try { doc = buildBoardPackPages(input(shape)); } catch (e) { if (e instanceof PackRefusal) continue; throw e; }
      packs += 1;
      const fresh = doc.pages.flatMap((page) => page.blocks.flatMap((b) => (b.kind === 'table' ? [h([page.orientation, b.table])] : [])))
        .filter((hash) => !seen.has(hash));
      if (fresh.length === 0) continue;
      const printed = await measureTables(doc, browser);
      for (const page of doc.pages) {
        page.blocks.filter((b) => b.kind === 'table').forEach((block, i) => {
          if (block.kind !== 'table') return;
          const hash = h([page.orientation, block.table]);
          if (seen.has(hash)) return;
          seen.add(hash);
          const real = printed.filter((t) => t.page === page.number)[i];
          const where = `${key(shape)} page ${page.number} table ${i}`;
          if (real === undefined) { wrong.push(`${where}: no printed table`); return; }
          const scale = doc.numberConvention.scale;
          const model = tableLayout(block.table, scale, page.orientation);
          model.columnsPx.forEach((px, c) => { widerBy = Math.max(widerBy, px - real.columnsPx[c]!); });
          model.labelLines.forEach((l, r) => { if (l !== real.labelLines[r]) wrong.push(`${where} row ${r}: model ${l} lines, Chromium ${real.labelLines[r]}`); });
          if (model.headingLines !== real.headingLines) wrong.push(`${where} heading lines: model ${model.headingLines} vs ${real.headingLines}`);
          if (statementTableBodyMm(block.table, scale, page.orientation) < real.heightMm) wrong.push(`${where}: height short`);
        });
      }
    }
    process.stdout.write(`TABLEGRID packs=${packs} tables=${seen.size} widerBy=${widerBy}\n`);
    expect(packs).toBe(11_520);
    expect(wrong.slice(0, 12)).toEqual([]);
    expect(widerBy).toBeLessThanOrEqual(WRAP_GUARD.portrait);
  }, 14_400_000);
});
