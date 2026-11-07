/**
 * THE FIT DECISION IS EXACT AT ITS THRESHOLDS, IN CHROMIUM, BOTH WAYS.
 *
 * A pack's own figures cannot be made wide enough to reach the refusal inside JavaScript's safe integers (a
 * R9e15 revenue prints in 13 digits and still fits), so this takes the composed demo pack and widens the figures
 * of one block after composition, then prints it through the real print stylesheet without the composer's gate:
 *
 *  - the widest figure the MODEL says fits at the floor prints with nothing past the right edge;
 *  - one digit wider, which the model says fits at no size, DOES run past it (so a refusal is never an over-refusal);
 *  - the widest figure the model says fits at the ordinary size prints at the ordinary size and fits; one digit
 *    wider is fitted to a smaller size, and printed at the ordinary size it would have overflowed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { kpiFit, tableFit } from '@/modules/accounting/services/packs/pages/packFigureFit';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { demoWithoutBudget, SCALE, withHeadingColumns, withWidenedKpi, withWidenedTable } from '../services/packs/fixtures/widenedFigures';
import { printBoardPack } from './renderPackPdf';
import { atTheFloor } from './support/atTheFloor';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

/** The page's room to spare at its right edge, to the subpixel (negative: past it); a row refused is set at the floor. */
const roomOf = async (doc: PackPagesDocument, index: number): Promise<number> => (await printBoardPack(atTheFloor(doc), browser)).spare.find((s) => s.id === `pack-page-${index + 1}`)!.px;
/**
 * A refusal is right where Chromium leaves less room than the model's own bound on its error: every width it sums is
 * never short and at most 1/32px over, so a row of a few runs may be refused with a fraction of a pixel to spare.
 */
const MODEL_BOUND_PX = 1 / 4;

describe('a statement table', () => {
  const fitsAt = (digits: number) => tableFit(withWidenedTable(demoWithoutBudget(), digits).table, SCALE);

  it('the model: the widest that fits at the ordinary size, the widest that fits at the floor, and the first that fits at none', () => {
    const ordinary = Array.from({ length: 30 }, (unused, i) => i + 4).filter((d) => fitsAt(d).fits && fitsAt(d).px === null).pop()!;
    const floor = Array.from({ length: 30 }, (unused, i) => i + 4).filter((d) => fitsAt(d).fits).pop()!;
    expect(floor).toBeGreaterThan(ordinary);
    expect(fitsAt(floor + 1).fits).toBe(false);
    expect(fitsAt(ordinary + 1).px).not.toBeNull();
  });

  it('prints clean at the widest figure the model fits at the floor, and runs past the edge one digit wider', async () => {
    const floor = Array.from({ length: 30 }, (unused, i) => i + 4).filter((d) => fitsAt(d).fits).pop()!;
    const fit = withWidenedTable(demoWithoutBudget(), floor);
    expect(await roomOf(fit.doc, fit.index), `${floor} digits`).toBeGreaterThanOrEqual(0);
    const over = withWidenedTable(demoWithoutBudget(), floor + 1);
    expect(await roomOf(over.doc, over.index), `${floor + 1} digits`).toBeLessThan(MODEL_BOUND_PX);
  }, 300_000);

  it('prints clean at the widest figure the model fits at the ordinary size; one digit wider is fitted, and would overflow unfitted', async () => {
    const ordinary = Array.from({ length: 30 }, (unused, i) => i + 4).filter((d) => fitsAt(d).fits && fitsAt(d).px === null).pop()!;
    const fit = withWidenedTable(demoWithoutBudget(), ordinary);
    expect(await roomOf(fit.doc, fit.index), `${ordinary} digits`).toBeGreaterThanOrEqual(0);
    const wider = withWidenedTable(demoWithoutBudget(), ordinary + 1);
    expect(tableFit(wider.table, SCALE).px, 'the model fits it to a smaller size').not.toBeNull();
    expect(await roomOf(wider.doc, wider.index), 'fitted, it prints clean').toBeGreaterThanOrEqual(0);
  }, 300_000);
});

