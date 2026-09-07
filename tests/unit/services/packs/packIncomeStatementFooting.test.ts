/**
 * SHEET 6 MUST FOOT AS LAID OUT, not merely be right.
 *
 * The Brightsphere pack printed "Other expenses 411" between Operating
 * expenses and the Operating profit subtotal — and the subtotal excludes it.
 * A director summing the visible rows down to Operating profit got (1 408)
 * where the row printed (1 819). Every figure was correct; the row was in the
 * wrong block, which is a worse failure than a wrong number because nothing
 * on the page admits to it.
 *
 * `aggregateFigures` is explicit that other expenses is NON-operating —
 * `operatingProfit = grossProfit + otherIncome − operatingExpenses`,
 * `netProfit = operatingProfit − otherExpenses` — so the layout is what had
 * to move.
 *
 * THE FIXTURES HID IT. `demoSet` and `brightsphereSet` both carry
 * `otherExpenses: 0`, so the misplaced row was invisible on every fixture in
 * the suite; the defect only appears on a company that has such a charge. The
 * figures below are the rendered Brightsphere pack's own.
 *
 * The check is POSITIONAL and generic: each subtotal must equal the running
 * total of the rows printed above it since the previous subtotal. It does not
 * know where other expenses belongs — it knows only that the reader adds what
 * they can see, in the order they see it.
 */
import { describe, expect, it } from 'vitest';
import { buildIncomeStatementTable } from '@/modules/accounting/services/packs/pages/packStatementTables';
import { buildDefinitions } from '@/modules/accounting/services/packs/pages/packDefinitions';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { figures, demoSet } from './fixtures/boardPackInputs';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackTable } from '@/modules/accounting/services/packs/pages/packPageModel';

/** Which of the printed rows a reader ADDS and which they SUBTRACT — the
 *  pack states costs positive and takes them off, so the sign is the row's
 *  class rather than the sign of its figure. */
const SUBTRACTED = new Set(['Cost of sales', 'Operating expenses', 'Other expenses']);

/**
 * The Brightsphere company as the pack rendered it: a net-debit turnover, an
 * operating expense band that is a net credit, and — the row this test exists
 * for — a real other-expenses charge.
 */
const withOtherExpenses: PackFigureSet = {
  ...demoSet,
  current: figures({
    companyName: 'Brightsphere (Pty) Ltd',
    revenue: -5_535_000,
    costOfSales: 0,
    operatingExpenses: -3_717_000,
    otherIncome: -1_000,
    otherExpenses: 411_000,
    operatingProfit: -1_819_000,
    netProfit: -1_408_000 - 822_000,
    depreciation: -152_000,
  }),
  prior: null,
};

/** Every subtotal, against the rows a reader can see above it. */
function footingErrors(table: PackTable): string[] {
  const errors: string[] = [];
  let running = 0;
  for (const row of table.rows) {
    const actual = row.figures.actual;
    if (actual === undefined || actual.value === null) continue;
    if (row.role === 'line') {
      running += (SUBTRACTED.has(row.label) ? -1 : 1) * actual.value;
      continue;
    }
    if (row.role === 'subtotal') {
      if (Math.abs(running - actual.value) > 0.5) {
        errors.push(`${row.label} prints ${actual.value} and the rows above it come to ${running}`);
      }
      // A subtotal restarts the chain: the pack draws it from the axis and
      // the rows beneath it are read against it, not against zero.
      running = actual.value;
    }
    // A total (net profit) is NOT checked here — interest and tax sit between
    // the operating line and the bottom line and no field carries them, which
    // is why the bridge on the same page draws a named plug. That gap is
    // disclosed; a subtotal that excludes a row printed above it is not.
  }
  return errors;
}

describe("the income statement's subtotals", () => {
  it('follow from the rows printed above them, on a company with other expenses', () => {
    const table = buildIncomeStatementTable(withOtherExpenses, new PackFigureProvenance());
    expect(footingErrors(table)).toEqual([]);
  });

  it('prints other expenses BELOW the operating line, where the computation puts it', () => {
    const table = buildIncomeStatementTable(withOtherExpenses, new PackFigureProvenance());
    const labels = table.rows.map((r) => r.label);
    expect(labels).toContain('Other expenses');
    expect(labels.indexOf('Other expenses')).toBeGreaterThan(labels.indexOf('Operating profit'));
    // And other INCOME stays above it, because the computation includes it.
    expect(labels.indexOf('Other income')).toBeLessThan(labels.indexOf('Operating profit'));
  });

  it('still foots on the demo company, whose other expenses are nil', () => {
    expect(footingErrors(buildIncomeStatementTable(demoSet, new PackFigureProvenance()))).toEqual([]);
  });
});

/**
 * AND THE NEGATIVE ADD-BACK ON THE SAME PAGE.
 *
 * Brightsphere's EBITDA bridge read "Add back: depreciation and amortisation
 * (152)", taking operating profit (1 819) to EBITDA (1 971), under a
 * definition promising "plus the depreciation and amortisation CHARGED in the
 * period". The arithmetic is right — `depreciation` is the signed period
 * movement on the classifier's depreciation band, and a net credit on those
 * accounts has already raised operating profit, so taking it back out is what
 * keeps EBITDA a measure before depreciation — but nothing on the page said
 * so, which leaves a director looking at an apparent sign error on a
 * non-IFRS measure.
 */
describe("the EBITDA bridge's add-back", () => {
  it('says what a negative charge is, rather than leaving it to be read as a sign error', () => {
    const definitions = buildDefinitions(withOtherExpenses, new PackFigureProvenance());
    const ebitda = definitions.find((d) => d.term === 'EBITDA');
    expect(ebitda).toBeDefined();
    expect(withOtherExpenses.current.depreciation, 'this fixture is the credit case').toBeLessThan(0);
    expect(ebitda!.definition).toMatch(/net credit/i);
    // And the bridge still reconciles as printed.
    const rows = ebitda!.reconciliation!;
    const value = (label: string): number => {
      const row = rows.find((r) => r.label.startsWith(label));
      expect(row, label).toBeDefined();
      return row!.figure.value!;
    };
    expect(value('Operating profit') + value('Add back')).toBeCloseTo(value('EBITDA'), 6);
  });

  it('leaves the ordinary wording alone where a charge was made', () => {
    const definitions = buildDefinitions(demoSet, new PackFigureProvenance());
    const ebitda = definitions.find((d) => d.term === 'EBITDA')!;
    expect(demoSet.current.depreciation).toBeGreaterThan(0);
    expect(ebitda.definition).not.toMatch(/net credit/i);
  });
});
