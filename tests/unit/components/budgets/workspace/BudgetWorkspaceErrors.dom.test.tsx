/**
 * The server's message reaches the user on the budgets page (budgets P2 PR-D). Replaces the budget
 * cases of d2ErrorEnvelopeG1a / G1aSuccess, d2Round2Main, d2R3A5Reload and d2R3A5Writes, which drove
 * the old page: a refusal in the real envelope `{ success:false, error:{ message } }` is painted as
 * the server worded it, an empty-body 500 is a plain sentence (never JSON or HTTP text), a refused
 * write claims no success and keeps the unsaved change, and a failed load after a year switch
 * leaves nothing of the year the user left. Real hooks, store and grid; fetch mocked at the edge.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetWorkspace } from '@/components/accounting/budgets/workspace/BudgetWorkspace';
import { buildLayout } from '@/components/accounting/budgets/workspace/gridLayout';
import { fail, installNetwork, isModel, isSave, ok, openEditor } from './workspaceHarness';
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

const MSG = 'D2 server says no: this data is not available';
const empty500 = () => new Response('', { status: 500 });
const isYears = (u: string) => u === '/api/accounting/budgets?years_only=1';
const rev2Row = buildLayout(gridModel().accounts, gridModel().year.monthKeys).rows.find((r) => r.key === `acct:${ID.rev2}`)!.index;
const marchRev2 = () => document.querySelector<HTMLElement>(`[data-pos="${rev2Row}:0"]`)!;
/** No raw error text on screen: no JSON, no parse error, no bare status. */
const expectNoRawError = () => expect(document.body.textContent).not.toMatch(/JSON|Unexpected end|\{"|HTTP \d{3}|^Failed$/);

async function typeIntoMarchRev2(value: string) {
  const editor = await openEditor(marchRev2, '1010 Account 1010 Mar 2026 budget');
  fireEvent.change(editor, { target: { value } });
  fireEvent.keyDown(editor, { key: 'Enter' });
  await waitFor(() => expect(marchRev2()).toHaveAttribute('data-dirty', 'true'));
}

describe('loads', () => {
  it('the year list refused: the server message and Retry, not a grid; Retry loads the grid', async () => {
    net.on(isYears, () => fail(400, MSG));
    render(<BudgetWorkspace />);
    const panel = await screen.findByTestId('workspace-error');
    expect(panel).toHaveTextContent(MSG);
    expect(screen.queryByRole('grid')).toBeNull();
    net.on(isYears, () => ok({ items: [], fiscalYear: 2027, years: [] }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('grid', { name: 'Budget' })).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-error')).toBeNull();
  });

  it('the year list answered by an empty-body 500: a plain sentence', async () => {
    net.on(isYears, empty500);
    render(<BudgetWorkspace />);
    expect(await screen.findByTestId('workspace-error')).toHaveTextContent('Could not load the financial years. Try again.');
    expectNoRawError();
  });

  it('the budget answered by an empty-body 500: a plain sentence and Retry', async () => {
    net.on(isModel, empty500);
    render(<BudgetWorkspace />);
    const panel = await screen.findByTestId('workspace-error');
    expect(panel).toHaveTextContent('Could not load the budget.');
    expect(within(panel).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expectNoRawError();
  });

  it('200: the grid shows the accounts it received and no error', async () => {
    const m = gridModel();
    net.on(isModel, () => ok({ ...m, accounts: m.accounts.map((a) => (a.id === ID.rev2 ? { ...a, name: 'Quokka Rentals' } : a)) }));
    render(<BudgetWorkspace />);
    expect(await screen.findByRole('rowheader', { name: /1010\s*Quokka Rentals/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed load after a year switch clears the year on screen and says so', async () => {
    render(<BudgetWorkspace />);
    await screen.findByRole('grid', { name: 'Budget' });
    net.on((u) => isModel(u) && u.endsWith('fiscal_year=2028'), empty500);
    fireEvent.change(screen.getByTestId('workspace-year'), { target: { value: '2028' } });
    expect(await screen.findByTestId('workspace-error')).toHaveTextContent('Could not load the budget.');
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByRole('rowheader', { name: /1010\s*Account 1010/ })).toBeNull();
    expectNoRawError();
  });
});

describe('writes', () => {
  it('a save refused: the server message, the change stays unsaved, nothing claims it was saved', async () => {
    render(<BudgetWorkspace />);
    await screen.findByRole('grid', { name: 'Budget' });
    await typeIntoMarchRev2('500');
    net.on(isSave, () => fail(400, MSG));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // The status element is there (empty) before the save answers: wait for the text, not the element.
    await waitFor(() => expect(screen.getByTestId('save-bar-status')).toHaveTextContent(MSG));
    expect(screen.getByTestId('save-bar-status')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('save-bar-count')).toHaveTextContent('1 unsaved change');
    expect(marchRev2()).toHaveAttribute('data-dirty', 'true');
    expect(screen.queryByText(/^Saved:/)).toBeNull();
  });

  it('a save answered by an empty-body 500: a plain sentence, the change kept', async () => {
    render(<BudgetWorkspace />);
    await screen.findByRole('grid', { name: 'Budget' });
    await typeIntoMarchRev2('500');
    net.on(isSave, empty500);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('save-bar-status')).toHaveTextContent('Could not save the budget.'));
    expect(marchRev2()).toHaveAttribute('data-dirty', 'true');
    expectNoRawError();
  });

  it('a version action refused: the dialog stays open with the server message; the version is unchanged', async () => {
    render(<BudgetWorkspace />);
    await screen.findByRole('grid', { name: 'Budget' });
    net.on((u, m) => u.endsWith('/status') && m === 'POST', () => fail(400, MSG));
    fireEvent.click(screen.getByTestId('version-approve'));
    const dialog = screen.getByTestId('version-dialog-approve');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(MSG);
    expect(screen.getByTestId('version-status-chip')).toHaveTextContent('Draft');
  });
});
