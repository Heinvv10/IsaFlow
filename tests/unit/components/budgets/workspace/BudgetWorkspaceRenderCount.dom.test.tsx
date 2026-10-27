/**
 * Spec §13 / §14 render-count gate on the REAL grid: BudgetWorkspace → BudgetGrid → BudgetGridRow /
 * BudgetSubtotalRow, real hooks and store, fetch mocked at the edge. Each real row component is
 * wrapped (same default `memo` comparison as the real one) in a React Profiler, so a render of the
 * real row, from its props or its store subscription, is counted under the row's key.
 *
 * Editing a fresh cell (dirtyCount 0 → 1: the save bar appears and the workspace re-renders) and
 * then a second cell must render only that line row, its band total and GP / OP / NP. Mutations
 * that must turn it red: a new row-handlers identity per grid render; the row-action handler
 * depending on a `members` array that is rebuilt per render.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetWorkspace } from '@/components/accounting/budgets/workspace/BudgetWorkspace';
import { buildLayout } from '@/components/accounting/budgets/workspace/gridLayout';
import { installNetwork } from './workspaceHarness';
import { ID, gridModel } from './gridFixture';

const renders = vi.hoisted(() => [] as string[]);

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() }, push: vi.fn() }) }));
vi.mock('@/components/accounting/budgets/workspace/BudgetGridRow', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/accounting/budgets/workspace/BudgetGridRow')>();
  const { Profiler, createElement, memo } = await import('react');
  type P = Parameters<typeof real.BudgetGridRow>[0];
  const Counted = memo((p: P) => createElement(Profiler, { id: p.row.key, onRender: (id: string) => { renders.push(id); } }, createElement(real.BudgetGridRow, p)));
  return { ...real, BudgetGridRow: Counted };
});
vi.mock('@/components/accounting/budgets/workspace/BudgetSubtotalRow', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/accounting/budgets/workspace/BudgetSubtotalRow')>();
  const { Profiler, createElement, memo } = await import('react');
  type P = Parameters<typeof real.BudgetSubtotalRow>[0];
  const Counted = memo((p: P) => createElement(Profiler, { id: p.row.key, onRender: (id: string) => { renders.push(id); } }, createElement(real.BudgetSubtotalRow, p)));
  return { ...real, BudgetSubtotalRow: Counted };
});

beforeEach(() => { renders.length = 0; });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const layout = buildLayout(gridModel().accounts, gridModel().year.monthKeys);
const rev2 = layout.rows.find((r) => r.key === `acct:${ID.rev2}`)!.index;
const cell = (c: number) => document.querySelector<HTMLElement>(`[data-pos="${rev2}:${c}"]`)!;
const EXPECTED = [`acct:${ID.rev2}`, 'profit:grossProfit', 'profit:netProfit', 'profit:operatingProfit', 'total:turnover'];

/** Double-click, type, Tab (commit; focus stays on the row). */
async function edit(c: number, value: string) {
  fireEvent.doubleClick(cell(c));
  const editor = document.querySelector<HTMLInputElement>(`[data-pos="${rev2}:${c}"] input`)!;
  fireEvent.change(editor, { target: { value } });
  await act(async () => { fireEvent.keyDown(editor, { key: 'Tab' }); });
}

describe('BudgetWorkspace render count (real grid)', () => {
  it('a fresh cell (0 → 1 unsaved) and then a second cell render only that row, its band total and GP / OP / NP', async () => {
    const net = installNetwork();
    render(<BudgetWorkspace />);
    await screen.findByRole('grid', { name: 'Budget' });
    await waitFor(() => expect(net.sent.some((s) => s.url.includes('/prior-actuals'))).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); // prior actuals land, versions list answers
    // Focus the row first: moving focus here from the first row legitimately renders both.
    act(() => { fireEvent.mouseDown(cell(0)); });
    renders.length = 0;

    await edit(0, '25');
    expect(await screen.findByTestId('save-bar-count')).toHaveTextContent('1 unsaved change');
    expect([...new Set(renders)].sort()).toEqual(EXPECTED);

    renders.length = 0;
    await edit(1, '30');
    expect(screen.getByTestId('save-bar-count')).toHaveTextContent('2 unsaved changes');
    expect([...new Set(renders)].sort()).toEqual(EXPECTED);
  });
});
