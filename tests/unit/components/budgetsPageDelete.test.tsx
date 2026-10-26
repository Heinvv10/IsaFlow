/**
 * The budgets page (budgets P0, D9/D10): delete asks first, the Add picker
 * offers only active LEAF revenue/expense accounts, an edited account comes
 * from its own row, and the totals are split by type.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';
import { budgetRow, budgetsPayload } from './budgetsApiFixture';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import BudgetsPage from '../../../pages/accounting/budgets/index';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const acc = (id: string, accountCode: string, accountName: string, accountType: string, over: Record<string, unknown> = {}) =>
  ({ id, accountCode, accountName, accountType, isActive: true, ...over });
const GL = [
  acc('g0', '4000', 'D2 Sales Budget', 'revenue'),
  acc('h6', '6000', 'Operating expenses (header)', 'expense'),
  acc('g61', '6100', 'Rent', 'expense', { parentAccountId: 'h6' }),
  acc('g62', '6200', 'Old telephone', 'expense', { parentAccountId: 'h6', isActive: false }),
  acc('g45', '4500', 'Interest received', 'revenue'),
  acc('a1', '1000', 'Bank', 'asset'),
  // A header whose ONLY child is inactive: it is a header to the posting rules,
  // but a chart read without inactive rows would show it as a leaf.
  acc('h7', '7000', 'Legacy costs (header)', 'expense'),
  acc('g71', '7100', 'Legacy fee', 'expense', { parentAccountId: 'h7', isActive: false }),
];
/** What GET /api/accounting/chart-of-accounts answers: inactive rows only when asked for. */
const chart = (u: string) => (u.includes('includeInactive=true') ? GL : GL.filter((a) => a.isActive));
const RENT = budgetRow({ glAccountId: 'g61', accountCode: '6100', accountName: 'Rent', accountType: 'expense' }, 50);
// Budgeted when it was a leaf; it has since become the header above Rent.
const HEADER_BUDGET = budgetRow({ glAccountId: 'h6', accountCode: '6000', accountName: 'Operating expenses (header)', accountType: 'expense' }, 10);

function serve(items: unknown[]) {
  script((u) => {
    if (u.includes('chart-of-accounts')) return ok(chart(u));
    if (u.includes('budgets-action')) return ok({ deleted: true });
    if (/\/budgets(\?|$)/.test(u)) return ok(budgetsPayload(items));
    return undefined;
  });
}
const deletes = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('budgets-action'));

describe('budgets page delete, picker and totals', () => {
  it('delete asks first; Cancel sends nothing; Accept sends one delete', async () => {
    serve([budgetRow(), RENT]);
    render(<BudgetsPage />);
    await screen.findByText('Rent');
    const rentRow = screen.getByTestId('budget-total-6100').closest('tr')!;
    fireEvent.click(within(rentRow).getByTitle('Delete'));
    const dialog = await screen.findByText(/Delete the 2026 budget for 6100 Rent \(R\s?600\.00\)\? Every month is removed\./);
    expect(dialog).toBeTruthy();
    expect(deletes()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/Every month is removed/)).toBeNull());
    expect(deletes()).toHaveLength(0);

    fireEvent.click(within(rentRow).getByTitle('Delete'));
    await screen.findByText(/Every month is removed/);
    fireEvent.click(screen.getByText('Delete')); // the dialog's accept button (the row's trash icon has no text)
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(JSON.parse(String((deletes()[0]![1] as RequestInit).body))).toEqual({ action: 'delete', glAccountId: 'g61', fiscalYear: 2026 });
  });

  it('the add picker offers no header and no inactive account', async () => {
    serve([]);
    render(<BudgetsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add budget/i }));
    await screen.findByRole('option', { name: /Rent/ });
    const picker = screen.getByText('Select GL Account *').closest('select')!;
    const offered = Array.from(picker.options).map((o) => o.value).filter(Boolean);
    // h7 is a header (its child is inactive), h6 a header, g62 inactive, a1 an asset.
    expect(offered).toEqual(['g0', 'g45', 'g61']);
  });

  it('editing an account that became a header still shows it', async () => {
    serve([HEADER_BUDGET]);
    render(<BudgetsPage />);
    await screen.findByText('Operating expenses (header)');
    fireEvent.click(screen.getByTitle('Edit'));
    const picker = (await screen.findByText('Select GL Account *')).closest('select')! as HTMLSelectElement;
    expect(picker.value).toBe('h6');
    expect(within(picker).getByRole('option', { name: /6000 — Operating expenses \(header\)/ })).toBeTruthy();
  });

  it('summary shows revenue, expense and net budgeted profit', async () => {
    serve([budgetRow(), RENT]);
    render(<BudgetsPage />);
    await screen.findByText('Rent');
    const summary = screen.getByTestId('budget-summary').textContent ?? '';
    // Revenue 1 200, expenses 600, net 600 - never 1 800.
    expect(summary).toMatch(/Revenue budget for 2026R\s?1\D?200\.00/);
    expect(summary).toMatch(/Expense budget for 2026R\s?600\.00/);
    expect(summary).toMatch(/Net budgeted profit for 2026R\s?600\.00/);
    expect(summary).not.toMatch(/1\D?800/);
    expect(screen.getByTestId('budget-tfoot-net').textContent).toMatch(/Net budgeted profitR\s?600\.00R\s?50\.00/);
  });
});
