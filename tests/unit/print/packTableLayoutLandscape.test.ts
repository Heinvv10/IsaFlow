/**
 * THE TABLE LAYOUT ON A LANDSCAPE SHEET IS CHROMIUM'S TOO.
 *
 * The board pack prints its statements portrait, so the stratified sample in `packTableLayout.test.ts` never laid a
 * statement table out at the landscape width (987px), where the columns share out a third more room and the labels
 * wrap less. This sets every statement page of a sample of packs landscape (the fit restamped for it) and holds each
 * table to what Chromium makes of it at that width: columns within 0.1px, never a label line too few and a line too
 * many only at a near tie, the same heading lines, the height never short.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { stampFigureFits } from '@/modules/accounting/services/packs/pages/packFigureFitStamp';
import { statementTableBodyMm, tableLayout } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { WRAP_GUARD } from '@/modules/accounting/services/packs/pages/packLineWrap';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { input, type Shape } from '../services/packs/fixtures/packGridInputs';
import { demoWithoutBudget, withWidenedStatement } from '../services/packs/fixtures/widenedFigures';
import { measureTables } from './measureTables';
import { atTheFloor } from './support/atTheFloor';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const COLUMN_ERROR_PX = 0.1;
const SHAPES: Shape[] = [];
for (const k of [1, 1000, 30000, 1e6, 3e6]) for (const negative of [false, true]) for (const sg of [[1, 1, 1, 1], [1, -1, -1, 1]])
  for (const budget of [true, false]) for (const [prior, tr] of [[true, 'demo'], [false, 'none']] as const) {
    SHAPES.push({ k, negative, loss: k > 1000, plug: 0.05, sg, budget, prior, tr });
  }

/** One pack: every statement page landscape, each table held to Chromium at that width. */
async function check(built: PackPagesDocument, name: string, out: { wrong: string[]; ties: string[]; tables: number; wrapped: number; widerBy: number }): Promise<void> {
  const statements = new Set(built.pages.filter((p) => p.blocks.some((b) => b.kind === 'table')).map((p) => p.number));
  const doc = stampFigureFits({ ...built, pages: built.pages.map((p) => (statements.has(p.number) ? { ...p, orientation: 'landscape' as const } : p)) });
  const printed = await measureTables(atTheFloor(doc), browser, 'landscape');
  for (const page of doc.pages.filter((p) => statements.has(p.number))) {
    page.blocks.filter((b) => b.kind === 'table').forEach((block, i) => {
      const real = printed.filter((t) => t.page === page.number)[i];
      if (real === undefined || block.kind !== 'table') { out.wrong.push(`${name} page ${page.number}: no printed table`); return; }
      out.tables += 1;
      const scale = doc.numberConvention.scale;
      const model = tableLayout(block.table, scale, 'landscape');
      const label = `${name} page ${page.number} table ${i}`;
      model.columnsPx.forEach((px, c) => {
        const err = px - real.columnsPx[c]!;
        out.widerBy = Math.max(out.widerBy, err);
        if (Math.abs(err) > COLUMN_ERROR_PX) out.wrong.push(`${label} column ${c}: model ${px.toFixed(3)} vs ${real.columnsPx[c]!.toFixed(3)}`);
      });
      model.labelLines.forEach((l, r) => {
        if (l < real.labelLines[r]!) out.wrong.push(`${label} row ${r}: model ${l} lines, Chromium ${real.labelLines[r]} (a line too few)`);
        if (l > real.labelLines[r]!) {
          out.ties.push(`${label} row ${r}`);
          if (tableLayout(block.table, scale, 'landscape', -COLUMN_ERROR_PX).labelLines[r] !== real.labelLines[r]) out.wrong.push(`${label} row ${r}: a line too many, and not at a tie`);
        }
      });
      out.wrapped += real.labelLines.filter((l) => l > 1).length + (real.headingLines > 1 ? 1 : 0);
      if (model.headingLines !== real.headingLines) out.wrong.push(`${label} heading lines: model ${model.headingLines} vs ${real.headingLines}`);
      if (statementTableBodyMm(block.table, scale, 'landscape') < real.heightMm) out.wrong.push(`${label}: height short`);
    });
  }
}

/** Long first-row labels at wide figures, so a landscape sheet's labels wrap (the grid's never do at 987px). */
const LONG_LABELS = [
  'Inventories, work in progress and other current assets held for sale within the period',
  'Trade and other receivables net of the allowance for expected credit losses',
  'Proceeds from the disposal of property, plant and equipment and intangibles',
];

describe('every statement table of a sample of packs, set landscape', () => {
  it(`${SHAPES.length} packs, and long labels on each statement at wide figures: columns within 0.1px, never a label line too few, heading lines equal, height never short`, async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const out = { wrong: [] as string[], ties: [] as string[], tables: 0, wrapped: 0, widerBy: -Infinity };
    for (const shape of SHAPES) {
      let built;
      try { built = buildBoardPackPages(input(shape)); } catch (e) { if (e instanceof PackRefusal) continue; throw e; }
      await check(built, JSON.stringify(shape), out);
    }
    for (const nav of ['Income statement', 'Balance sheet', 'Cash']) for (const digits of [9, 15, 21]) for (const label of LONG_LABELS) {
      await check(withWidenedStatement(demoWithoutBudget(), nav, digits, label).doc, `${nav}, ${digits} digits, ${JSON.stringify(label)}`, out);
    }
    expect(out.wrong.slice(0, 12)).toEqual([]);
    expect(out.tables).toBeGreaterThan(150);
    expect(out.wrapped, 'too few wrapped labels on a landscape sheet to test the fill').toBeGreaterThan(20);
    expect(out.widerBy, 'a model column wider than Chromium\'s by more than the landscape guard').toBeLessThanOrEqual(WRAP_GUARD.landscape);
    expect(out.ties.length, `rows a line taller than Chromium at a near tie: ${out.ties.join('; ')}`).toBeLessThanOrEqual(3);
  }, 1_200_000);
});
