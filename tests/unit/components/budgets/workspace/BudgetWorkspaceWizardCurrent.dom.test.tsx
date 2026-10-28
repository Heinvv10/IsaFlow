/**
 * Round 2 M1: the create wizard's "Current" column is the WHOLE version's FY, not what the grid's
 * view shows. Opened from a CC1 member view (which shows turnover 0 and NP −R10 for member
 * Alpha), Current still reads the version: turnover R1 000, GP R600, NP R519.50.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetWorkspace } from '@/components/accounting/budgets/workspace/BudgetWorkspace';
import { formatStatementFigure } from '@/lib/format/money';
import { installNetwork, ok } from './workspaceHarness';
import { ID } from './gridFixture';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() }, push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const current = (metric: string) => within(document.querySelector<HTMLElement>(`tr[data-metric="${metric}"]`)!).getAllByRole('cell')[0]!.textContent;

describe('wizard "Current" from a dimension view', () => {
  it('shows the whole version, not the CC1 member the grid is showing', async () => {
    const net = installNetwork();
    net.on((u) => u.includes('cells_only'), () => ok({ versionId: ID.version, updatedAt: 'X', cells: [] }));
    render(<BudgetWorkspace />);
    await screen.findByRole('grid', { name: 'Budget' });
    fireEvent.change(screen.getByTestId('toolbar-view'), { target: { value: 'cc1' } });
    fireEvent.change(await screen.findByTestId('toolbar-member'), { target: { value: ID.m1 } });
    await waitFor(() => expect((screen.getByTestId('toolbar-member') as HTMLSelectElement).value).toBe(ID.m1));

    fireEvent.click(screen.getByRole('button', { name: 'New reforecast' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Reforecast 1' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(current('turnover')).toBe(formatStatementFigure(1000)));
    expect(current('grossProfit')).toBe(formatStatementFigure(600));
    expect(current('netProfit')).toBe(formatStatementFigure(519.5));
  });
});