describe('the size printed is the size the gate checked', () => {
  // The fit is stamped on the document at composition (`packFigureFitStamp`) and the page only renders it: the
  // figures print at exactly that size, so the row the floor gate passed is the row on the sheet.
  it('a widened table and KPI row print their figures at the stamped size', async () => {
    const range = Array.from({ length: 30 }, (unused, i) => i + 4);
    const tableFloor = range.filter((d) => tableFit(withWidenedTable(demoWithoutBudget(), d).table, SCALE).fits).pop()!;
    const table = withWidenedTable(demoWithoutBudget(), tableFloor);
    const kpiFloor = range.filter((d) => kpiFit(withWidenedKpi(demoWithoutBudget(), d).tiles, SCALE).fits).pop()!;
    const kpi = withWidenedKpi(demoWithoutBudget(), kpiFloor);
    const tableBlock = table.doc.pages[table.index]!.blocks.find((b) => b.kind === 'table');
    const kpiBlock = kpi.doc.pages[kpi.index]!.blocks.find((b) => b.kind === 'kpiTiles');
    if (tableBlock?.kind !== 'table' || kpiBlock?.kind !== 'kpiTiles') throw new Error('no blocks');
    expect(tableBlock.table.figureFit!.px).not.toBeNull();
    expect(kpiBlock.fit!.px).not.toBeNull();
    const tablePt = (await printBoardPack(table.doc, browser)).figurePt.find((f) => f.id === `pack-page-${table.index + 1}`)!.table;
    const kpiPt = (await printBoardPack(kpi.doc, browser)).figurePt.find((f) => f.id === `pack-page-${kpi.index + 1}`)!.kpi;
    // Against the GATE's own decision, computed afresh: not against the stamp, which is what is under test.
    expect(tablePt).toBeCloseTo(tableFit(tableBlock.table, SCALE).px! * 0.75, 3);
    expect(kpiPt).toBeCloseTo(kpiFit(kpiBlock.tiles, SCALE).px! * 0.75, 3);
  }, 300_000);
});

describe('a statement table with a long label word (the label column cannot be narrower than its longest word)', () => {
  it.each(['Telecommunications', 'Administrative', 'Depreciation'])('%s: the threshold is exact in Chromium both ways', async (label) => {
    const fitsAt = (digits: number) => tableFit(withWidenedTable(demoWithoutBudget(), digits, label).table, SCALE);
    const floor = Array.from({ length: 30 }, (unused, i) => i + 4).filter((d) => fitsAt(d).fits).pop()!;
    expect(fitsAt(floor + 1).fits).toBe(false);
    const fit = withWidenedTable(demoWithoutBudget(), floor, label);
    expect(await roomOf(fit.doc, fit.index), `${floor} digits`).toBeGreaterThanOrEqual(0);
    const over = withWidenedTable(demoWithoutBudget(), floor + 1, label);
    expect(await roomOf(over.doc, over.index), `${floor + 1} digits`).toBeLessThan(MODEL_BOUND_PX);
    // The label is what moves the threshold: an ordinary label holds at least as many digits.
    const ordinary = Array.from({ length: 30 }, (unused, i) => i + 4).filter((d) => tableFit(withWidenedTable(demoWithoutBudget(), d).table, SCALE).fits).pop()!;
    expect(floor).toBeLessThanOrEqual(ordinary);
  }, 300_000);
});

