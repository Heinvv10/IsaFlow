/**
 * Budgets P3 PR-B review r1: the statement grid's Budget vs Actual cells.
 *
 * Under the opt-in `budgetTracking` grid prop (the BvA page only):
 * - a budget of ZERO prints 0.00 in Budget, FY budget and Projected (spec §2.1
 *   D5: budgeted at zero prints 0), while an ABSENT budget prints "—";
 * - Var % of a zero budget prints "—" (spec §2.1), never blank;
 * - the Var R cell expands the line's drill as the label does (spec §2.6).
 * Without it (IS, BS, packs) a zero keeps the statement zero dash and the
 * Var R cell is a plain figure.
 *
 * Every absent cell is "—": the partial-budget marker (½, its title,
 * `data-absent-reason`), and the projection cells of an unbudgeted line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import type { StatementColumns, StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';

afterEach(cleanup);

const COLS: StatementColumns = { prior: false, budget: true, variance: true, trend: false, projection: true };
const ROWS: StatementRow[] = [
  { id: 'acc:6000', kind: 'line', label: 'ZeroBudget', depth: 1, accountCode: '6000', actual: 0,
    budget: { value: 0, variance: 0, favourable: true }, projection: { projected: 0, fyBudget: 0, variance: 0, favourable: true } },
  { id: 'acc:6100', kind: 'line', label: 'NoBudget', depth: 1, accountCode: '6100', actual: 40,
    budget: { value: 0, absent: true }, projection: { projected: 40, absent: true } },
  { id: 'acc:6200', kind: 'line', label: 'ZeroBudgetWithSpend', depth: 1, accountCode: '6200', actual: 500,
    budget: { value: 0, variance: 500, favourable: false }, projection: { projected: 500, fyBudget: 0, variance: 500, favourable: false } },
  { id: 'acc:6300', kind: 'line', label: 'PartBudget', depth: 1, accountCode: '6300', actual: 70,
    budget: { value: 0, absent: true, absentReason: 'partial' }, projection: { projected: 70, absent: true } },
];

const html = (budgetTracking: boolean) => renderToStaticMarkup(React.createElement(StatementGrid, { rows: ROWS, columns: COLS, budgetTracking, cents: true }));
/** Cells after the label: Actual, Budget, Δ, bar, Δ%, Projected, FY budget, Proj. var R. */
function cellsOf(markup: string, label: string): string[] {
  const at = markup.indexOf(`>${label}<`);
  const tr = markup.slice(at, markup.indexOf('</tr>', at));
  return [...tr.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]!.replace(/<sup[^>]*>.*?<\/sup>|<span class="sr-only">.*?<\/span>/g, '').replace(/<[^>]+>/g, ''));
}

describe('zero budget vs absent budget (budgetTracking)', () => {
  it('a zero budget prints 0.00 in Budget, FY budget and Projected; an absent one prints —', () => {
    const m = html(true);
    const zero = cellsOf(m, 'ZeroBudget');
    expect([zero[1], zero[5], zero[6]]).toEqual(['0.00', '0.00', '0.00']);
    const none = cellsOf(m, 'NoBudget');
    expect([none[1], none[2], none[4]]).toEqual(['—', '—', '—']);
  });

  it('Var % of a zero budget prints —', () => {
    expect(cellsOf(html(true), 'ZeroBudgetWithSpend')[4]).toBe('—');
  });

  it('without the opt-in a zero keeps the statement zero dash and Var % stays blank', () => {
    const m = html(false);
    expect(cellsOf(m, 'ZeroBudget')[1]).toBe('–');
    expect(cellsOf(m, 'ZeroBudgetWithSpend')[4]).toBe('');
  });
});

describe('absent cells', () => {
  it('a partial budget is "—" with the ½ marker, its title and data-absent-reason', () => {
    const m = html(true);
    const at = m.indexOf('>PartBudget<');
    const tr = m.slice(at, m.indexOf('</tr>', at));
    expect(tr).toContain('data-absent-reason="partial"');
    expect(tr).toContain('title="Budget covers only part of this window"');
    expect(tr).toMatch(/—<sup[^>]*>½<\/sup>/);
    expect(cellsOf(m, 'PartBudget')[1]).toBe('—');
  });

  it("an unbudgeted line's FY budget and Proj. var R are —, its Projected a figure", () => {
    const none = cellsOf(html(true), 'NoBudget');
    expect([none[5], none[6], none[7]]).toEqual(['40.00', '—', '—']);
  });

  it('the last projection header is "Proj. var R"', () => {
    expect(html(true)).toContain('>Proj. var R</th>');
  });
});

describe('the Var R cell expands the drill (budgetTracking only)', () => {
  it('with the opt-in, clicking Var R toggles the line', () => {
    const onToggle = vi.fn();
    render(React.createElement(StatementGrid, { rows: ROWS, columns: COLS, budgetTracking: true, onToggleAccount: onToggle }));
    fireEvent.click(screen.getByRole('button', { name: 'Show the transactions behind the 6200 variance' }));
    expect(onToggle).toHaveBeenCalledWith('6200');
    // An absent budget has no variance to open.
    expect(screen.queryByRole('button', { name: /6100 variance/ })).toBeNull();
  });

  it('without it the Var R cell is a plain figure', () => {
    render(React.createElement(StatementGrid, { rows: ROWS, columns: COLS, onToggleAccount: vi.fn() }));
    expect(screen.queryByRole('button', { name: /variance/ })).toBeNull();
  });
});
