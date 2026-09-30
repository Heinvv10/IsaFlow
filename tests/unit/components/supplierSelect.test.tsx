// PUR-01: suppliers-list answers 25 rows by default, so a picker fed by the bare
// call cannot reach supplier #26. SupplierSelect must search server-side and
// resolve a preselected id that is not in the first page.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useState } from 'react';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { SupplierSelect } from '@/components/accounting/supplier-invoices/SupplierSelect';

const ALL = Array.from({ length: 58 }, (_, i) => ({ id: `id-${i + 1}`, name: `Supplier ${String(i + 1).padStart(2, '0')}` }));

/** Mirrors the route: name-ordered, ?limit default 25, ?q substring, ?id single row. */
function fakeRoute(url: string): Response {
  const u = new URL(url, 'http://x');
  const id = u.searchParams.get('id');
  if (id) {
    const s = ALL.find((r) => r.id === id);
    return new Response(JSON.stringify(s ? { success: true, data: s } : { success: false }), { status: s ? 200 : 404 });
  }
  const q = (u.searchParams.get('q') ?? '').toLowerCase();
  const limit = Number(u.searchParams.get('limit') ?? '25');
  const rows = ALL.filter((r) => r.name.toLowerCase().includes(q)).slice(0, limit);
  return new Response(JSON.stringify({ success: true, data: { suppliers: rows, total: rows.length } }), { status: 200 });
}

afterEach(() => { vi.mocked(apiFetch).mockReset(); });

function Harness({ initial = '', onPick, required }: { initial?: string; onPick?: (id: string) => void; required?: boolean }) {
  const [id, setId] = useState(initial);
  return <SupplierSelect name="supplierId" required={required} value={id} onChange={(v) => { setId(v); onPick?.(v); }} />;
}

describe('SupplierSelect', () => {
  it('finds and selects supplier #26 (beyond the 25-row default page)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => fakeRoute(String(url)));
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    await waitFor(() => screen.getByRole('button', { name: 'Supplier 25' }), { timeout: 2000 });
    expect(screen.queryByRole('button', { name: 'Supplier 26' })).toBeNull();

    fireEvent.change(input, { target: { value: 'Supplier 26' } });
    const option = await screen.findByRole('button', { name: 'Supplier 26' }, { timeout: 2000 });
    fireEvent.click(option);

    expect(onPick).toHaveBeenLastCalledWith('id-26');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Supplier 26');
  });

  it('shows the name of a preselected supplier that is not in the first page', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => fakeRoute(String(url)));
    render(<Harness initial="id-40" />);
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Supplier 40'), { timeout: 2000 });
  });

  it('resolves a preselected supplier under React.StrictMode (effects run twice)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => fakeRoute(String(url)));
    render(<StrictMode><Harness initial="id-40" /></StrictMode>);
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Supplier 40'), { timeout: 2000 });
  });

  it('clears and flags an id the server says does not exist (404)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => fakeRoute(String(url)));
    const onPick = vi.fn();
    render(<Harness initial="gone" onPick={onPick} required />);
    expect((await screen.findByRole('alert', {}, { timeout: 2000 })).textContent).toMatch(/not found/i);
    expect(onPick).toHaveBeenLastCalledWith('');
    expect((screen.getByRole('textbox') as HTMLInputElement).checkValidity()).toBe(false);
  });

  it('clears an id when the lookup is ok but returns no row', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }));
    const onPick = vi.fn();
    render(<Harness initial="gone" onPick={onPick} />);
    expect((await screen.findByRole('alert', {}, { timeout: 2000 })).textContent).toMatch(/not found/i);
    expect(onPick).toHaveBeenLastCalledWith('');
  });

  it.each([
    ['a 500', () => Promise.resolve(new Response('{}', { status: 500 }))],
    ['a network error', () => Promise.reject(new Error('network'))],
  ])('keeps the saved id on %s and offers a retry that recovers', async (_label, fail) => {
    let broken = true;
    vi.mocked(apiFetch).mockImplementation(async (url) => (broken ? fail() : fakeRoute(String(url))));
    const onPick = vi.fn();
    render(<Harness initial="id-3" onPick={onPick} required />);
    expect((await screen.findByRole('alert', {}, { timeout: 2000 })).textContent).toMatch(/couldn.t load supplier/i);
    expect(onPick).not.toHaveBeenCalled(); // the saved supplier was not wiped
    expect((screen.getByRole('textbox') as HTMLInputElement).checkValidity()).toBe(true);
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Supplier 03'), { timeout: 2000 });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('after a not-found id, picking a supplier makes a required picker valid again', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => fakeRoute(String(url)));
    render(<Harness initial="gone" required />);
    await screen.findByRole('alert', {}, { timeout: 2000 });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.checkValidity()).toBe(false);
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole('button', { name: 'Supplier 02' }, { timeout: 2000 }));
    expect((screen.getByRole('textbox') as HTMLInputElement).checkValidity()).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an optional picker is never invalid, and its not-found notice can be cleared', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => fakeRoute(String(url)));
    render(<Harness initial="gone" />);
    await screen.findByRole('alert', {}, { timeout: 2000 });
    expect((screen.getByRole('textbox') as HTMLInputElement).checkValidity()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('required blocks native validity until a supplier is picked, typed text alone is not enough', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => fakeRoute(String(url)));
    render(<Harness required />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.checkValidity()).toBe(false);
    fireEvent.change(input, { target: { value: 'Supplier 2' } });
    expect(input.checkValidity()).toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Supplier 26' }, { timeout: 2000 }));
    expect((screen.getByRole('textbox') as HTMLInputElement).checkValidity()).toBe(true);
  });

  it('does not fetch on mount, only when the user focuses or types', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => fakeRoute(String(url)));
    render(<><Harness /><Harness /><Harness /></>);
    await new Promise((r) => setTimeout(r, 400));
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.focus(screen.getAllByRole('textbox')[0]!);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });
});
