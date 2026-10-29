/**
 * "New reforecast from actuals" and the rolling forecast's controls (P4 spec §1.3, §6, §7):
 * the dialog POSTs `{ name, rolling }` to the picked source's reforecast route and lists the
 * actuals it could not place, by account; the rolling controls show "Rolled through <Mon YYYY> ·
 * N months closed since" only when the roll is behind, Roll now POSTs the token and the answer's
 * token is adopted, the toggle PUTs, and a locked roll's last_error is shown.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReforecastDialog, UNPLACED_COPY } from '@/components/accounting/budgets/drivers/ReforecastDialog';
import { RollingControls } from '@/components/accounting/budgets/drivers/RollingControls';
import { createReforecast } from '@/components/accounting/budgets/drivers/driverClient';
import { installNetwork, ok } from '../workspace/workspaceHarness';
import { ID, T2, TOKEN, driverModel } from './driverFixture';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const ORIGINAL = driverModel().version!;
const SCENARIO = { ...ORIGINAL, id: 'b0000000-0000-4000-8000-000000000002', name: 'Upside', kind: 'scenario' as const, isPrimary: false };
const REFORECAST = { ...ORIGINAL, id: 'b0000000-0000-4000-8000-000000000003', name: 'Q2 reforecast', kind: 'reforecast' as const, isPrimary: false };
const url = (id: string) => `/api/accounting/budget-versions/${id}/reforecast`;

describe('ReforecastDialog', () => {
  it('POSTs { name, rolling } to the picked source and lists the unplaced actuals by account', async () => {
    const net = installNetwork();
    const unplaced = [
      { accountId: ID.dimAcc, accountCode: '3200', accountName: 'Salaries', level: 'cc1', month: '2026-03', amount: 1200.5 },
      { accountId: ID.dimAcc, accountCode: '3200', accountName: 'Salaries', level: 'cc1', month: '2026-04', amount: 800 },
    ];
    net.on((u, m) => u === url(SCENARIO.id) && m === 'POST', () => new Response(JSON.stringify({ success: true, data: {
      version: REFORECAST, rolling: true, closedMonths: ['2026-03', '2026-04'], cells: 40, unplaced, warnings: [],
    } }), { status: 201 }));
    const onCreated = vi.fn();
    render(<ReforecastDialog versions={[ORIGINAL, SCENARIO]} current={ORIGINAL} create={createReforecast} onCreated={onCreated} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Source version' }), { target: { value: SCENARIO.id } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: '  Q2 reforecast ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Rolling/ }));
    fireEvent.click(screen.getByTestId('reforecast-create'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(REFORECAST));
    expect(net.sent.find((s) => s.url === url(SCENARIO.id))).toMatchObject({ method: 'POST', body: { name: 'Q2 reforecast', rolling: true } });
    const result = screen.getByTestId('reforecast-result');
    expect(result).toHaveTextContent('2 closed months (Mar 2026 to Apr 2026) hold the actuals');
    const list = screen.getByTestId('reforecast-unplaced');
    expect(list).toHaveTextContent(UNPLACED_COPY);
    expect(list).toHaveTextContent('3200 Salaries (budgeted by CC1): R 2 000.50 in Mar 2026, Apr 2026');
  });

  it('a refusal (a second rolling forecast this year) stays in the dialog', async () => {
    const net = installNetwork();
    net.on((u) => u === url(ORIGINAL.id), () => new Response(JSON.stringify({ success: false, error: { message: 'FY2027 already has a rolling forecast: Q1 roll', details: { code: 'BUDGET_VERSION_STATE' } } }), { status: 409 }));
    const onCreated = vi.fn();
    render(<ReforecastDialog versions={[ORIGINAL]} current={ORIGINAL} create={createReforecast} onCreated={onCreated} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('reforecast-create'));
    expect(await screen.findByRole('alert')).toHaveTextContent('already has a rolling forecast');
    expect(onCreated).not.toHaveBeenCalled();
    expect(net.sent.find((s) => s.url === url(ORIGINAL.id))!.body).toEqual({ name: 'Reforecast from actuals: Original', rolling: false });
  });
});

const status = (over: object = {}) => ({
  rolling: true, rolledThroughMonth: '2026-04', latestClosedMonth: '2026-06', staleMonths: ['2026-05', '2026-06'],
  lastRolledAt: '2026-10-01T00:00:00.000Z', lastError: null, ...over,
});

function grid() {
  return { token: TOKEN, dirtyCount: 0, adoptToken: vi.fn(), refresh: vi.fn(async (_w?: unknown) => null as string | null) };
}

describe('RollingControls', () => {
  it('stale: "Rolled through Apr 2026 · 2 months closed since"; Roll now POSTs the token, adopts the answer and re-reads', async () => {
    const net = installNetwork();
    let reads = 0;
    // After the roll the status is up to date; the grid token is unchanged (a roll that changed no cell keeps it).
    net.on((u, m) => u === url(REFORECAST.id) && m === 'GET', () => ok(++reads === 1 ? status() : status({ rolledThroughMonth: '2026-06', staleMonths: [] })));
    net.on((u, m) => u === url(REFORECAST.id) && m === 'POST', () => ok({ status: 'rolled', changed: 6, closedMonths: [], rolledThroughMonth: '2026-06', unplaced: [], warnings: [], updatedAt: T2 }));
    const g = grid();
    render(<RollingControls version={REFORECAST} grid={g} editable />);
    expect(await screen.findByTestId('rolling-stale')).toHaveTextContent('Rolled through Apr 2026 · 2 months closed since');
    fireEvent.click(screen.getByTestId('roll-now'));
    await waitFor(() => expect(g.refresh).toHaveBeenCalled());
    expect(net.sent.find((s) => s.method === 'POST')!.body).toEqual({ action: 'roll', expectedUpdatedAt: TOKEN });
    expect(g.adoptToken).toHaveBeenCalledWith(T2);
    await waitFor(() => expect(screen.queryByTestId('rolling-stale')).toBeNull());
    expect(reads).toBe(2);
  });

  it('up to date: no badge; the toggle PUTs rolling off with the token; a locked roll shows last_error', async () => {
    const net = installNetwork();
    net.on((u, m) => u === url(REFORECAST.id) && m === 'GET', () => ok(status({ staleMonths: [], rolledThroughMonth: '2026-06', lastError: 'version locked' })));
    net.on((u, m) => u === url(REFORECAST.id) && m === 'PUT', () => ok({ rolling: false, changed: true, updatedAt: T2 }));
    const g = grid();
    render(<RollingControls version={REFORECAST} grid={g} editable />);
    const toggle = await screen.findByRole('switch', { name: /Rolling: on/ });
    expect(screen.queryByTestId('rolling-stale')).toBeNull();
    expect(screen.getByTestId('rolling-error')).toHaveTextContent('Last roll skipped: version locked');
    fireEvent.click(toggle);
    await waitFor(() => expect(g.adoptToken).toHaveBeenCalledWith(T2));
    expect(net.sent.find((s) => s.method === 'PUT')!.body).toEqual({ rolling: false, expectedUpdatedAt: TOKEN });
  });

  it('an original version has no rolling controls and reads no status', async () => {
    const net = installNetwork();
    render(<RollingControls version={ORIGINAL} grid={grid()} editable />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('rolling-controls')).toBeNull();
    expect(net.sent.some((s) => s.url.includes('/reforecast'))).toBe(false);
  });

  it("Roll now's answer: the warnings go to the grid's re-read and the unplaced actuals are listed", async () => {
    const net = installNetwork();
    net.on((u, m) => u === url(REFORECAST.id) && m === 'GET', () => ok(status()));
    const warnings = [{ code: 'REF_MISSING', rowKey: `${ID.cos1}|||`, message: 'Referenced row has no amount' }];
    const unplaced = [{ accountId: ID.dimAcc, accountCode: '3200', accountName: 'Salaries', level: 'cc1', month: '2026-05', amount: 250 }];
    net.on((u, m) => u === url(REFORECAST.id) && m === 'POST', () => ok({ status: 'rolled', changed: 3, closedMonths: [], rolledThroughMonth: '2026-06', unplaced, warnings, updatedAt: T2 }));
    const g = grid();
    render(<RollingControls version={REFORECAST} grid={g} editable />);
    fireEvent.click(await screen.findByTestId('roll-now'));
    const note = await screen.findByTestId('rolling-note');
    expect(note).toHaveTextContent('Rolled: 3 cells changed.');
    expect(note).toHaveTextContent(`${UNPLACED_COPY}:`);
    expect(note).toHaveTextContent('3200 Salaries (budgeted by CC1): R 250.00 in May 2026');
    expect(g.refresh).toHaveBeenCalledWith(warnings);
  });

  it.each([
    ['locked', 'The version is locked: the roll was skipped.'],
    ['primary', 'This is the primary budget: a roll never rewrites what Budget vs Actual compares against.'],
    ['not_rolling', 'Auto-roll was turned off meanwhile: nothing was rolled.'],
  ])('a roll answered %s says so and re-reads nothing', async (rollStatus, text) => {
    const net = installNetwork();
    net.on((u, m) => u === url(REFORECAST.id) && m === 'GET', () => ok(status()));
    net.on((u, m) => u === url(REFORECAST.id) && m === 'POST', () => ok({ status: rollStatus, changed: 0, closedMonths: [], rolledThroughMonth: null, unplaced: [], warnings: [], updatedAt: null }));
    const g = grid();
    render(<RollingControls version={REFORECAST} grid={g} editable />);
    fireEvent.click(await screen.findByTestId('roll-now'));
    expect(await screen.findByTestId('rolling-note')).toHaveTextContent(text);
    expect(g.refresh).not.toHaveBeenCalled();
    expect(g.adoptToken).not.toHaveBeenCalled();
  });

  it('a month reopened after the roll: the spec banner and Roll now; the status unplaced actuals behind a disclosure', async () => {
    const net = installNetwork();
    const unplaced = [{ accountId: ID.dimAcc, accountCode: '3200', accountName: 'Salaries', level: 'cc1', month: '2026-04', amount: 99 }];
    net.on((u, m) => u === url(REFORECAST.id) && m === 'GET', () => ok(status({ staleMonths: [], rolledThroughMonth: '2026-06', reopenedMonths: ['2026-04'], unplaced })));
    render(<RollingControls version={REFORECAST} grid={grid()} editable />);
    expect(await screen.findByTestId('rolling-reopened')).toHaveTextContent('Apr 2026 reopened after the roll — Roll now refreshes it');
    expect(screen.getByTestId('roll-now')).toBeInTheDocument();
    const details = screen.getByTestId('rolling-unplaced');
    expect(details).toHaveTextContent('1 unplaced actual');
    expect(details).toHaveTextContent('3200 Salaries (budgeted by CC1): R 99.00 in Apr 2026');
  });

  it("a failed re-read after the roll is said", async () => {
    const net = installNetwork();
    net.on((u, m) => u === url(REFORECAST.id) && m === 'GET', () => ok(status()));
    net.on((u, m) => u === url(REFORECAST.id) && m === 'POST', () => ok({ status: 'rolled', changed: 1, closedMonths: [], rolledThroughMonth: '2026-06', unplaced: [], warnings: [], updatedAt: T2 }));
    const g = { ...grid(), refresh: vi.fn(async () => 'The change was saved, but the budget could not be read again.') };
    render(<RollingControls version={REFORECAST} grid={g} editable />);
    fireEvent.click(await screen.findByTestId('roll-now'));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read again');
  });

  it('a reforecast that does not roll: the reopened banner and Roll now as a manual refresh (the server reports no stale months)', async () => {
    const net = installNetwork();
    net.on((u, m) => u === url(REFORECAST.id) && m === 'GET', () => ok(status({ rolling: false, rolledThroughMonth: null, staleMonths: [], reopenedMonths: ['2026-03'], unplaced: [] })));
    net.on((u, m) => u === url(REFORECAST.id) && m === 'POST', () => ok({ status: 'rolled', changed: 2, closedMonths: [], rolledThroughMonth: '2026-05', unplaced: [], warnings: [], updatedAt: T2 }));
    const g = grid();
    render(<RollingControls version={REFORECAST} grid={g} editable />);
    expect(await screen.findByRole('switch', { name: /Rolling: off/ })).toBeInTheDocument();
    expect(screen.queryByTestId('rolling-stale')).toBeNull();
    expect(screen.getByTestId('rolling-reopened')).toHaveTextContent('Mar 2026 reopened after the roll — Roll now refreshes it');
    fireEvent.click(screen.getByTestId('roll-now'));
    await waitFor(() => expect(g.adoptToken).toHaveBeenCalledWith(T2));
    expect(net.sent.find((s) => s.method === 'POST')!.body).toEqual({ action: 'roll', expectedUpdatedAt: TOKEN });
  });

  it('Roll now shows on an up-to-date reforecast too (a manual refresh); a primary refusal (409) shows the server message', async () => {
    const net = installNetwork();
    net.on((u, m) => u === url(REFORECAST.id) && m === 'GET', () => ok(status({ rolling: false, staleMonths: [], reopenedMonths: [], unplaced: [] })));
    net.on((u, m) => u === url(REFORECAST.id) && m === 'POST', () => new Response(JSON.stringify({ success: false, error: {
      message: 'This is the primary budget; refreshing it would change Budget vs Actual. Make another version primary first, or copy it',
      details: { code: 'BUDGET_VERSION_STATE' } } }), { status: 409 }));
    const g = grid();
    render(<RollingControls version={REFORECAST} grid={g} editable />);
    const roll = await screen.findByTestId('roll-now');
    expect(screen.queryByTestId('rolling-stale')).toBeNull();
    expect(screen.queryByTestId('rolling-reopened')).toBeNull();
    fireEvent.click(roll);
    expect(await screen.findByTestId('rolling-note')).toHaveTextContent('This is the primary budget; refreshing it would change Budget vs Actual');
    expect(g.adoptToken).not.toHaveBeenCalled();
  });

  it('a reader sees the status but no Roll now', async () => {
    const net = installNetwork();
    net.on((u, m) => u === url(REFORECAST.id) && m === 'GET', () => ok(status()));
    render(<RollingControls version={REFORECAST} grid={grid()} editable={false} />);
    expect(await screen.findByTestId('rolling-stale')).toBeInTheDocument();
    expect(screen.queryByTestId('roll-now')).toBeNull();
  });
});
