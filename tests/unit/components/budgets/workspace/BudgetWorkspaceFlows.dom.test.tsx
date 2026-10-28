/**
 * BudgetWorkspace flows (round 1): no financial year at all is a panel, not an endless skeleton;
 * the "no amounts yet" hint follows the grid, not the load; the 409 dialog says when the budget
 * was changed; and a re-apply that fails says so (stale: the message; locked: the copy exists
 * but is not loaded). Real hooks, store and grid; fetch mocked at the edge.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetWorkspace } from '@/components/accounting/budgets/workspace/BudgetWorkspace';
import { buildLayout } from '@/components/accounting/budgets/workspace/gridLayout';
import { fail, installNetwork, isModel, isSave, ok } from './workspaceHarness';
import { ID, gridModel } from './gridFixture';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() }, push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const T2 = '2026-10-26T18:05:00.000001Z';
const rev2Row = buildLayout(gridModel().accounts, gridModel().year.monthKeys).rows.find((r) => r.key === `acct:${ID.rev2}`)!.index;
const marchRev2 = () => document.querySelector<HTMLElement>(`[data-pos="${rev2Row}:0"]`)!;

async function typeIntoMarchRev2(value: string) {
  fireEvent.doubleClick(marchRev2());
  const editor = screen.getByRole('textbox', { name: '1010 Account 1010 Mar 2026 budget' });
  fireEvent.change(editor, { target: { value } });
  fireEvent.keyDown(editor, { key: 'Enter' });
  await waitFor(() => expect(marchRev2()).toHaveAttribute('data-dirty', 'true'));
}

describe('BudgetWorkspace flows', () => {
  it('no financial year at all: a panel saying so, not a skeleton forever', async () => {
    const net = installNetwork();
    net.on((u) => u === '/api/accounting/budgets', () => ok({ items: [], fiscalYear: null, years: [] }));
    render(<BudgetWorkspace />);
    expect(await screen.findByTestId('workspace-no-year')).toHaveTextContent(/no financial year/i);
    expect(screen.queryByTestId('workspace-loading')).toBeNull();
  });

  it('"no amounts yet" shows on an empty version and goes once a cell holds an amount', async () => {
    const net = installNetwork();
    net.on(isModel, () => ok({ ...gridModel(), cells: [] }));
    render(<BudgetWorkspace />);
    expect(await screen.findByTestId('workspace-no-amounts')).toBeInTheDocument();
    await typeIntoMarchRev2('25');
    await waitFor(() => expect(screen.queryByTestId('workspace-no-amounts')).toBeNull());
  });

  it('a stale 409 says when the budget was changed; a failed re-apply shows its message and keeps my cell', async () => {
    const net = installNetwork();
    render(<BudgetWorkspace />);
    await screen.findByRole('grid', { name: 'Budget' });
    await typeIntoMarchRev2('25');
    net.on(isSave, () => fail(409, 'This budget version changed since you loaded it', { code: 'BUDGET_VERSION_STALE', currentUpdatedAt: T2, status: 'draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByTestId('stale-dialog');
    // 18:05 UTC is 20:05 in South Africa.
    expect(dialog).toHaveTextContent(/changed at .*26 Oct 2026.*20:05/);
    net.on(isModel, () => fail(500, 'Database unavailable'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload and re-apply mine' })); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable');
    expect(screen.getByTestId('stale-dialog')).toBeInTheDocument();
    expect(marchRev2()).toHaveAttribute('data-dirty', 'true');
  });

  it('locked: when the copy cannot be loaded, the dialog says the copy was created but not loaded', async () => {
    const net = installNetwork();
    render(<BudgetWorkspace />);
    await screen.findByRole('grid', { name: 'Budget' });
    await typeIntoMarchRev2('25');
    net.on(isSave, () => fail(409, 'This budget version is locked', { code: 'BUDGET_VERSION_LOCKED' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByTestId('stale-dialog');
    const copyId = 'b0000000-0000-4000-8000-0000000000c1';
    const copy = { ...gridModel().version!, id: copyId, name: 'Original (my changes)', kind: 'reforecast' as const, isPrimary: false };
    net.on((u, method) => method === 'POST' && u.endsWith('/copy'), () => ok(copy));
    net.on((u) => isModel(u) && u.includes(copyId), () => fail(503, 'The budget is busy; try again.'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy into a new draft version' })); });
    // p2c-shell's wording (round 2 M3): the copy exists, it was not opened, and the dialog offers a retry.
    expect(await screen.findByRole('alert')).toHaveTextContent(/The copy “Original \(my changes\)” was created, but it could not be opened: The budget is busy; try again\./);
    expect(marchRev2()).toHaveAttribute('data-dirty', 'true');
  });
});
