/**
 * A year with no version, as the server answers it (gridReadModel's no-version branch): version and
 * token null, no cells, no grains, zero totals, and the accounts a first version can budget (none
 * holding amounts). The page offers the four wizard sources, never "No revenue or expense
 * accounts", and the wizard previews from those accounts: PY actuals of R1 200 on 1000 show as
 * Prior year and, at 0%, as the new version's turnover. Found in the PR-D browser proof, where the
 * server answered `accounts: []` and the page said the company had no accounts to budget.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetWorkspace } from '@/components/accounting/budgets/workspace/BudgetWorkspace';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { formatStatementFigure } from '@/lib/format/money';
import { installNetwork, isModel, ok } from './workspaceHarness';
import { ID, MONTHS, gridModel } from './gridFixture';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() }, push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

/** What GET budget-grid?fiscal_year= answers for a year with no version. */
function noVersionAnswer(): GridReadModel {
  const m = gridModel();
  const zero = MONTHS.map(() => 0);
  return {
    ...m, version: null, updatedAt: null, cells: [], grains: {},
    accounts: m.accounts.map((a) => ({ ...a, ownAmounts: false, grain: null, rollup: a.isHeader ? zero : null })),
    totals: {
      months: Object.fromEntries(Object.keys(m.totals.months).map((k) => [k, zero])) as GridReadModel['totals']['months'],
      fy: Object.fromEntries(Object.keys(m.totals.fy).map((k) => [k, 0])) as GridReadModel['totals']['fy'],
    },
  };
}

const previewRow = (metric: string) => within(document.querySelector<HTMLElement>(`tr[data-metric="${metric}"]`)!).getAllByRole('cell').map((c) => c.textContent);

describe('a year with no version, as the server answers it', () => {
  it('offers the wizard sources, and the wizard previews from the accounts the answer carries', async () => {
    const net = installNetwork();
    net.on(isModel, () => ok(noVersionAnswer()));
    net.on((u) => u.includes('/prior-actuals'), () => ok({ fiscalYear: 2027, grain: 'company', months: MONTHS, priorMonths: MONTHS,
      cells: MONTHS.map((month) => ({ glAccountId: ID.rev1, cc1Id: null, cc2Id: null, buId: null, month, amount: 100 })) }));
    render(<BudgetWorkspace />);

    const empty = await screen.findByTestId('workspace-empty');
    expect(empty).toHaveTextContent('No budget for FY2027 yet');
    expect(screen.queryByTestId('workspace-empty-accounts')).toBeNull();
    expect(within(empty).getAllByRole('button').map((b) => b.getAttribute('data-testid'))).toEqual([
      'empty-start-py_actuals', 'empty-start-version', 'empty-start-blank', 'empty-start-import']);

    fireEvent.click(screen.getByTestId('empty-start-py_actuals'));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Original' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // [Current, Prior year, New version]: no current version; PY R1 200 on 1000; 0% uplift.
    await waitFor(() => expect(previewRow('turnover')[1]).toBe(formatStatementFigure(1200)));
    expect(previewRow('turnover')[2]).toBe(formatStatementFigure(1200));
  });
});
