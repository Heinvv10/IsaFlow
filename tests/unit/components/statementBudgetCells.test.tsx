/**
 * Budgets P3 PR-C review r1 (R6, browser F1): a statement page's Budget column prints as Budget
 * vs Actual does under the grid's `budgetCells` prop (the income statement): a budgeted ZERO is
 * 0.00, an absent budget "—", Var % of a zero budget "—" with no colour. The Prior column keeps
 * the statement zero dash, and no Var R cell becomes a drill button (that is BvA's alone).
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import type { StatementColumns, StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';

const COLS: StatementColumns = { prior: true, budget: true, variance: true, trend: false };
const ROWS: StatementRow[] = [
  { id: 'acc:6000', kind: 'line', label: 'ZeroBudgetWithSpend', depth: 1, accountCode: '6000', actual: 500,
    prior: { value: 0, variance: 500, favourable: false }, budget: { value: 0, variance: 500, favourable: false } },
  { id: 'acc:6100', kind: 'line', label: 'NoBudget', depth: 1, accountCode: '6100', actual: 40,
    prior: { value: 40, variance: 0, variancePct: 0, favourable: true }, budget: { value: 0, absent: true } },
  { id: 'acc:6300', kind: 'line', label: 'PartBudget', depth: 1, accountCode: '6300', actual: 70,
    prior: { value: 70, variance: 0, variancePct: 0, favourable: true }, budget: { value: 0, absent: true, absentReason: 'partial' } },
];

const html = (budgetCells: boolean) => renderToStaticMarkup(React.createElement(StatementGrid, {
  rows: ROWS, columns: COLS, budgetCells, cents: true, onToggleAccount: () => undefined,
}));
/** Cells after the label: Actual, Prior, ΔP, bar, ΔP%, Budget, ΔB, bar, ΔB%. */
function cellsOf(markup: string, label: string): string[] {
  const at = markup.indexOf(`>${label}<`);
  const tr = markup.slice(at, markup.indexOf('</tr>', at));
  return [...tr.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]!.replace(/<sup[^>]*>.*?<\/sup>|<span class="sr-only">.*?<\/span>/g, '').replace(/<[^>]+>/g, ''));
}
const pctCellStyle = (markup: string, label: string) => {
  const tr = markup.slice(markup.indexOf(`>${label}<`), markup.indexOf('</tr>', markup.indexOf(`>${label}<`)));
  return [...tr.matchAll(/<td([^>]*)>/g)].map((m) => m[1]!)[8]!;
};

describe('the Budget column under budgetCells', () => {
  it('a budgeted zero prints 0.00; Var % of it "—" with no colour; the Prior zero keeps the statement dash', () => {
    const m = html(true);
    const c = cellsOf(m, 'ZeroBudgetWithSpend');
    expect(c[5]).toBe('0.00');
    expect(c[8]).toBe('—');
    expect(pctCellStyle(m, 'ZeroBudgetWithSpend')).not.toMatch(/color:/);
    expect(c[1]).not.toBe('0.00');
    // Review r2 (verify L2): the zero rules are the BUDGET column's. The Prior column's Var % of a zero
    // prior stays blank as on every statement; "—" there would be the Budget rule leaking sideways.
    expect(c[4]).toBe('');
  });

  it('an absent budget prints "—" in every Budget cell; a partial one carries its marker', () => {
    const m = html(true);
    expect([cellsOf(m, 'NoBudget')[5], cellsOf(m, 'NoBudget')[6], cellsOf(m, 'NoBudget')[8]]).toEqual(['—', '—', '—']);
    expect(m).toContain('data-absent-reason="partial"');
  });

  it('no Var R cell becomes a drill button (Budget vs Actual only)', () => {
    expect(html(true)).not.toMatch(/Show the transactions behind/);
  });

  it('without the prop a budgeted zero keeps the statement zero dash', () => {
    expect(cellsOf(html(false), 'ZeroBudgetWithSpend')[5]).not.toBe('0.00');
  });
});
