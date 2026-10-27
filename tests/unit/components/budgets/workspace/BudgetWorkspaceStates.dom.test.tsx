/**
 * BudgetWorkspace states (spec §6.4, §14): loading (skeleton, bar disabled), load failed (message
 * + Retry, the year select still usable), no version (wizard sources), no accounts (chart link),
 * locked (read-only grid, no save bar). Plus the stale-response test on a financial-year switch
 * that replaces budgetsPageRace.test.tsx (spec §14, PR-D): a slow answer for a year the user
 * left never replaces the one on screen. Real hooks, store and grid; fetch mocked at the edge.
 *
 * Mutation (§14): a failed load rendered as the empty state turns "load failed" red.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetWorkspace } from '@/components/accounting/budgets/workspace/BudgetWorkspace';
import { fail, installNetwork, isModel, modelFor, ok } from './workspaceHarness';
import { gridModel } from './gridFixture';

const company = vi.hoisted(() => ({ role: 'owner' as string | null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: company.role }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() }, push: vi.fn() }) }));

let net: ReturnType<typeof installNetwork>;
beforeEach(() => { company.role = 'owner'; net = installNetwork(); });
// Unmount first, then leave a fetch that refuses: a late effect must never reach a real server.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const yearSelect = () => screen.getByTestId('workspace-year') as HTMLSelectElement;

describe('BudgetWorkspace states', () => {
  it('loading: skeleton while the model is in flight, versions bar disabled; then the grid', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    net.on(isModel, async () => { await held; return ok(gridModel()); });
    render(<BudgetWorkspace />);
    expect(await screen.findByTestId('workspace-loading')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('grid')).toBeNull();
    await act(async () => { release(); await held; });
    expect(await screen.findByRole('grid', { name: 'Budget' })).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-loading')).toBeNull();
    expect(screen.getByTestId('version-select')).not.toBeDisabled();
  });

  it('load failed: the message and Retry, not the empty state; the year select stays usable; Retry loads', async () => {
    net.on(isModel, () => fail(500, 'Database unavailable'));
    render(<BudgetWorkspace />);
    const panel = await screen.findByTestId('workspace-error');
    expect(panel).toHaveTextContent('Database unavailable');
    expect(screen.queryByTestId('workspace-empty')).toBeNull();
    expect(screen.queryByText(/No budget for FY/)).toBeNull();
    expect(yearSelect()).not.toBeDisabled();
    net.on(isModel, () => ok(gridModel()));
    fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('grid', { name: 'Budget' })).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-error')).toBeNull();
  });

  it('no version: "No budget for FY2027 yet" with the four wizard sources; no grid, no error', async () => {
    net.on(isModel, () => ok({ ...gridModel(), version: null, updatedAt: null, cells: [] }));
    render(<BudgetWorkspace />);
    const empty = await screen.findByTestId('workspace-empty');
    expect(empty).toHaveTextContent('No budget for FY2027 yet');
    expect(within(empty).getAllByRole('button').map((b) => b.getAttribute('data-testid'))).toEqual([
      'empty-start-py_actuals', 'empty-start-version', 'empty-start-blank', 'empty-start-import']);
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByTestId('workspace-error')).toBeNull();
  });

  it('no version and a viewer: no create buttons, says who can', async () => {
    company.role = 'viewer';
    net.on(isModel, () => ok({ ...gridModel(), version: null, updatedAt: null, cells: [] }));
    render(<BudgetWorkspace />);
    const empty = await screen.findByTestId('workspace-empty');
    expect(within(empty).queryAllByRole('button')).toHaveLength(0);
    expect(empty).toHaveTextContent('An owner, admin or manager can create one.');
  });

  it('no revenue or expense accounts: a link to the chart of accounts', async () => {
    net.on(isModel, () => ok({ ...gridModel(), version: null, updatedAt: null, cells: [], accounts: [] }));
    render(<BudgetWorkspace />);
    const empty = await screen.findByTestId('workspace-empty-accounts');
    expect(within(empty).getByRole('link', { name: 'Open the chart of accounts' })).toHaveAttribute('href', '/accounting/chart-of-accounts');
  });

  it('locked: lock chip, read-only grid, no save bar, no import', async () => {
    const m = gridModel();
    net.on(isModel, () => ok({ ...m, version: { ...m.version!, status: 'locked', lockedAt: '2026-10-20T08:00:00.000000Z' } }));
    render(<BudgetWorkspace />);
    const grid = await screen.findByRole('grid', { name: 'Budget' });
    expect(grid).toHaveAttribute('aria-readonly', 'true');
    expect(screen.getByTestId('version-status-chip')).toHaveTextContent('Locked on 20 October 2026');
    expect(screen.queryByTestId('save-bar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Template' })).toBeInTheDocument();
  });
});

describe('financial-year switch (replaces budgetsPageRace)', () => {
  it('a slow answer for a year the user left, arriving last, never replaces the year on screen', async () => {
    render(<BudgetWorkspace />);
    await screen.findByRole('grid', { name: 'Budget' });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    net.on((u) => isModel(u) && u.endsWith('fiscal_year=2026'), async () => { await held; return ok(modelFor(2026)); });
    net.on((u) => isModel(u) && u.endsWith('fiscal_year=2028'), () => ok(modelFor(2028, { version: null, updatedAt: null, cells: [] })));
    fireEvent.change(yearSelect(), { target: { value: '2026' } });
    fireEvent.change(yearSelect(), { target: { value: '2028' } });
    expect(await screen.findByText('No budget for FY2028 yet')).toBeInTheDocument();
    await act(async () => { release(); await held; });
    await waitFor(() => expect(net.sent.some((s) => s.url.endsWith('fiscal_year=2026'))).toBe(true));
    expect(screen.getByText('No budget for FY2028 yet')).toBeInTheDocument();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(yearSelect().value).toBe('2028');
  });
});
