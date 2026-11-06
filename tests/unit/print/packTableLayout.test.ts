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
import { chromium } from 'playwright';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { HEADING_SPACE_PX, HEADING_WORDS_PX, statementTableBodyMm, tableLayout } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { PACK_TABLE_COLUMN_LABEL } from '@/modules/accounting/services/packs/pages/packTableModel';
import { input, type Shape } from '../services/packs/fixtures/packGridInputs';
import { demoWithoutBudget, withWidenedTable } from '../services/packs/fixtures/widenedFigures';
import { measure } from './measureWidths';
import { measureTables } from './measureTables';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
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

describe('the layout of every statement table of a stratified sample of packs', () => {
  it(`${SHAPES.length} packs (prior and trend panels on and off, k to 3e6): columns within 1px, label lines and heading lines equal, height never short`, async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    let tables = 0;
    let wrappedLabels = 0;
    let wrappedHeadings = 0;
    let tallest = -Infinity;
    let shortest = Infinity;
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
          model.columnsPx.forEach((px, c) => { if (Math.abs(px - real.columnsPx[c]!) > 1) wrong.push(`${label} column ${c}: model ${px.toFixed(1)} vs ${real.columnsPx[c]!.toFixed(1)}`); });
          if (model.labelLines.join() !== real.labelLines.join()) wrong.push(`${label} label lines: model ${model.labelLines} vs ${real.labelLines}`);
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
    expect(tallest, "a table modelled taller than it printed").toBeLessThanOrEqual(1.6);
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
        // Never fewer lines than Chromium; one more is the wrap guard's half pixel on a tie, counted below.
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
      const real = (await measureTables(doc, browser)).find((t) => t.page === doc.pages[index]!.number)!;
      const gap = statementTableBodyMm(block.table, doc.numberConvention.scale, 'portrait') - real.heightMm;
      tightest = Math.min(tightest, gap);
      if (gap < 0 || gap > 0.5) wrong.push(`${seq.join('>')}: model minus Chromium ${gap.toFixed(3)}mm`);
    }
    expect(wrong).toEqual([]);
    expect(tightest).toBeGreaterThanOrEqual(0);
  }, 600_000);
});
