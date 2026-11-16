/**
 * Editing the 13-week forecast (writers): the cell editor sends the data layer's payload (set/add signed in the
 * cell's sign, move_to a magnitude or null), a refusal shows the server's message and keeps the dialog, a save
 * reloads the forecast; one submit at a time; a stale load never overwrites a newer one; remove, add item and
 * pay day send what the routes expect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/components/accounting/cashForecast13/cash13Client', async () => (await import('./setup')).client);
vi.mock('@/contexts/CompanyContext', async () => (await import('./setup')).companyModule());
vi.mock('next/router', async () => (await import('./setup')).routerModule());
vi.mock('@/components/accounting/charts/ChartFrame', async () => (await import('./setup')).chartModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { Cash13Tab } from '@/components/accounting/cashForecast13/Cash13Tab';
import { answerDefaults, client, ok } from './setup';
import { forecastFixture } from './fixture';

const f = forecastFixture({ overrides: [] });
beforeEach(() => { answerDefaults(); });
afterEach(() => { cleanup(); });

async function openApCell() {
  render(<Cash13Tab />);
  fireEvent.click(await screen.findByRole('button', { name: /^Change Steel Supplies, Week 2/ }));
  return screen.findByRole('dialog');
}

function typeMoney(label: string | RegExp, text: string) {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
}

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('cell editor payloads', () => {
  it('Set to on a payment: the typed 6 000 goes out as -6000 for that Monday, then the forecast reloads', async () => {
    await openApCell();
    typeMoney('New amount', '6000');
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'agreed with supplier' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save change' }));
    await waitFor(() => expect(client.saveOverride).toHaveBeenCalledTimes(1));
    expect(client.saveOverride).toHaveBeenCalledWith({ lineKey: 'ap:s1', weekStart: f.weeks[1]!.start, mode: 'set', amount: -6000, note: 'agreed with supplier' });
    await waitFor(() => expect(client.fetchForecast).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Add on a payment flips the sign', async () => {
    await openApCell();
    fireEvent.click(screen.getByLabelText('Add'));
    typeMoney('Amount to add', '1000');
    fireEvent.click(screen.getByRole('button', { name: 'Save change' }));
    await waitFor(() => expect(client.saveOverride).toHaveBeenCalledWith(expect.objectContaining({ mode: 'add', amount: -1000 })));
  });

  it('Move the whole week: amount null and the target Monday', async () => {
    await openApCell();
    fireEvent.click(screen.getByLabelText('Move to another week'));
    fireEvent.change(screen.getByLabelText('Move to'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save change' }));
    await waitFor(() => expect(client.saveOverride).toHaveBeenCalledWith(
      { lineKey: 'ap:s1', weekStart: f.weeks[1]!.start, mode: 'move_to', amount: null, targetWeekStart: f.weeks[4]!.start, note: null },
    ));
  });

  it('Move part of it: a positive magnitude', async () => {
    await openApCell();
    fireEvent.click(screen.getByLabelText('Move to another week'));
    fireEvent.click(screen.getByLabelText('Move the whole week'));
    typeMoney('Amount to move', '2500');
    fireEvent.change(screen.getByLabelText('Move to'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save change' }));
    await waitFor(() => expect(client.saveOverride).toHaveBeenCalledWith(expect.objectContaining({ mode: 'move_to', amount: 2500, targetWeekStart: f.weeks[3]!.start })));
  });

  it('a refusal (409) shows the server\'s message, keeps the dialog and does not reload', async () => {
    client.saveOverride.mockResolvedValue({ ok: false, kind: 'conflict', message: 'At most 2000 changes per company', code: null });
    await openApCell();
    typeMoney('New amount', '6000');
    fireEvent.click(screen.getByRole('button', { name: 'Save change' }));
    expect(await screen.findByText('At most 2000 changes per company')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(client.fetchForecast).toHaveBeenCalledTimes(1);
  });

  it('nothing typed: refused before any request', async () => {
    await openApCell();
    fireEvent.click(screen.getByRole('button', { name: 'Save change' }));
    expect(await screen.findByText('Enter an amount.')).toBeTruthy();
    expect(client.saveOverride).not.toHaveBeenCalled();
  });
});

describe('guards', () => {
  it('a double click on Save sends one request', async () => {
    const d = deferred<ReturnType<typeof ok>>();
    client.saveOverride.mockReturnValue(d.promise);
    await openApCell();
    typeMoney('New amount', '6000');
    const save = screen.getByRole('button', { name: 'Save change' });
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(save);
    await act(async () => { d.resolve(ok({})); await d.promise; });
    expect(client.saveOverride).toHaveBeenCalledTimes(1);
  });

  it('a slow earlier load never overwrites a newer one', async () => {
    const first = deferred<ReturnType<typeof ok>>();
    client.fetchForecast.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ok(forecastFixture({ openingCents: 77_000_00, overrides: [] })));
    render(<Cash13Tab />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByTestId('kpi-opening').textContent).toContain('R 77 000'));
    await act(async () => { first.resolve(ok(forecastFixture({ openingCents: 11_000_00, overrides: [] }))); await first.promise; });
    expect(screen.getByTestId('kpi-opening').textContent).toContain('R 77 000');
  });
});

describe('the other writes', () => {
  it('a changed cell can be put back: DELETE by the override id', async () => {
    client.fetchOverrides.mockResolvedValue(ok([{ id: 'o-1', lineKey: 'ap:s1', weekStart: f.weeks[1]!.start, mode: 'set', amount: -6000, note: null }]));
    await openApCell();
    fireEvent.click(screen.getByRole('button', { name: 'Remove this change' }));
    await waitFor(() => expect(client.deleteOverride).toHaveBeenCalledWith('o-1'));
    await waitFor(() => expect(client.fetchForecast).toHaveBeenCalledTimes(2));
  });

  it('Add expected item posts the item', async () => {
    render(<Cash13Tab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add expected item' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByLabelText('Money going out'));
    typeMoney(/^Amount/, '1500.50');
    const date = screen.getByLabelText(/Expected date/);
    fireEvent.change(date, { target: { value: '2026-12-01' } });
    fireEvent.blur(date);
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'monthly' } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Office rent' } });
    fireEvent.change(screen.getByLabelText('Show it under'), { target: { value: 'supplier_payments' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    await waitFor(() => expect(client.createItem).toHaveBeenCalledWith({
      direction: 'payment', amount: 1500.5, date: '2026-12-01', repeat: 'monthly', repeatUntil: null, description: 'Office rent', category: 'supplier_payments',
    }));
  });

  it('pay day: the last working day', async () => {
    render(<Cash13Tab />);
    expect((await screen.findByTestId('payday-words')).textContent).toBe('Salaries are paid on day 25 of the month (not chosen yet).');
    fireEvent.click(screen.getByLabelText('The last working day of the month'));
    fireEvent.click(screen.getByRole('button', { name: 'Save pay day' }));
    await waitFor(() => expect(client.savePayDay).toHaveBeenCalledWith({ kind: 'last_working_day' }));
  });
});
