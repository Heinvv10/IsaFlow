/**
 * The 13-week cash forecast engine. Pure: inputs in, forecast out, no clock and no database.
 *
 *   1. known items (the readers') fold into lines by week — the past in week 1, past the horizon left out;
 *   2. the budget fill tops customer receipts and supplier payments up to budget, month by month;
 *   3. manual items, then overrides, last and in order.
 *
 * Invariants (asserted in tests/unit/services/cashForecast13): every amount is integer cents; per week
 * opening + Σ lines = closing, and the next week opens at this closing; a line's total is the sum of its
 * weeks; the output does not depend on the order the inputs arrived in (overrides apart, which apply in
 * the order given).
 */
import { applyOverrides, manualLines } from './adjustments';
import { budgetFillLines } from './budgetFill';
import { assertCents, foldItems, sortLines } from './lines';
import { buildWeeks } from './weeks';
import type { CashForecast13, EngineInput, ForecastWarning, ForecastWeek, ForecastLine } from './types';

function rollWeeks(openingCents: number, lines: readonly ForecastLine[], spans: ReturnType<typeof buildWeeks>): ForecastWeek[] {
  let opening = openingCents;
  return spans.map((s) => {
    let inflows = 0;
    let outflows = 0;
    for (const l of lines) {
      const v = l.weekly[s.index] as number;
      if (v >= 0) inflows += v;
      else outflows += v;
    }
    const net = inflows + outflows;
    const week: ForecastWeek = {
      index: s.index, start: s.start, end: s.end,
      openingCents: opening, inflowsCents: inflows, outflowsCents: outflows, netCents: net, closingCents: opening + net,
    };
    opening = week.closingCents;
    return week;
  });
}

export function runEngine(input: EngineInput): CashForecast13 {
  assertCents(input.openingCents, 'opening cash');
  const spans = buildWeeks(input.today);
  const warnings: ForecastWarning[] = [...input.warnings];

  const known = foldItems(input.items, 'known', input.today, spans);
  if (known.beyondHorizon > 0) {
    warnings.push({ code: 'beyond_horizon', source: 'engine', message: `${known.beyondHorizon} dated item(s) fall after week 13 and are not in this forecast` });
  }
  const budget = input.budget ? budgetFillLines(input.budget, input.items, input.today, spans) : [];
  const manual = manualLines(input.manualItems, input.today, spans);
  const before = [...known.lines, ...budget, ...manual];
  const overridden = applyOverrides(before, input.overrides);
  warnings.push(...overridden.warnings);

  const lines = sortLines([...before, ...overridden.lines]);
  return { today: input.today, weeks: rollWeeks(input.openingCents, lines, spans), lines, overdueAR: input.overdueAR, warnings };
}
