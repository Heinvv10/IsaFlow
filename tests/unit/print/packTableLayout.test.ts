/**
 * THE FIT MODEL'S TABLE LAYOUT IS CHROMIUM'S, TABLE BY TABLE.
 *
 * `packTableLayout.ts` says how wide each column of a statement table is set, how many lines each row label and
 * the headings take. This prints a stratified sample of packs (budget on and off, scales 1 to 3e5, profit and
 * loss, net-debit revenue) and holds every statement table on every page to what Chromium made of it: columns
 * within a pixel, the same lines for every label, the same lines for the headings.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { HEADING_SPACE_PX, HEADING_WORDS_PX, statementTableBodyMm, tableLayout } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { WRAP_GUARD_PX } from '@/modules/accounting/services/packs/pages/packLineWrap';
import { PACK_TABLE_COLUMN_LABEL } from '@/modules/accounting/services/packs/pages/packTableModel';
import { input, type Shape } from '../services/packs/fixtures/packGridInputs';
import { demoWithoutBudget, withWidenedStatement, withWidenedTable } from '../services/packs/fixtures/widenedFigures';
import { measure } from './measureWidths';
import { measureTables } from './measureTables';
import { stampFigureFits } from '@/modules/accounting/services/packs/pages/packFigureFitStamp';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

describe('the heading widths', () => {
  it('every word and every space is what `.pack-table th` sets, to a hundredth, never short', async () => {
    const wrong: string[] = [];
    for (const [col, label] of Object.entries(PACK_TABLE_COLUMN_LABEL)) {
      const words = label.split(' ');
      const res = await measure(browser, [...words, label].map((w) => ({ probe: 'th' as const, text: w.toUpperCase(), html: `<span style="text-transform:uppercase">${w}</span>` })));
      const model = HEADING_WORDS_PX[col as keyof typeof HEADING_WORDS_PX];
      words.forEach((w, i) => { if (model[i]! < res[i]!.widthPx - 0.001 || model[i]! > res[i]!.widthPx + 0.05) wrong.push(`${col} ${w}: ${model[i]} vs ${res[i]!.widthPx.toFixed(3)}`); });
      const full = res[words.length]!.widthPx;
      const built = model.reduce((a, b) => a + b, 0) + HEADING_SPACE_PX * (words.length - 1);
      if (built < full - 0.001 || built > full + 0.2) wrong.push(`${col} full: ${built.toFixed(2)} vs ${full.toFixed(2)}`);
    }
    expect(wrong).toEqual([]);
  });
});

const SHAPES: Shape[] = [];
// Budget on and off, a prior or none, trend panels or none (no panels, zero-revenue panels), profit and loss,
// net-debit revenue, three sign patterns, and the scales where the moved thresholds sit (3e5 to 3e6) as well as 1 to 3e4.
for (const k of [1, 30, 1000, 30000, 300000, 1e6, 3e6]) for (const negative of [false, true]) for (const loss of [false, true])
  for (const sg of [[1, 1, 1, 1], [-1, -1, 1, 1], [1, -1, -1, 1]]) for (const budget of [true, false])
    for (const [prior, tr] of [[true, 'demo'], [false, 'none'], [true, 'zero']] as const) SHAPES.push({ k, negative, loss, plug: 0.05, sg, budget, prior, tr });

/** How far the model's columns may be from Chromium's (`packLineWrap.ts` sets the guard from it). */
const COLUMN_ERROR_PX = 0.1;
/** At most this many label rows a line taller than Chromium's, at a near tie (a piece within the model's error of its line). */
const TIES_ALLOWED = 6;

