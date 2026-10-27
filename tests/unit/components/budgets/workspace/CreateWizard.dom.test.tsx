import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CreateWizard, type CreateWizardProps } from '@/components/accounting/budgets/workspace/CreateWizard';
import * as client from '@/components/accounting/budgets/workspace/budgetWorkspaceClient';
import { formatStatementFigure } from '@/lib/format/money';

vi.mock('@/components/accounting/budgets/workspace/budgetWorkspaceClient');

const A_SALES = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A_COGS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const year = (fiscalYear: number, monthKeys: string[]) => ({ fiscalYear, startDate: `${fiscalYear}-01-01`, endDate: `${fiscalYear}-02-28`, kind: 'standard', monthKeys });
const YEARS = [year(2027, ['2027-01', '2027-02']), year(2026, ['2026-01', '2026-02'])];
const ACCOUNTS = [
  { id: A_SALES, band: 'turnover' as const, isActive: true, isHeader: false },
  { id: A_COGS, band: 'cost_of_sales' as const, isActive: true, isHeader: false },
];
const version = (id: string, fy: number, name: string) => ({ id, fiscalYear: fy, name, kind: 'original' }) as never;
const ok = <T,>(data: T) => ({ ok: true as const, data });

const base = (over: Partial<CreateWizardProps> = {}): CreateWizardProps => ({
  open: true, onClose: vi.fn(), years: YEARS, fiscalYear: 2027, canMakePrimary: true, accounts: ACCOUNTS,
  currentTotals: null, onCreated: vi.fn(), ...over,
});

beforeEach(() => {
  vi.mocked(client.listVersions).mockReset().mockImplementation(async (fy) =>
    ok(fy === 2027 ? [] : [version('v-2026', 2026, 'Budget 2026')]));
  vi.mocked(client.fetchPriorActuals).mockReset().mockResolvedValue(ok({
    fiscalYear: 2027, grain: 'company', months: ['2027-01', '2027-02'], priorMonths: ['2026-01', '2026-02'],
    cells: [
      { glAccountId: A_SALES, dimensionId: null, month: '2027-01', amount: 1000 },
      { glAccountId: A_SALES, dimensionId: null, month: '2027-02', amount: 2000 },
      { glAccountId: A_COGS, dimensionId: null, month: '2027-01', amount: 500 },
    ],
  }));
  vi.mocked(client.fetchGridCells).mockReset();
  vi.mocked(client.seedVersion).mockReset().mockResolvedValue(ok({ versionId: 'new-v', updatedAt: 't', cells: 3, skippedAccounts: 0 }));
});
afterEach(cleanup);

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));
const name = (text: string) => fireEvent.change(screen.getByLabelText('Name'), { target: { value: text } });
/** Waits for the year lookup the Next button depends on. */

it('walks Version, Source, Options and back, and refuses Next without a name', async () => {
  render(<CreateWizard {...base()} />);
  await waitFor(() => expect(client.listVersions).toHaveBeenCalledWith(2027));
  name('   ');
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  name('Budget 2027');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
  next();
  expect(screen.getByText('Start from')).toBeTruthy();
  next();
  expect(screen.getByText('Full year')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByText('Start from')).toBeTruthy();
});

it('locks the first version of a year to Original and offers Reforecast / Scenario after that', async () => {
  render(<CreateWizard {...base()} />);
  await waitFor(() => expect((screen.getByLabelText('Kind') as HTMLSelectElement).disabled).toBe(true));
  expect((screen.getByLabelText('Kind') as HTMLSelectElement).value).toBe('original');
  fireEvent.change(screen.getByLabelText('Financial year'), { target: { value: '2026' } });
  await waitFor(() => expect((screen.getByLabelText('Kind') as HTMLSelectElement).disabled).toBe(false));
  expect([...(screen.getByLabelText('Kind') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['reforecast', 'scenario']);
});

it('shows Make primary to owner/admin only', () => {
  const { rerender } = render(<CreateWizard {...base({ canMakePrimary: true })} />);
  expect(screen.getByLabelText('Make primary')).toBeTruthy();
  rerender(<CreateWizard {...base({ canMakePrimary: false })} />);
  expect(screen.queryByLabelText('Make primary')).toBeNull();
});

it('sends the PY-actuals request the options describe, then reports the new version', async () => {
  const props = base();
  render(<CreateWizard {...props} />);
  name(' Budget 2027 ');
  fireEvent.click(screen.getByLabelText('Make primary'));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
  next();
  fireEvent.change(screen.getByLabelText('Uplift (%)'), { target: { value: '7.5' } });
  next();
  fireEvent.change(screen.getByLabelText('Seed at'), { target: { value: 'cc1' } });
  fireEvent.click(screen.getByLabelText('Drop them'));
  fireEvent.change(screen.getByLabelText('Round each month to'), { target: { value: '100' } });
  fireEvent.click(screen.getByLabelText(/Include accounts with no prior-year activity/));
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(client.seedVersion).toHaveBeenCalledTimes(1));
  expect(client.seedVersion).toHaveBeenCalledWith({
    fiscalYear: 2027, name: 'Budget 2027', kind: 'original', makePrimary: true, roundingUnit: 100, includeNoActivity: true,
    source: { type: 'py_actuals', upliftPct: 7.5, grain: 'cc1', unassigned: 'drop' },
  });
  await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith('new-v', { thenImport: false }));
  expect(props.onClose).toHaveBeenCalled();
});

