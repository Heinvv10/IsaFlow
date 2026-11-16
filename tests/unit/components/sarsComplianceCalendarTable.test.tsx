/**
 * The SARS deadlines table's "Mark filed" action: a write role marks an item (POST with the item's
 * type, period end and the optional reference) and undoes a mark (DELETE); a marked item reads
 * "Marked filed" with who, when and the reference, never "Submitted"; a viewer gets no actions.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const role = { companyRole: 'owner' as string | null };
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => role }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  assertOk: async (res: { ok: boolean }, msg: string) => { if (!res.ok) throw new Error(msg); },
  apiErrorMessage: (e: unknown, f: string) => (e instanceof Error ? e.message : f),
}));

import { ComplianceCalendarTable, type CalendarItem } from '@/components/accounting/sars/ComplianceCalendarTable';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const past = iso(new Date(Date.now() - 20 * 86_400_000));
const overdue: CalendarItem = { eventType: 'EMP201_DUE', dueDate: past, periodEnd: '2026-02-28', description: 'EMP201 for February', status: 'overdue' };
const marked: CalendarItem = {
  id: 'm1', eventType: 'VAT201_DUE', dueDate: past, periodEnd: '2026-01-31', description: 'VAT201 for Dec–Jan', status: 'completed',
  filedBy: 'Willie Smit', filedAt: '2026-02-20T09:00:00.000Z', sarsReference: 'EF-77',
};

beforeEach(() => { apiFetch.mockReset(); apiFetch.mockResolvedValue({ ok: true }); role.companyRole = 'owner'; });

describe('ComplianceCalendarTable', () => {
  it('marks an overdue item filed with its type, period end and the reference', async () => {
    const onChanged = vi.fn();
    render(<ComplianceCalendarTable events={[overdue]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /mark filed/i }));
    fireEvent.change(screen.getByLabelText(/sars reference/i), { target: { value: ' EF-1 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = apiFetch.mock.calls[0]!;
    expect(url).toBe('/api/accounting/sars/compliance-filed');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ eventType: 'EMP201_DUE', periodEnd: '2026-02-28', sarsReference: 'EF-1' });
  });

  it('a marked item reads "Marked filed" with who, when and the reference, and is not "Submitted"', () => {
    render(<ComplianceCalendarTable events={[marked]} onChanged={vi.fn()} />);
    expect(screen.getByText('Marked filed')).toBeTruthy();
    expect(screen.getByText(/by Willie Smit on .* · Ref EF-77/)).toBeTruthy();
    expect(screen.queryByText(/submitted/i)).toBeNull();
  });

  it('undo sends DELETE for the item', async () => {
    const onChanged = vi.fn();
    render(<ComplianceCalendarTable events={[marked]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [, init] = apiFetch.mock.calls[0]!;
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ eventType: 'VAT201_DUE', periodEnd: '2026-01-31' });
  });

  it('a refused mark shows the error and does not reload', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500 });
    const onChanged = vi.fn();
    render(<ComplianceCalendarTable events={[overdue]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /mark filed/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it.each([[409], [404]])('a %i reloads the stale row and keeps the message', async (status) => {
    apiFetch.mockResolvedValue({ ok: false, status });
    const onChanged = vi.fn();
    render(<ComplianceCalendarTable events={[marked]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('while one request is in flight, every other action is disabled', async () => {
    let finish: (v: unknown) => void = () => {};
    apiFetch.mockReturnValue(new Promise((r) => { finish = r; }));
    const other: CalendarItem = { ...marked, id: 'm2', eventType: 'EMP201_DUE', periodEnd: '2026-01-31', description: 'EMP201 for January' };
    render(<ComplianceCalendarTable events={[overdue, marked, other]} onChanged={vi.fn()} />);
    const undos = screen.getAllByRole('button', { name: /undo/i });
    fireEvent.click(undos[0]!);
    await waitFor(() => expect((undos[1] as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole('button', { name: /mark filed/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(undos[1]!);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    finish({ ok: true, status: 200 });
    await waitFor(() => expect((undos[1] as HTMLButtonElement).disabled).toBe(false));
  });

  it('two synchronous clicks send one request', async () => {
    apiFetch.mockReturnValue(new Promise(() => {}));
    render(<ComplianceCalendarTable events={[marked]} onChanged={vi.fn()} />);
    const undo = screen.getByRole('button', { name: /undo/i });
    act(() => { undo.click(); undo.click(); });
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('says so when the marks could not be loaded', () => {
    render(<ComplianceCalendarTable events={[overdue]} marksUnavailable onChanged={vi.fn()} />);
    expect(screen.getByText(/filed marks could not be loaded/i)).toBeTruthy();
  });

  it('no notice when the marks were loaded', () => {
    render(<ComplianceCalendarTable events={[overdue]} onChanged={vi.fn()} />);
    expect(screen.queryByText(/filed marks could not be loaded/i)).toBeNull();
  });

  it('a viewer sees no mark or undo action', () => {
    role.companyRole = 'viewer';
    render(<ComplianceCalendarTable events={[overdue, marked]} onChanged={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /mark filed/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
  });

  it('an item due more than 90 days out is not listed', () => {
    const far = { ...overdue, dueDate: iso(new Date(Date.now() + 120 * 86_400_000)), status: 'pending' as const };
    render(<ComplianceCalendarTable events={[far]} onChanged={vi.fn()} />);
    expect(screen.getByText(/no upcoming deadlines/i)).toBeTruthy();
  });
});