describe('the layout of every statement table of a stratified sample of packs', () => {
  it(`${SHAPES.length} packs (prior and trend panels on and off, k to 3e6): columns within 0.1px, never a label line too few, heading lines equal, height never short`, async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    let tables = 0;
    let wrappedLabels = 0;
    let wrappedHeadings = 0;
    let tallest = -Infinity;
    let shortest = Infinity;
    let widerBy = -Infinity;
    const ties: string[] = [];
    for (const shape of SHAPES) {
      let doc;
      try { doc = buildBoardPackPages(input(shape)); } catch (e) { if (e instanceof PackRefusal) continue; throw e; }
      const printed = await measureTables(doc, browser);
      const seen = new Map<number, number>();
      for (const page of doc.pages) {
        const tablesOnPage = page.blocks.filter((b) => b.kind === 'table');
        tablesOnPage.forEach((block, i) => {
          const real = printed.filter((t) => t.page === page.number)[i];
          if (real === undefined || block.kind !== 'table') { wrong.push(`${JSON.stringify(shape)} page ${page.number}: no printed table`); return; }
          seen.set(page.number, i + 1);
          tables += 1;
          const model = tableLayout(block.table, doc.numberConvention.scale, page.orientation);
          const label = `${JSON.stringify(shape)} page ${page.number} table ${i}`;
          model.columnsPx.forEach((px, c) => {
            const err = px - real.columnsPx[c]!;
            widerBy = Math.max(widerBy, err);
            if (Math.abs(err) > COLUMN_ERROR_PX) wrong.push(`${label} column ${c}: model ${px.toFixed(3)} vs ${real.columnsPx[c]!.toFixed(3)}`);
          });
          model.labelLines.forEach((l, r) => {
            if (l < real.labelLines[r]!) wrong.push(`${label} row ${r}: model ${l} lines, Chromium ${real.labelLines[r]} (a line too few)`);
            if (l > real.labelLines[r]!) {
              ties.push(`${label} row ${r}`);
              // A line too many only at a near tie: with no guard and the columns as Chromium set them, the model agrees.
              if (tableLayout(block.table, doc.numberConvention.scale, page.orientation, -COLUMN_ERROR_PX).labelLines[r] !== real.labelLines[r]) wrong.push(`${label} row ${r}: a line too many, and not at a tie`);
            }
          });
          wrappedLabels += real.labelLines.filter((l) => l > 1).length;
          if (real.headingLines > 1) wrappedHeadings += 1;
          const gap = statementTableBodyMm(block.table, doc.numberConvention.scale, page.orientation) - real.heightMm;
          tallest = Math.max(tallest, gap);
          shortest = Math.min(shortest, gap);

          if (model.headingLines !== real.headingLines) wrong.push(`${label} heading lines: model ${model.headingLines} vs ${real.headingLines}`);
        });
      }
    }
    expect(tables).toBeGreaterThan(300);
    // Non-vacuous: the sample must contain the wraps the model exists to see.
    expect(wrappedLabels, 'no wrapped label in the sample').toBeGreaterThan(20);
    expect(wrappedHeadings, 'no two-line heading in the sample').toBeGreaterThan(5);
    // The height of the table is never short of Chromium's, and over by at most the roundings up (measured over this
    // sample: 0.31 to 1.53mm, the top end a table whose rows nearly all wrap).
    expect(shortest, 'a table modelled shorter than it printed').toBeGreaterThanOrEqual(0);
    // The guard covers the widest the model's column is of Chromium's: a column modelled that much too wide could fit a
    // piece Chromium wraps (`packLineWrap.WRAP_GUARD_PX`).
    expect(widerBy, 'a model column wider than Chromium\'s by more than the guard').toBeLessThanOrEqual(WRAP_GUARD_PX);
    expect(ties.length, `rows a line taller than Chromium at a near tie: ${ties.join('; ')}`).toBeLessThanOrEqual(TIES_ALLOWED);
    // Over by at most the roundings up, and a 13pt line for each near tie.
    expect(tallest, 'a table modelled taller than it printed').toBeLessThanOrEqual(1.6 + 4.6 * ties.length);
    expect(wrong.slice(0, 12)).toEqual([]);
  }, 1_200_000);
});

describe('a footnote mark sits on the LAST word of a label', () => {
  // "nnnn... ab" with a marker: the column's minimum is the longest word, and the mark joins "ab", not the long word.
  // Swept over the long word's length so the mark's pixels cross a threshold somewhere.
  it('columns and height equal Chromium, and label lines are never fewer, for labels whose last word is not the longest', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    let ties = 0;
    for (let n = 10; n <= 40; n += 1) {
      for (const digits of [9, 12]) {
        const { doc, table, index } = withWidenedTable(demoWithoutBudget(), digits, `${'n'.repeat(n)} ab`, { labelMarker: true });
        const real = (await measureTables(doc, browser)).filter((t) => t.page === doc.pages[index]!.number)[0]!;
        const model = tableLayout(table, doc.numberConvention.scale, 'portrait');
        model.columnsPx.forEach((px, c) => { if (Math.abs(px - real.columnsPx[c]!) > 1) wrong.push(`${n} chars, ${digits} digits: column ${c} model ${px.toFixed(1)} vs ${real.columnsPx[c]!.toFixed(1)}`); });
        // Never fewer lines than Chromium; one more is the wrap guard's tenth of a pixel on a tie, counted below.
        if (model.labelLines.some((l, r) => l < real.labelLines[r]!)) wrong.push(`${n} chars, ${digits} digits: lines ${model.labelLines} vs ${real.labelLines}`);
        if (model.labelLines.some((l, r) => l > real.labelLines[r]!)) ties += 1;
        if (statementTableBodyMm(table, doc.numberConvention.scale, 'portrait') < real.heightMm) wrong.push(`${n} chars, ${digits} digits: height short`);
      }
    }
    expect(wrong.slice(0, 10)).toEqual([]);
    expect(ties, 'the guard may cost a line on a tie, not on many').toBeLessThanOrEqual(4);
  }, 900_000);
});

