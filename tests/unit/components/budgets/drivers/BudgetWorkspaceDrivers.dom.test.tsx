/**
 * P4 on the real workspace (hooks, store, grid; fetch mocked at the edge): the driver chip opens
 * the editor; an override cell's mark shows the driver value and its Reset POSTs that cell with
 * the version token, and the next write carries the token that answer returned (adopted even
 * when the re-read fails); a reforecast's closed months are read-only "Actual" columns and typing
 * there says why; a grid save's `driverWarnings` reach the save bar and the row's chip.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetWorkspace } from '@/components/accounting/budgets/workspace/BudgetWorkspace';
import { buildLayout } from '@/components/accounting/budgets/workspace/gridLayout';
import { ACTUAL_REASON } from '@/components/accounting/budgets/workspace/gridStore';
import { fail, installNetwork, isModel, isSave, ok } from '../workspace/workspaceHarness';
import { ID, MONTHS, T2, T3, TOKEN, driverModel } from './driverFixture';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() }, push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const OVERRIDE = '/api/accounting/budget-drivers/override';
const rowOf = (id: string) => buildLayout(driverModel().accounts, MONTHS).rows.find((r) => r.key === `acct:${id}`)!.index;
const cellAt = (id: string, c: number) => document.querySelector<HTMLElement>(`[data-pos="${rowOf(id)}:${c}"]`)!;
const announced = () => screen.getByTestId('grid-announcement').textContent ?? '';

describe('drivers in the workspace', () => {
  it('the chip shows the driver and opens the editor', async () => {
    const net = installNetwork();
    net.on(isModel, () => ok(driverModel()));
    render(<BudgetWorkspace />);
    const row = (await screen.findAllByTestId('driver-chip'))[0]!.closest('tr')!;
    expect(row).toHaveAttribute('data-row', `acct:${ID.cos1}`);
    fireEvent.click(within(row).getByTestId('driver-chip'));
    expect(await screen.findByRole('dialog', { name: 'Edit driver' })).toHaveTextContent('2000 Account 2000');
    expect(cellAt(ID.cos1, 1)).toHaveAttribute('data-source', 'driver');
  });

  it('Reset on an override POSTs that cell with the token; the next write sends the token the answer returned', async () => {
    const net = installNetwork();
    let reads = 0;
    net.on(isModel, () => (++reads === 1 ? ok(driverModel()) : fail(500, 'read failed')));
    net.on((u) => u === OVERRIDE, () => ok({ reset: 1, updatedAt: reads < 2 ? T2 : T3, recomputed: 1, warnings: [] }));
    render(<BudgetWorkspace />);
    const may = await waitFor(() => { const c = cellAt(ID.cos1, 2); expect(c).toHaveAttribute('data-source', 'override'); return c; });
    expect(may.getAttribute('aria-label')).toContain('override of the driver: Shift+F10 for Reset');
    fireEvent.mouseEnter(within(may).getByTestId('override-mark'));
    expect(within(may).getByTestId('override-note')).toHaveTextContent('Override of driver value R 380.00');
    fireEvent.click(within(may).getByTestId('override-reset'));
    await waitFor(() => expect(net.sent.filter((s) => s.url === OVERRIDE)).toHaveLength(1));
    expect(net.sent.find((s) => s.url === OVERRIDE)).toMatchObject({
      method: 'POST',
      body: { versionId: ID.version, expectedUpdatedAt: TOKEN, glAccountId: ID.cos1, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[2] },
    });
    await waitFor(() => expect(reads).toBe(2));
    // The re-read failed, so the grid still shows the override; the row's actions reset it again.
    fireEvent.click(screen.getByRole('button', { name: 'Row actions for 2000 Account 2000' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset all overrides' }));
    await waitFor(() => expect(net.sent.filter((s) => s.url === OVERRIDE)).toHaveLength(2));
    expect(net.sent.filter((s) => s.url === OVERRIDE)[1]!.body).toMatchObject({ expectedUpdatedAt: T2, month: null });
  });

  it("a reforecast's closed months are read-only Actual columns: typing there does nothing and says why", async () => {
    const net = installNetwork();
    net.on(isModel, () => ok(driverModel({ withActuals: true })));
    render(<BudgetWorkspace />);
    const header = await screen.findByRole('columnheader', { name: 'March 2026, actual' });
    expect(header).toHaveTextContent('Actual');
    expect(screen.getByRole('columnheader', { name: 'May 2026' })).not.toHaveTextContent('Actual');
    const mar = cellAt(ID.rev1, 0);
    expect(mar).toHaveAttribute('data-actual', 'true');
    expect(mar).toHaveAttribute('aria-readonly', 'true');
    expect(mar).toHaveAttribute('title', ACTUAL_REASON);
    fireEvent.mouseDown(mar);
    fireEvent.keyDown(mar, { key: '7' });
    expect(screen.queryByRole('textbox', { name: /Mar 2026 budget/ })).toBeNull();
    expect(announced()).toBe(ACTUAL_REASON);
    fireEvent.doubleClick(mar);
    expect(screen.queryByRole('textbox', { name: /Mar 2026 budget/ })).toBeNull();
    // An open month of the same row still takes typing.
    fireEvent.doubleClick(cellAt(ID.rev1, 3));
    expect(screen.getByRole('textbox', { name: '1000 Account 1000 Jun 2026 budget' })).toBeInTheDocument();
  });

  it("a grid save's driverWarnings reach the save bar and the driver's chip; the version is re-read", async () => {
    const net = installNetwork();
    let reads = 0;
    net.on(isModel, () => { reads++; return ok(driverModel()); });
    const warning = { code: 'DRIVER_SKIPPED', rowKey: `${ID.opex}|||`, message: 'driver on 3100 Account 3100 cannot compute: change or delete the driver' };
    net.on(isSave, () => ok({ updatedAt: T2, saved: 1, deleted: 0, recomputed: 12, reset: 0, driverWarnings: [warning] }));
    render(<BudgetWorkspace />);
    const apr = await waitFor(() => { const c = cellAt(ID.rev1, 1); expect(c).toBeTruthy(); return c; });
    fireEvent.doubleClick(apr);
    const editor = screen.getByRole('textbox', { name: '1000 Account 1000 Apr 2026 budget' });
    fireEvent.change(editor, { target: { value: '1100' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('save-bar-save'));
    expect(await screen.findByTestId('save-bar-driver-warnings')).toHaveTextContent(warning.message);
    expect(screen.getByTestId('save-bar-status')).toHaveTextContent('drivers recomputed 12 cells');
    await waitFor(() => expect(reads).toBe(2));
    const opexChip = within(document.querySelector<HTMLElement>(`[data-row="acct:${ID.opex}"]`)!).getByTestId('driver-chip');
    await waitFor(() => expect(opexChip).toHaveAttribute('data-warning', 'true'));
  });
});
