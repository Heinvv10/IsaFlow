/**
 * EVERY STATEMENT TABLE ROW LABEL IS THE PACK'S OWN WORDING (#1235 round 10, blind L3). A row label printed to break
 * anywhere (`packAnywhereLabel.ts`) only ever reaches a table through tenant text, and the claim that none does today
 * rests on this: every row label of every statement table the composer builds is one of the fixed statement labels
 * (`packStatementTables.ts`, `CASH_UNCAPTURED_LABEL`), a trend month's label with "(part)" after a stub
 * (`packPartialMonth.monthLabel`), or the window's total ("12 months to Sep 2026", `packMonthlyMeasures.trendWindowLabel`)
 * built from them. A trend month's label is the server's: `packTrendService.monthSlots` names it ("Jan 2026", held
 * here) and the trend point carries the slot's label (`packTrendService.ts:273`). Checked structurally, not by tagging
 * inputs: a label from any new source fails it, whatever it is made of. Over the demo pack (with and without a budget,
 * with a cash movement the journals do not explain, over one month), Velocity's (a partial last month) and a sample of
 * the grid's shapes; and every source is taken, not just allowed: each fixed label, the unexplained-cash row, a partial
 * month, a window ending at one and a one-month window print on one of the packs (#1235 round 11, blind L1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  'Investing cash flow', 'Financing cash flow', 'Unexplained movement', 'Closing cash',
]);
const MONTH = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \\d{4}( \\(part\\))?';
const MONTH_ROW = new RegExp(`^${MONTH}$`);
const WINDOW_ROW = new RegExp(`^(1 month|\\d+ months) to ${MONTH}$`);

/**
 * The trend months' labels as the composer may print them: each; the last with "(part)" after it (only the last month
 * of a window can be a stub, `packPartialMonth`); and the window over them, with "(part)" after it too.
 */
function trendWording(given: BoardPackInput): Set<string> {
  const months = given.trend.map((point) => point.label);
  const last = months[months.length - 1];
  if (last === undefined) return new Set();
  const window = `${months.length === 1 ? '1 month' : `${months.length} months`} to ${last}`;
  return new Set([...months, `${last} (part)`, window, `${window} (part)`]);
}

/** Every statement table row label of the pack `given` composes, or null where it is refused. */
function rowLabels(given: BoardPackInput): string[] | null {
  try {
    return buildBoardPackPages(given).pages.flatMap((p) => p.blocks).flatMap((b) => (b.kind === 'table' ? b.table.rows.map((r) => r.label) : []));
  } catch (err) {
    if (err instanceof PackRefusal) return null;
    throw err;
  }
}

/** The labels of `labels` (the pack `given` composed) that are not the pack's own wording. */
function foreign(given: BoardPackInput, labels: readonly string[]): string[] {
  const trend = trendWording(given);
  return labels.filter((label) => !FIXED.has(label) && !trend.has(label));
}

/**
 * The demo's cash movement with a part the journals do not explain (the ledger fault the cash table prints as its own
 * row, `packStatementTables.buildCashTable`): taken out of operating cash, so the cash still reaches its close.
 */
const withUnexplainedCash = (given: BoardPackInput, amount: number): BoardPackInput => ({
  ...given,
  set: { ...given.set, current: { ...given.set.current, operatingCashFlow: (given.set.current.operatingCashFlow ?? 0) - amount, cashFlowUnexplained: amount } },
});

const PACKS: ReadonlyArray<readonly [string, BoardPackInput]> = [
  ['demo', demoInput],
  ['demo without a budget', { ...demoInput, set: { ...demoInput.set, budget: null } }],
  ['demo with an unexplained cash movement', withUnexplainedCash(demoInput, 25_000)],
  ['demo over one month', { ...demoInput, trend: demoInput.trend.slice(-1) }],
  ['velocity', velocityInput],
];

describe('statement table row labels', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined); });
  afterEach(() => { warn.mockRestore(); });

  it('the unexplained-cash row\'s label is the pack\'s wording, not a value it is given', () => {
    expect(CASH_UNCAPTURED_LABEL).toBe('Unexplained movement');
  });

  it('a trend month is named by the server as "Mon YYYY", and the window over it as "N months to Mon YYYY"', () => {
    for (const [to, n] of [['2026-09-30', 12], ['2026-01-15', 12], ['2025-12-31', 1], ['2026-03-31', 7]] as const) {
      const slots = monthSlots(to, n);
      expect(slots.length).toBe(n);
      for (const slot of slots) expect(slot.label).toMatch(MONTH_ROW);
      expect(`${n === 1 ? '1 month' : `${n} months`} to ${slots[slots.length - 1]!.label}`).toMatch(WINDOW_ROW);
    }
  });

  it('are the pack\'s own wording on the demo pack (with and without a budget, with an unexplained cash movement, over one month) and Velocity\'s (a partial month); every source is taken', () => {
    const seen = new Set<string>();
    for (const [name, given] of PACKS) {
      const labels = rowLabels(given);
      expect(labels, `${name} is refused`).not.toBeNull();
      expect(labels!.length, name).toBeGreaterThan(20);
      expect(foreign(given, labels!), name).toEqual([]);
      for (const label of labels!) seen.add(label);
    }
    // Held, not just allowed: every fixed label prints on one of them, the unexplained row among them, and a partial
    // month, a window ending at one and a one-month window.
    expect([...FIXED].filter((label) => !seen.has(label))).toEqual([]);
    expect([...seen].some((label) => / \(part\)$/.test(label) && MONTH_ROW.test(label) && !WINDOW_ROW.test(label))).toBe(true);
    expect([...seen].some((label) => WINDOW_ROW.test(label) && label.endsWith('(part)'))).toBe(true);
    expect([...seen].some((label) => label.startsWith('1 month to '))).toBe(true);
  });

  it('are the pack\'s own wording over a sample of the grid\'s shapes', () => {
    const shapes = allShapes().filter((unused, i) => i % 97 === 0);
    expect(shapes.length).toBeGreaterThan(100);
    let built = 0;
    const wrong: string[] = [];
    for (const shape of shapes) {
      const given = input(shape);
      const labels = rowLabels(given);
      if (labels === null) continue;
      built += 1;
      for (const label of foreign(given, labels)) wrong.push(`${key(shape)}: ${JSON.stringify(label)}`);
    }
    expect(built).toBeGreaterThan(80);
    expect(wrong.slice(0, 10)).toEqual([]);
  }, 300_000);
});
