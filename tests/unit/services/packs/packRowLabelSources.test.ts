/**
 * EVERY STATEMENT TABLE ROW LABEL IS THE PACK'S OWN WORDING (#1235 round 10, blind L3). A row label printed to break
 * anywhere (`packAnywhereLabel.ts`) only ever reaches a table through tenant text, and the claim that none does today
 * rests on this: every row label of every statement table the composer builds is one of the fixed statement labels
 * (`packStatementTables.ts`, `CASH_UNCAPTURED_LABEL`), a trend month's label with "(part)" after a stub
 * (`packPartialMonth.monthLabel`), or the window's total ("12 months to Sep 2026", `packMonthlyMeasures.trendWindowLabel`)
 * built from them. A trend month's label is the server's: `packTrendService.monthSlots` names it ("Jan 2026", held
 * here) and the trend point carries the slot's label (`packTrendService.ts:273`). Checked structurally, not by tagging
 * inputs: a label from any new source fails it, whatever it is made of. Over the demo pack, with and without a budget, Velocity's (a partial last month,
 * its own budget), and a sample of the grid's shapes (budget, prior, sign, scale, trend shapes).
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { CASH_UNCAPTURED_LABEL } from '@/modules/accounting/services/packs/packSectionData';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { demoInput } from './fixtures/boardPackInputs';
import { monthSlots } from '@/modules/accounting/services/packs/packTrendService';
import { allShapes, input, key } from './fixtures/packGridInputs';
import { velocityInput } from './fixtures/velocityBoardPack';

const FIXED = new Set([
  'Revenue', 'Cost of sales', 'Gross profit', 'Operating expenses', 'Other income', 'Operating profit', 'Other expenses',
  'Net profit', 'Current assets', 'Non-current assets', 'Total assets', 'Total equity', 'Current liabilities',
  'Non-current liabilities', 'Total liabilities', 'Total equity and liabilities', 'Opening cash', 'Operating cash flow',
  'Investing cash flow', 'Financing cash flow', CASH_UNCAPTURED_LABEL, 'Closing cash',
]);
const MONTH = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \\d{4}( \\(part\\))?';
const MONTH_ROW = new RegExp(`^${MONTH}$`);
const WINDOW_ROW = new RegExp(`^(1 month|\\d+ months) to ${MONTH}$`);

/** The trend months' labels as the composer may print them: each, with "(part)" after it, and the window over them. */
function trendWording(given: BoardPackInput): Set<string> {
  const months = given.trend.map((point) => point.label);
  const last = months[months.length - 1];
  const windows = last === undefined ? [] : [`${months.length === 1 ? '1 month' : `${months.length} months`} to ${last}`];
  return new Set([...months, ...months.map((m) => `${m} (part)`), ...windows, ...windows.map((w) => `${w} (part)`)]);
}

/** Every statement table row label of the pack `given` composes that is not the pack's own wording, or null where refused. */
function foreignLabels(given: BoardPackInput): string[] | null {
  const trend = trendWording(given);
  try {
    const labels = buildBoardPackPages(given).pages.flatMap((p) => p.blocks).flatMap((b) => (b.kind === 'table' ? b.table.rows.map((r) => r.label) : []));
    if (labels.length < 20) return [`only ${labels.length} row labels`];
    return labels.filter((label) => !FIXED.has(label) && !trend.has(label));
  } catch (err) {
    if (err instanceof PackRefusal) return null;
    throw err;
  }
}

describe('statement table row labels', () => {
  it('a trend month is named by the server as "Mon YYYY", and the window over it as "N months to Mon YYYY"', () => {
    for (const [to, n] of [['2026-09-30', 12], ['2026-01-15', 12], ['2025-12-31', 1], ['2026-03-31', 7]] as const) {
      const slots = monthSlots(to, n);
      expect(slots.length).toBe(n);
      for (const slot of slots) expect(slot.label).toMatch(MONTH_ROW);
      expect(`${n === 1 ? '1 month' : `${n} months`} to ${slots[slots.length - 1]!.label}`).toMatch(WINDOW_ROW);
    }
  });

  it('are the pack\'s own wording on the demo pack, with and without a budget, and on Velocity\'s (a partial month)', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const packs: Array<[string, BoardPackInput]> = [
      ['demo', demoInput], ['demo without a budget', { ...demoInput, set: { ...demoInput.set, budget: null } }], ['velocity', velocityInput],
    ];
    for (const [name, given] of packs) expect(foreignLabels(given), name).toEqual([]);
    // The partial month is printed as such, so the "(part)" branch is taken, not just allowed.
    expect(buildBoardPackPages(velocityInput).pages.flatMap((p) => p.blocks).some((b) => b.kind === 'table' && b.table.rows.some((r) => r.label.endsWith('(part)')))).toBe(true);
  });

  it('are the pack\'s own wording over a sample of the grid\'s shapes', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const shapes = allShapes().filter((unused, i) => i % 97 === 0);
    expect(shapes.length).toBeGreaterThan(100);
    let built = 0;
    const wrong: string[] = [];
    for (const shape of shapes) {
      const foreign = foreignLabels(input(shape));
      if (foreign === null) continue;
      built += 1;
      for (const label of foreign) wrong.push(`${key(shape)}: ${JSON.stringify(label)}`);
    }
    expect(built).toBeGreaterThan(80);
    expect(wrong.slice(0, 10)).toEqual([]);
  }, 300_000);
});