describe('adjacent heavy rows share their rules', () => {
  // `border-collapse: collapse`: two rows meet at ONE border, as wide as the wider of the two, half of it on each row;
  // the rule under the last row is shared with the table's edge.
  it('every sequence of four row roles, and the alternating and all-grand-total tables of fourteen: the height is Chromium\'s, never short', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const roles = ['line', 'subtotal', 'total', 'grandTotal'] as const;
    const doc = structuredClone(buildBoardPackPages(input({ tr: 'demo', budget: false, prior: true, negative: false, loss: false, k: 1, plug: 0.05, sg: [1, 1, 1, 1] })));
    const index = doc.pages.findIndex((p) => p.navLabel === 'Income statement');
    const block = doc.pages[index]!.blocks.find((b) => b.kind === 'table')!;
    if (block.kind !== 'table') throw new Error('no table');
    const base = block.table.rows[0]!;
    const sequences: Array<Array<(typeof roles)[number]>> = [];
    for (const a of roles) for (const b of roles) for (const c of roles) sequences.push([a, b, c, a]);
    sequences.push(Array.from({ length: 14 }, (unused, i) => (i % 2 ? 'grandTotal' : 'total')), Array.from({ length: 14 }, () => 'grandTotal'));
    const wrong: string[] = [];
    let tightest = Infinity;
    for (const seq of sequences) {
      block.table = { ...block.table, rows: seq.map((role, n) => ({ ...base, label: `Row ${n}`, role, key: `k${n}`, footnote: undefined })) };
      const real = (await measureTables(stampFigureFits(doc), browser)).find((t) => t.page === doc.pages[index]!.number)!;
      const gap = statementTableBodyMm(block.table, doc.numberConvention.scale, 'portrait') - real.heightMm;
      tightest = Math.min(tightest, gap);
      if (gap < 0 || gap > 0.5) wrong.push(`${seq.join('>')}: model minus Chromium ${gap.toFixed(3)}mm`);
    }
    expect(wrong).toEqual([]);
    expect(tightest).toBeGreaterThanOrEqual(0);
  }, 600_000);
});

describe('a label that fits its column to within a fraction of a pixel (the adversary\'s six over-trimmed packs)', () => {
  // k=30,000, net-credit revenue, plug 0 and an other-expenses line below zero: "Cost of sales" and "Other income"
  // measure 74.5px against a 74.6px column. With a half-pixel guard the model wrapped both (9.3mm over the print);
  // the guard is a tenth of a pixel now, and the layout's columns are Chromium's to the hundredth.
  it('the model sets the same lines as Chromium and reads the table within 0.2mm', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const doc = buildBoardPackPages(input({ tr: 'demo', budget: true, prior: true, negative: false, loss: false, k: 30000, plug: 0, sg: [1, 1, 1, -1] }));
    const page = doc.pages.find((p) => p.navLabel === 'Income statement')!;
    const block = page.blocks.find((b) => b.kind === 'table')!;
    if (block.kind !== 'table') throw new Error('no table');
    const real = (await measureTables(doc, browser)).find((t) => t.page === page.number)!;
    const model = tableLayout(block.table, doc.numberConvention.scale, page.orientation);
    expect(model.labelLines).toEqual(real.labelLines);
    const gap = statementTableBodyMm(block.table, doc.numberConvention.scale, page.orientation) - real.heightMm;
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(0.2);
  }, 120_000);
});

describe('near ties off page 6: balance sheet labels that wrap, a fraction of a pixel inside their column', () => {
  // Found by sweeping the label and the figures' width (the adversary's round 3 found the earlier sweep never wrapped a
  // balance sheet label): each first-row label takes two to four lines and one of its pieces ends 0.08 to 0.24px
  // inside the column. The guard sets Chromium's lines on every one; a half-pixel guard sets a line too many.
  const NEAR_TIES = [
    ['Balance sheet', 19, 'Inventories and work in progress'], ['Balance sheet', 19, 'Non-current liabilities total'],
    ['Balance sheet', 21, 'Prepayments and deposits paidiii'], ['Balance sheet', 19, 'Current assetsiiiiii'],
  ] as const;

  it.each(NEAR_TIES)('%s, %i digits, "%s": the model\'s lines are Chromium\'s, and a half-pixel guard would add one', async (nav, digits, label) => {
    const { doc, table, index } = withWidenedStatement(demoWithoutBudget(), nav, digits, label);
    const page = doc.pages[index]!;
    expect(page.number).not.toBe(6);
    const real = (await measureTables(doc, browser)).filter((t) => t.page === page.number)[0]!;
    expect(real.labelLines[0], 'the label wraps').toBeGreaterThan(1);
    expect(tableLayout(table, doc.numberConvention.scale, page.orientation).labelLines).toEqual(real.labelLines);
    expect(tableLayout(table, doc.numberConvention.scale, page.orientation, 0.5).labelLines, 'not a near tie').not.toEqual(real.labelLines);
  }, 120_000);
});