describe('a statement table whose long-labelled row carries a footnote marker and an n/m cell', () => {
  const marks = { labelMarker: true, notMeaningful: true };
  const range = Array.from({ length: 30 }, (unused, i) => i + 4);

  // The marker is a few pixels and a digit is dozens, so one label length per threshold would almost never
  // put the marker across it: sweep the label's length a character at a time and hold every threshold to Chromium.
  it('the threshold is exact in Chromium both ways, at every label length from 10 to 40 characters', async () => {
    const wrong: string[] = [];
    for (let n = 10; n <= 40; n += 1) {
      const label = 'n'.repeat(n);
      const fitsAt = (digits: number) => tableFit(withWidenedTable(demoWithoutBudget(), digits, label, marks).table, SCALE).fits;
      const floor = range.filter(fitsAt).pop();
      if (floor === undefined || floor === range[range.length - 1]) continue;
      const fit = withWidenedTable(demoWithoutBudget(), floor, label, marks);
      if (await roomOf(fit.doc, fit.index) < 0) wrong.push(`${n} chars: ${floor} digits overflow (kept a row that overflows)`);
      const over = withWidenedTable(demoWithoutBudget(), floor + 1, label, marks);
      if (await roomOf(over.doc, over.index) >= MODEL_BOUND_PX) wrong.push(`${n} chars: ${floor + 1} digits would fit (refused a table that fits)`);
    }
    expect(wrong).toEqual([]);
  }, 600_000);

  it('the marker costs room: the row with it never fits more digits than the same row without', () => {
    const widest = (m: object) => range.filter((d) => tableFit(withWidenedTable(demoWithoutBudget(), d, 'Telecommunications', m).table, SCALE).fits).pop()!;
    expect(widest(marks)).toBeLessThanOrEqual(widest({}));
  });
});

describe('a table whose HEADINGS set its widths (tiny figures, a footnote marker on every heading or on none)', () => {
  const ORDER = ['monthOperatingExpenses', 'variance', 'revenue', 'budget', 'otherIncome', 'netProfit', 'actual', 'prior', 'change', 'changePct', 'pctOfRevenue', 'otherExpenses', 'costOfSales'] as const;
  const boundary = (marked: boolean) => Array.from({ length: 13 }, (unused, i) => i + 1)
    .filter((n) => tableFit(withHeadingColumns(demoWithoutBudget(), ORDER.slice(0, n), marked).table, SCALE).fits).pop()!;

  it.each([[false], [true]])('markers=%s: the widest set of columns the model fits prints clean, one more column runs past the edge', async (marked) => {
    const n = boundary(marked);
    expect(n).toBeLessThan(13);
    const fit = withHeadingColumns(demoWithoutBudget(), ORDER.slice(0, n), marked);
    expect(await roomOf(fit.doc, fit.index), `${n} columns`).toBeGreaterThanOrEqual(0);
    const over = withHeadingColumns(demoWithoutBudget(), ORDER.slice(0, n + 1), marked);
    expect(await roomOf(over.doc, over.index), `${n + 1} columns`).toBeLessThan(MODEL_BOUND_PX);
  }, 300_000);

  it('a marker on every heading never buys room', () => {
    expect(boundary(true)).toBeLessThanOrEqual(boundary(false));
  });
});

describe('a KPI row', () => {
  const fitsAt = (digits: number) => kpiFit(withWidenedKpi(demoWithoutBudget(), digits).tiles, SCALE);
  const range = Array.from({ length: 30 }, (unused, i) => i + 4);

  it('prints clean at the widest the model fits at the floor, and runs past the edge one digit wider', async () => {
    const floor = range.filter((d) => fitsAt(d).fits).pop()!;
    const fit = withWidenedKpi(demoWithoutBudget(), floor);
    expect(await roomOf(fit.doc, fit.index), `${floor} digits`).toBeGreaterThanOrEqual(0);
    const over = withWidenedKpi(demoWithoutBudget(), floor + 1);
    expect(fitsAt(floor + 1).fits).toBe(false);
    expect(await roomOf(over.doc, over.index), `${floor + 1} digits`).toBeLessThan(MODEL_BOUND_PX);
  }, 300_000);

  it('prints clean at the widest the model fits at the ordinary size; one digit wider is fitted to a smaller size', async () => {
    const ordinary = range.filter((d) => fitsAt(d).fits && fitsAt(d).px === null).pop()!;
    const fit = withWidenedKpi(demoWithoutBudget(), ordinary);
    expect(await roomOf(fit.doc, fit.index), `${ordinary} digits`).toBeGreaterThanOrEqual(0);
    const wider = withWidenedKpi(demoWithoutBudget(), ordinary + 1);
    expect(kpiFit(wider.tiles, SCALE).px).not.toBeNull();
    expect(await roomOf(wider.doc, wider.index), 'fitted, it prints clean').toBeGreaterThanOrEqual(0);
  }, 300_000);
});