it('copies a version from another year with the uplift', async () => {
  render(<CreateWizard {...base()} />);
  name('Scenario');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
  next();
  fireEvent.click(screen.getByLabelText('Copy a version'));
  fireEvent.change(screen.getByLabelText('Copy from year'), { target: { value: '2026' } });
  await waitFor(() => expect(screen.getByRole('option', { name: /Budget 2026/ })).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Version to copy'), { target: { value: 'v-2026' } });
  fireEvent.change(screen.getByLabelText('Uplift (%)'), { target: { value: '5' } });
  vi.mocked(client.fetchGridCells).mockResolvedValue(ok({ versionId: 'v-2026', updatedAt: 't', cells: [] }));
  next();
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(client.seedVersion).toHaveBeenCalled());
  expect(vi.mocked(client.seedVersion).mock.calls[0]![0]).toMatchObject({ source: { type: 'version', versionId: 'v-2026', upliftPct: 5 }, roundingUnit: 1 });
});

it('Import Excel creates a blank version and asks for the import dialog', async () => {
  const props = base();
  render(<CreateWizard {...props} />);
  name('From Excel');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
  next();
  fireEvent.click(screen.getByLabelText('Import Excel'));
  next();
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith('new-v', { thenImport: true }));
  expect(vi.mocked(client.seedVersion).mock.calls[0]![0].source).toEqual({ type: 'blank' });
});

it('previews Turnover / Gross profit / Net profit for the prior year and the new version', async () => {
  render(<CreateWizard {...base({ currentTotals: { turnover: 9000, grossProfit: 8000, netProfit: 7000 } as never })} />);
  name('Budget 2027');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
  next();
  fireEvent.change(screen.getByLabelText('Uplift (%)'), { target: { value: '10' } });
  next();
  const row = (m: string) => document.querySelector(`tr[data-metric="${m}"]`) as HTMLElement;
  await waitFor(() => expect(within(row('turnover')).getAllByRole('cell')[1]!.textContent).toBe(formatStatementFigure(3000)));
  expect(within(row('turnover')).getAllByRole('cell')[0]!.textContent).toBe(formatStatementFigure(9000));
  expect(within(row('turnover')).getAllByRole('cell')[2]!.textContent).toBe(formatStatementFigure(3300));
  expect(within(row('grossProfit')).getAllByRole('cell')[1]!.textContent).toBe(formatStatementFigure(2500));
  expect(within(row('grossProfit')).getAllByRole('cell')[2]!.textContent).toBe(formatStatementFigure(2750));
  expect(within(row('netProfit')).getAllByRole('cell')[2]!.textContent).toBe(formatStatementFigure(2750));
});

it.each([
  [{ ok: false, kind: 'conflict', message: 'A version with that name already exists.', code: 'BUDGET_VERSION_NAME_TAKEN' }, /already exists/],
  [{ ok: false, kind: 'forbidden', message: 'Only an owner or admin can make a version primary.' }, /owner or admin/],
  [{ ok: false, kind: 'rateLimited', message: 'Too many requests.', retryAfter: 12 }, /Too many requests/],
  [{ ok: false, kind: 'invalid', message: 'Account 4000 Sales: the uplift is too large.', code: null }, /4000 Sales/],
])('shows the refusal and stays open: %#', async (failure, text) => {
  vi.mocked(client.seedVersion).mockResolvedValue(failure as never);
  const props = base();
  render(<CreateWizard {...props} />);
  name('Budget');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
  next(); next();
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(text);
  expect(props.onCreated).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});
