/**
 * Financial years on the budgets page (budgets P2 PR-D). Replaces the year cases of
 * budgetsPageRace.test.tsx and budgetsPageMonths.test.tsx, which drove the old page: the first load
 * asks for the year holding today (no fiscal_year), an earlier choice answering first or failing
 * last never shows on (or ends the loading of) the latest one, and a 14-month transition year has
 * 14 month columns, its range in the year select, and an FY total spread and saved over exactly
 * those 14 months. The slow-answer-arriving-last case is BudgetWorkspaceStates' "financial-year
 * switch". Real hooks, store and grid; fetch mocked at the edge.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetWorkspace } from '@/components/accounting/budgets/workspace/BudgetWorkspace';
import { buildLayout } from '@/components/accounting/budgets/workspace/gridLayout';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { installNetwork, isModel, isSave, modelFor, ok } from './workspaceHarness';
import { ID, gridModel } from './gridFixture';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() }, push: vi.fn() }) }));

let net: ReturnType<typeof installNetwork>;
beforeEach(() => { net = installNetwork(); });
// Unmount first, then leave a fetch that refuses: a late effect must never reach a real server.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const yearSelect = () => screen.getByTestId('workspace-year') as HTMLSelectElement;
const modelUrl = (fy: number) => (u: string) => isModel(u) && u.endsWith(`fiscal_year=${fy}`);

/**
 * Loaded on FY2027; the user picks 2026 and then 2028, and each answer waits for its release.
 * `answer(fy)` returns once the workspace has READ that response's body (the fetcher's `text()`)
 * and the effects that follow have run: a late answer is then fully processed, not merely sent.
 */
async function switchTwice(answers: { y2026: () => Response; y2028: () => Response }) {
  render(<BudgetWorkspace />);
  await screen.findByRole('grid', { name: 'Budget' });
  const release: Record<string, () => void> = {};
  const consumed: Record<string, Promise<void>> = {};
  const held = (fy: string, answer: () => Response) => {
    const gate = new Promise<void>((r) => { release[fy] = r; });
    let read!: () => void;
    consumed[fy] = new Promise<void>((r) => { read = r; });
    return async () => {
      await gate;
      const res = answer();
      const text = res.text.bind(res);
      return Object.assign(res, { text: async () => { try { return await text(); } finally { read(); } } });
    };
  };
  net.on(modelUrl(2026), held('2026', answers.y2026));
  net.on(modelUrl(2028), held('2028', answers.y2028));
  fireEvent.change(yearSelect(), { target: { value: '2026' } });
  fireEvent.change(yearSelect(), { target: { value: '2028' } });
  await waitFor(() => expect(net.sent.filter((s) => modelUrl(2026)(s.url) || modelUrl(2028)(s.url))).toHaveLength(2));
  return {
    answer: (fy: '2026' | '2028') => act(async () => {
      release[fy]!();
      await consumed[fy];
      await new Promise((r) => setTimeout(r, 0)); // the fetcher's parse and the hook's state updates
    }),
  };
}