describe('a KPI row whose tile holds its column open with a word longer than its figure', () => {
  const label = 'Debtservicecoveragemultiple';
  const fitsAt = (digits: number) => kpiFit(withWidenedKpi(demoWithoutBudget(), digits, label).tiles, SCALE);
  const range = Array.from({ length: 30 }, (unused, i) => i + 4);

  it('the label sets the column: the row is fitted to a smaller size than with its ordinary labels', () => {
    const ordinary = kpiFit(withWidenedKpi(demoWithoutBudget(), 8).tiles, SCALE).px!;
    expect(fitsAt(8).px!).toBeLessThan(ordinary);
  });

  it.each([8, 9, 10])('%i digits: fitted to the size the label allows, it prints inside the sheet', async (digits) => {
    const labelled = withWidenedKpi(demoWithoutBudget(), digits, label);
    expect(fitsAt(digits).px).not.toBeNull();
    expect(await roomOf(labelled.doc, labelled.index)).toBeGreaterThanOrEqual(0);
  }, 300_000);

  it('prints clean at the widest the model fits, and runs past the edge one digit wider', async () => {
    const floor = range.filter((d) => fitsAt(d).fits).pop()!;
    const fit = withWidenedKpi(demoWithoutBudget(), floor, label);
    expect(await roomOf(fit.doc, fit.index), `${floor} digits`).toBeGreaterThanOrEqual(0);
    const over = withWidenedKpi(demoWithoutBudget(), floor + 1, label);
    expect(fitsAt(floor + 1).fits).toBe(false);
    expect(await roomOf(over.doc, over.index), `${floor + 1} digits`).toBeLessThan(MODEL_BOUND_PX);
  }, 300_000);
});

describe('a KPI row whose tile\'s not-meaningful reason, or delta line, holds its column open', () => {
  const range = Array.from({ length: 30 }, (unused, i) => i + 4);
  // The sweep is on the word's length, a character at a time: a reason is set in 11pt italic and a delta in 9pt after
  // its arrow, and each is charged as a bound, so only a sweep puts the model's charge across a digit's threshold.
  it.each([['reason', (n: number) => ({ reason: 'n'.repeat(n) })], ['delta basis', (n: number) => ({ basis: 'n'.repeat(n) })]] as const)(
    'the %s: the threshold is exact in Chromium both ways, at every word length from 12 to 40 characters',
    async (unused, words) => {
      const wrong: string[] = [];
      for (let n = 12; n <= 40; n += 1) {
        const fitsAt = (digits: number) => kpiFit(withWidenedKpi(demoWithoutBudget(), digits, words(n)).tiles, SCALE).fits;
        const floor = range.filter(fitsAt).pop();
        if (floor === undefined || floor === range[range.length - 1]) continue;
        const fit = withWidenedKpi(demoWithoutBudget(), floor, words(n));
        if (await roomOf(fit.doc, fit.index) < 0) wrong.push(`${n} chars: ${floor} digits overflow (kept a row that overflows)`);
        const over = withWidenedKpi(demoWithoutBudget(), floor + 1, words(n));
        if (await roomOf(over.doc, over.index) >= MODEL_BOUND_PX) wrong.push(`${n} chars: ${floor + 1} digits would fit (refused a row that fits)`);
      }
      expect(wrong).toEqual([]);
    }, 900_000);
});

