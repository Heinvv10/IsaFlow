/**
 * Driver writes on the real workspace, through the real fetchers (`call` / `failureOf`): the PUT
 * body Save sends (a pct_of_line `ref`, the token), the DELETE query (after the in-app confirm),
 * a 400 DRIVER_CYCLE's path labelled in the drawer, the clean-grid guard, a 409 STALE that
 * re-reads and says so, a failed re-read after a write that stood, one Reset at a time, focus
 * back on the row when the drawer closes, and a row spread in a version with closed months.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetWorkspace } from '@/components/accounting/budgets/workspace/BudgetWorkspace';
import { buildLayout } from '@/components/accounting/budgets/workspace/gridLayout';
import { FY_CLOSED_REASON } from '@/components/accounting/budgets/workspace/gridStore';
import { fail, installNetwork, isModel, ok, openEditor } from '../workspace/workspaceHarness';
import { ID, MONTHS, T2, TOKEN, driverModel } from './driverFixture';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() }, push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const DRIVERS = '/api/accounting/budget-drivers';
const OVERRIDE = '/api/accounting/budget-drivers/override';
const rowOf = (id: string) => buildLayout(driverModel().accounts, MONTHS).rows.find((r) => r.key === `acct:${id}`)!.index;
const cellAt = (id: string, c: number) => document.querySelector<HTMLElement>(`[data-pos="${rowOf(id)}:${c}"]`)!;
const rowActions = async (code: string, item: string | RegExp) => {
  fireEvent.click(await screen.findByRole('button', { name: `Row actions for ${code} Account ${code}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
};
const writes = (net: ReturnType<typeof installNetwork>, url: string) => net.sent.filter((s) => s.url.startsWith(url) && s.method !== 'GET');

async function ready(over: Parameters<typeof driverModel>[0] = {}) {
  const net = installNetwork();
  let reads = 0;
  net.on(isModel, () => { reads++; return ok(driverModel(over)); });
  render(<BudgetWorkspace />);
  await screen.findAllByTestId('driver-chip');
  return { net, reads: () => reads };
}

describe('driver writes through the real fetchers', () => {
  it('Save PUTs the pct_of_line line with its ref and the token; focus goes back to the row', async () => {
    const { net } = await ready();
    net.on((u, m) => u === DRIVERS && m === 'PUT', () => ok({ driver: {}, updatedAt: T2, recomputed: 12, warnings: [] }));
    await rowActions('1010', 'Set driver…');
    const ed = await screen.findByTestId('driver-editor');
    fireEvent.change(within(ed).getByLabelText('Driver'), { target: { value: 'pct_of_line' } });
    fireEvent.change(within(ed).getByLabelText('Percentage (%)'), { target: { value: '12.5' } });
    fireEvent.change(within(ed).getByLabelText('Of the line'), { target: { value: `${ID.rev1}|||` } });
    fireEvent.click(within(ed).getByTestId('driver-editor-save'));
    await waitFor(() => expect(writes(net, DRIVERS)).toHaveLength(1));
    expect(writes(net, DRIVERS)[0]!.body).toEqual({
      versionId: ID.version, expectedUpdatedAt: TOKEN, glAccountId: ID.rev2, cc1Id: null, cc2Id: null, buId: null,
      kind: 'pct_of_line', fromMonth: MONTHS[0], toMonth: MONTHS[11], rounding: 1, pct: 12.5,
      ref: { glAccountId: ID.rev1, cc1Id: null, cc2Id: null, buId: null },
    });
    await waitFor(() => expect(screen.queryByTestId('driver-editor')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(cellAt(ID.rev2, 0)));
  });

  it('Delete asks first, then DELETEs with the version, the token and the driver id in the query', async () => {
    const { net } = await ready();
    net.on((u, m) => u.startsWith(`${DRIVERS}?`) && m === 'DELETE', () => ok({ deleted: true, id: 'x', updatedAt: T2, recomputed: 0, warnings: [] }));
    await rowActions('3100', 'Edit driver…');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete driver' }));
    expect(writes(net, DRIVERS)).toHaveLength(0);
    fireEvent.click(within(screen.getByTestId('driver-delete-confirm')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(writes(net, DRIVERS)).toHaveLength(1));
    const url = new URL(writes(net, DRIVERS)[0]!.url, 'http://x');
    expect(Object.fromEntries(url.searchParams)).toEqual({ versionId: ID.version, expectedUpdatedAt: TOKEN, id: `d0000000-0000-4000-8000-${ID.opex.slice(-12)}` });
  });

  it("a 400 DRIVER_CYCLE's path comes through failureOf and is labelled in the drawer", async () => {
    const { net } = await ready();
    net.on((u, m) => u === DRIVERS && m === 'PUT', () => fail(400, 'This driver makes a loop',
      { code: 'DRIVER_CYCLE', path: [`${ID.cos1}|||`, `${ID.rev1}|||`, `${ID.cos1}|||`] }));
    fireEvent.click((await screen.findAllByTestId('driver-chip'))[0]!);
    fireEvent.click(within(await screen.findByTestId('driver-editor')).getByTestId('driver-editor-save'));
    expect(await screen.findByTestId('driver-editor-error')).toHaveTextContent(
      'This driver makes a loop: 2000 Account 2000 → 1000 Account 1000 → 2000 Account 2000');
  });

  it('a dirty grid: Reset sends nothing and says to save or discard first', async () => {
    const { net } = await ready();
    const editor = await openEditor(() => cellAt(ID.rev2, 0), '1010 Account 1010 Mar 2026 budget');
    fireEvent.change(editor, { target: { value: '5' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await rowActions('2000', 'Reset all overrides');
    expect(await screen.findByTestId('driver-notice')).toHaveTextContent('Save or discard your 1 unsaved change first');
    expect(writes(net, OVERRIDE)).toHaveLength(0);
  });

  it('a 409 STALE re-reads the version in place and says so', async () => {
    const { net, reads } = await ready();
    net.on((u) => u === OVERRIDE, () => fail(409, 'Someone else changed this budget.', { code: 'BUDGET_VERSION_STALE', currentUpdatedAt: T2, status: 'draft' }));
    await rowActions('2000', 'Reset all overrides');
    expect(await screen.findByTestId('driver-notice')).toHaveTextContent('Someone else changed this budget. The latest version is now on screen');
    await waitFor(() => expect(reads()).toBe(2));
    expect(screen.queryByTestId('workspace-loading')).toBeNull();
  });

  it('a write that stood but whose re-read failed says so; a second Reset while one runs sends nothing', async () => {
    const { net } = await ready();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    net.on((u) => u === OVERRIDE, async () => { await held; return ok({ reset: 1, updatedAt: T2, recomputed: 1, warnings: [] }); });
    net.on(isModel, () => fail(500, 'read failed'));
    await rowActions('2000', 'Reset all overrides');
    await rowActions('2000', 'Reset all overrides');
    release();
    expect(await screen.findByTestId('driver-notice')).toHaveTextContent('could not be read again');
    expect(writes(net, OVERRIDE)).toHaveLength(1);
  });

  it('Spread across months in a version with closed months spreads over the open ones only', async () => {
    await ready({ withActuals: true });
    await rowActions('1010', 'Spread across months…');
    expect(await screen.findByTestId('spread-note')).toHaveTextContent('Spread over the 10 open months; the closed months keep their actuals.');
    const preview = screen.getByRole('table', { name: 'Preview' });
    expect(within(preview).getAllByRole('row')).toHaveLength(10);
    expect(within(preview).queryByText('Mar 2026')).toBeNull();
    const dialog = screen.getByRole('dialog');
    const amount = within(dialog).getByLabelText('Full-year amount');
    fireEvent.change(amount, { target: { value: '100000' } });
    fireEvent.blur(amount);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    // The whole amount lands on the 10 open months; the two closed months keep their actuals (blank here).
    await waitFor(() => expect(cellAt(ID.rev2, 2)).toHaveTextContent('10 000'));
    expect(cellAt(ID.rev2, 11)).toHaveTextContent('10 000');
    expect(cellAt(ID.rev2, 0).textContent?.replace('A', '')).toBe('');
    expect(cellAt(ID.rev2, 12)).toHaveTextContent('100 000');
  });

  it('every month closed: the spread is refused with the reason', async () => {
    await ready({ withActuals: true, closed: 12 });
    await rowActions('1010', 'Spread across months…');
    const notice = (await screen.findByText(/cells need a look/)).closest('[role="status"]')!;
    expect(notice).toHaveTextContent(FY_CLOSED_REASON);
    expect(screen.getByTestId('grid-announcement')).toHaveTextContent(FY_CLOSED_REASON);
    expect(screen.queryByTestId('spread-note')).toBeNull();
  });

  it("useDriverActions records a failed headcount read: the per_head preview says so; a later good read clears it", async () => {
    const { net } = await ready();
    let reads = 0;
    net.on((u) => u.startsWith('/api/accounting/budget-drivers/headcount?'), () => (++reads === 1 ? fail(503, 'Payroll is busy.')
      : ok({ costCentreId: null, months: MONTHS.map((month) => ({ month, payroll: 2, hires: 0, total: 2 })), asOf: '2026-10-29T08:00:00.000Z' })));
    await rowActions('3100', 'Edit driver…');
    const ed = await screen.findByTestId('driver-editor');
    fireEvent.change(within(ed).getByLabelText('Driver'), { target: { value: 'per_head' } });
    fireEvent.change(within(ed).getByLabelText('Amount per head a month (R)'), { target: { value: '1000' } });
    expect(await within(ed).findByText(/The headcount could not be read: Payroll is busy\./)).toBeInTheDocument();
    // Asking again (another scope, then back) retries; the good answer replaces the error with the counts.
    fireEvent.change(within(ed).getByLabelText('Headcount of'), { target: { value: ID.m1 } });
    fireEvent.change(within(ed).getByLabelText('Headcount of'), { target: { value: '' } });
    await waitFor(() => expect(within(ed).queryByText(/could not be read/)).toBeNull());
    const apr = within(screen.getByTestId('driver-preview')).getByRole('rowheader', { name: 'Apr 2026' }).closest('tr')!;
    await waitFor(() => expect(apr).toHaveTextContent('R 2 000.00'));
  });
});