describe('year switching', () => {
  it('the first load asks for the year list only (years_only, no fiscal_year), then the budget for the year it names', async () => {
    render(<BudgetWorkspace />);
    await screen.findByRole('grid', { name: 'Budget' });
    const years = net.sent.filter((s) => s.url.startsWith('/api/accounting/budgets') && !s.url.startsWith('/api/accounting/budgets-'));
    expect(years.map((s) => s.url)).toEqual(['/api/accounting/budgets?years_only=1']);
    expect(net.sent.filter((s) => isModel(s.url)).map((s) => s.url)).toEqual(['/api/accounting/budget-grid?fiscal_year=2027']);
    expect(yearSelect().value).toBe('2027');
  });

  it('an earlier choice answering first neither shows nor ends the loading of the latest one', async () => {
    const { answer } = await switchTwice({
      y2026: () => ok(modelFor(2026)),
      y2028: () => ok(modelFor(2028, { version: null, updatedAt: null, cells: [] })),
    });
    await answer('2026');
    expect(screen.getByTestId('workspace-loading')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('grid')).toBeNull();
    await answer('2028');
    expect(await screen.findByText('No budget for FY2028 yet')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-loading')).toBeNull();
    expect(yearSelect().value).toBe('2028');
  });

  it('an earlier choice that fails, arriving last, shows no error and keeps the latest year', async () => {
    const { answer } = await switchTwice({
      y2026: () => new Response('', { status: 500 }),
      y2028: () => ok(modelFor(2028, { version: null, updatedAt: null, cells: [] })),
    });
    await answer('2028');
    expect(await screen.findByText('No budget for FY2028 yet')).toBeInTheDocument();
    // Returns once the late 500 has been read and handled: only then may "no error" be asserted.
    await answer('2026');
    expect(screen.queryByTestId('workspace-error')).toBeNull();
    expect(screen.queryByText(/Could not load/)).toBeNull();
    expect(screen.getByText('No budget for FY2028 yet')).toBeInTheDocument();
  });
});

describe('a 14-month transition year', () => {
  const KEYS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07',
    '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];
  const TRANSITION = { fiscalYear: 2026, startDate: '2026-01-01', endDate: '2027-02-28', kind: 'transition', monthKeys: KEYS };
  const NEXT = { fiscalYear: 2028, startDate: '2027-03-01', endDate: '2028-02-29', kind: 'normal',
    monthKeys: ['2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10', '2027-11', '2027-12', '2028-01', '2028-02'] };

  function transitionModel(): GridReadModel {
    const m = gridModel();
    const zero = KEYS.map(() => 0);
    const accounts = m.accounts.filter((a) => a.id === ID.rev1 || a.id === ID.rev2 || a.id === ID.opex);
    return {
      ...m, accounts, cells: [], grains: {},
      version: { ...m.version!, fiscalYear: 2026, amountCount: 0 },
      year: { fiscalYear: 2026, startDate: TRANSITION.startDate, endDate: TRANSITION.endDate, kind: 'transition', monthKeys: KEYS },
      totals: { ...m.totals, months: Object.fromEntries(Object.keys(m.totals.months).map((k) => [k, zero])) as GridReadModel['totals']['months'] },
    };
  }

  it('the select names the range, the grid has 14 month columns, and an FY total is spread and saved over exactly those months', async () => {
    net.on((u) => u === '/api/accounting/budgets?years_only=1', () => ok({ items: [], fiscalYear: 2026, year: TRANSITION, years: [TRANSITION, NEXT] }));
    net.on((u) => u.startsWith('/api/accounting/budget-versions?fiscalYear='), () => ok({ items: [transitionModel().version] }));
    net.on((u) => u.includes('/prior-actuals'), () => ok({ fiscalYear: 2026, grain: 'company', months: KEYS, priorMonths: KEYS, cells: [] }));
    net.on(isModel, () => ok(transitionModel()));
    render(<BudgetWorkspace />);
    await screen.findByRole('grid', { name: 'Budget' });

    expect(yearSelect().value).toBe('2026');
    expect(Array.from(yearSelect().options).map((o) => o.text)).toEqual([
      '2026: Jan 2026 - Feb 2027 (14 months)', '2028: Mar 2027 - Feb 2028 (12 months)']);
    const monthHeads = screen.getAllByRole('columnheader').filter((h) => /^[A-Z][a-z]+ \d{4}$/.test(h.getAttribute('aria-label') ?? ''));
    expect(monthHeads.map((h) => h.getAttribute('aria-label'))).toEqual([
      'January 2026', 'February 2026', 'March 2026', 'April 2026', 'May 2026', 'June 2026', 'July 2026',
      'August 2026', 'September 2026', 'October 2026', 'November 2026', 'December 2026', 'January 2027', 'February 2027']);

    const row = buildLayout(transitionModel().accounts, KEYS).rows.find((r) => r.key === `acct:${ID.rev2}`)!.index;
    fireEvent.doubleClick(document.querySelector<HTMLElement>(`[data-pos="${row}:${KEYS.length}"]`)!);
    const editor = screen.getByRole('textbox', { name: '1010 Account 1010 full year budget' });
    fireEvent.change(editor, { target: { value: '14000' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(await screen.findByTestId('save-bar-count')).toHaveTextContent('14 unsaved changes');

    net.on(isSave, () => ok({ updatedAt: '2026-10-26T18:06:00.000001Z', saved: 14, deleted: 0 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByTestId('save-bar-count')).toBeNull());
    const [save] = net.sent.filter((s) => isSave(s.url)).map((s) => s.body as { cells: Array<{ glAccountId: string; month: string; amount: number }> });
    expect(save!.cells.map((c) => [c.glAccountId, c.month, c.amount])).toEqual(KEYS.map((k) => [ID.rev2, k, 1000]));
  });
});
