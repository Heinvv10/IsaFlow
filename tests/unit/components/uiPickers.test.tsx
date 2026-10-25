// Shared pickers (ContactPicker, AccountPicker, ItemPicker, TaxRatePicker) over the real routes' shapes.
// apiFetch is mocked at the boundary; the REAL apiJson/assertOk run on top, so a 4xx/5xx must surface as an error state.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import { ContactPicker, ItemPicker } from '@/components/ui';
import { ok, fail, urls, CUSTOMERS, ITEMS } from '../helpers/pickerFixtures';


afterEach(() => { vi.mocked(apiFetch).mockReset(); });

const trigger = (name: string) => screen.getByRole('combobox', { name });
const openPicker = async (name: string) => { fireEvent.click(trigger(name)); return screen.findByRole('listbox'); };

describe('ContactPicker', () => {
  function route(url: string): Response {
    const q = (new URL(url, 'http://x').searchParams.get('q') ?? '').toLowerCase();
    const rows = CUSTOMERS.filter((c) => c.name.toLowerCase().includes(q));
    return ok(url.includes('suppliers-list') ? { suppliers: rows, total: rows.length } : rows);
  }

  it('renders its label as the accessible name and loads customers when opened', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => route(String(u)));
    render(<ContactPicker kind="customer" label="Customer" value={null} onChange={() => {}} />);
    expect(trigger('Customer')).toBeTruthy();
    expect(urls()).toHaveLength(0); // lazy: nothing fetched until opened
    const list = await openPicker('Customer');
    expect(await within(list).findByRole('option', { name: 'Bravo Logistics' })).toBeTruthy();
    expect(urls()[0]).toMatch(/^\/api\/accounting\/customers\?/);
  });

  it('searches the supplier endpoint server-side, debounced to one request for fast typing', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(apiFetch).mockImplementation(async (u) => route(String(u)));
      render(<ContactPicker kind="supplier" label="Supplier" value={null} onChange={() => {}} />);
      fireEvent.click(trigger('Supplier'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole('option', { name: 'Bravo Logistics' })).toBeTruthy();
      const search = screen.getByRole('textbox', { name: 'Search Supplier' });
      for (const q of ['a', 'ac', 'acm']) {
        fireEvent.change(search, { target: { value: q } });
        await act(async () => { await vi.advanceTimersByTimeAsync(100); }); // keystrokes arrive inside the 250 ms window
      }
      expect(urls().filter((u) => /q=.+/.test(u))).toHaveLength(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      const searched = urls().filter((u) => /q=.+/.test(u));
      expect(searched).toHaveLength(1);
      expect(searched[0]).toContain('/api/accounting/suppliers-list');
      expect(searched[0]).toContain('q=acm');
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Acme Trading', 'Acme Holdings']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('selects with the keyboard and reports value and option', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => route(String(u)));
    const onChange = vi.fn();
    render(<ContactPicker kind="customer" label="Customer" value={null} onChange={onChange} />);
    fireEvent.keyDown(trigger('Customer'), { key: 'ArrowDown' });
    await screen.findByRole('option', { name: 'Bravo Logistics' });
    const search = screen.getByRole('textbox', { name: 'Search Customer' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search.getAttribute('aria-activedescendant')).toContain('c2');
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('c2', expect.objectContaining({ value: 'c2', label: 'Bravo Logistics' }));
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('shows the label of a preselected value that is not in the loaded page', () => {
    render(<ContactPicker kind="customer" label="Customer" value="zz" valueLabel="Zeta Corp" onChange={() => {}} />);
    expect(trigger('Customer').textContent).toContain('Zeta Corp');
  });

  it('offers "Create new" with the typed query and does not own creation', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => route(String(u)));
    const onCreateNew = vi.fn();
    render(<ContactPicker kind="customer" label="Customer" value={null} onChange={() => {}} onCreateNew={onCreateNew} />);
    await openPicker('Customer');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Customer' }), { target: { value: 'Nova' } });
    const create = await screen.findByRole('option', { name: /Create new customer.*Nova/ });
    fireEvent.click(create);
    expect(onCreateNew).toHaveBeenCalledWith('Nova');
  });

  it('does not render a create action when onCreateNew is absent', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => route(String(u)));
    render(<ContactPicker kind="customer" label="Customer" value={null} onChange={() => {}} />);
    await openPicker('Customer');
    await screen.findByRole('option', { name: 'Bravo Logistics' });
    expect(screen.queryByRole('option', { name: /Create new/ })).toBeNull();
  });

  it('shows an error, not an empty list, when the API fails', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => fail(500));
    render(<ContactPicker kind="customer" label="Customer" value={null} onChange={() => {}} onCreateNew={() => {}} />);
    fireEvent.click(trigger('Customer'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('boom');
    expect(screen.queryByText('No options')).toBeNull();
    expect(screen.queryByRole('option')).toBeNull(); // no create action either: the list is unknown
  });

  it('shows an error when a 200 is not the expected shape', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok({ nope: true }));
    render(<ContactPicker kind="customer" label="Customer" value={null} onChange={() => {}} />);
    fireEvent.click(trigger('Customer'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/customers/i);
  });
});

const UUID_C = '22222222-2222-4222-8222-222222222222';
const UUID_S = '33333333-3333-4333-8333-333333333333';
const many = (n: number, extra: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `Contact ${String(i).padStart(2, '0')}`, ...extra }));

describe('ContactPicker paging and hints', () => {
  it('opens with a 20-row page and says so, then searches with a 50-row page', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => ok(many(String(u).includes('limit=20') ? 20 : 50)));
    render(<ContactPicker kind="customer" label="Customer" value={null} onChange={() => {}} />);
    fireEvent.click(trigger('Customer'));
    await screen.findAllByRole('option');
    expect(urls()[0]).toContain('limit=20');
    expect(screen.getAllByRole('option')).toHaveLength(20);
    expect(screen.getByRole('status').textContent).toBe('Showing the first 20 - type to search');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Customer' }), { target: { value: 'con' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(50));
    expect(urls().at(-1)).toContain('limit=50');
    expect(screen.getByRole('status').textContent).toBe('Showing the first 50 - keep typing to narrow');
  });

  it('shows no hint when the page is not full, and uses the suppliers total', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok(many(3)));
    const { unmount } = render(<ContactPicker kind="customer" label="Customer" value={null} onChange={() => {}} />);
    fireEvent.click(trigger('Customer'));
    await screen.findAllByRole('option');
    expect(screen.queryByRole('status')).toBeNull();
    unmount();
    vi.mocked(apiFetch).mockImplementation(async () => ok({ suppliers: many(3), total: 400 }));
    render(<ContactPicker kind="supplier" label="Supplier" value={null} onChange={() => {}} />);
    fireEvent.click(trigger('Supplier'));
    await screen.findAllByRole('option');
    expect(screen.getByRole('status').textContent).toContain('Showing the first 3');
  });

  it('offers active contacts only', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok([{ id: 'a', name: 'Active Co', is_active: true }, { id: 'b', name: 'Dormant Co', is_active: false }]));
    render(<ContactPicker kind="customer" label="Customer" value={null} onChange={() => {}} />);
    fireEvent.click(trigger('Customer'));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Active Co']);
  });
});

describe('ContactPicker names a preselected id', () => {
  it('looks a customer up by id when it is not in the page, even if inactive', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok({ id: UUID_C, name: 'Zeta Corp', is_active: false }));
    render(<ContactPicker kind="customer" label="Customer" value={UUID_C} onChange={() => {}} />);
    await waitFor(() => expect(trigger('Customer').textContent).toContain('Zeta Corp'));
    expect(urls()).toEqual([`/api/accounting/customers?id=${UUID_C}`]);
  });

  it('uses the suppliers route for suppliers', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok({ id: UUID_S, name: 'Omega Supplies' }));
    render(<ContactPicker kind="supplier" label="Supplier" value={UUID_S} onChange={() => {}} />);
    await waitFor(() => expect(trigger('Supplier').textContent).toContain('Omega Supplies'));
    expect(urls()).toEqual([`/api/accounting/suppliers-list?id=${UUID_S}`]);
  });

  it('says so when the record no longer exists, and does not look up a non-UUID', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => fail(404));
    const { unmount } = render(<ContactPicker kind="customer" label="Customer" value={UUID_C} onChange={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toContain('no longer exists');
    unmount();
    vi.mocked(apiFetch).mockClear();
    render(<ContactPicker kind="customer" label="Customer" value="not-a-uuid" onChange={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(urls()).toEqual([]);
  });

  it('a failed lookup is shown under the field (not mistaken for "not found")', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => fail(500));
    render(<ContactPicker kind="customer" label="Customer" value={UUID_C} onChange={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toContain('boom');
  });

  it('an explicit valueLabel skips the lookup', async () => {
    render(<ContactPicker kind="customer" label="Customer" value={UUID_C} valueLabel="Given Co" onChange={() => {}} />);
    expect(trigger('Customer').textContent).toContain('Given Co');
    expect(urls()).toEqual([]);
  });
});

describe('RemotePicker remembers what was picked', () => {
  it('keeps the picked label after a later search no longer lists it', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => {
      const q = (new URL(String(u), 'http://x').searchParams.get('q') ?? '').toLowerCase();
      return ok(CUSTOMERS.filter((c) => c.name.toLowerCase().includes(q)));
    });
    function Harness() {
      const [v, setV] = useState<string | null>(null);
      return <ContactPicker kind="customer" label="Customer" value={v} onChange={setV} />;
    }
    render(<Harness />);
    fireEvent.click(trigger('Customer'));
    fireEvent.click(await screen.findByRole('option', { name: 'Bravo Logistics' }));
    await waitFor(() => expect(trigger('Customer').textContent).toContain('Bravo Logistics'));
    fireEvent.click(trigger('Customer'));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search Customer' }), { target: { value: 'acme' } });
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Bravo Logistics' })).toBeNull());
    expect(trigger('Customer').textContent).toContain('Bravo Logistics');
  });
});

describe('combobox ARIA contract (axe: aria-required-attr, aria-valid-attr-value)', () => {
  it('points aria-controls at an element that exists while open, in every state, and omits it when closed', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(apiFetch).mockImplementation(async () => { await gate; return ok(ITEMS); });
    render(<ItemPicker label="Item" value={null} onChange={() => {}} />);
    expect(trigger('Item').getAttribute('aria-controls')).toBeNull();
    fireEvent.click(trigger('Item'));
    // loading: no options yet
    const id = trigger('Item').getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    release();
    await screen.findAllByRole('option');
    expect(document.getElementById(id!)?.getAttribute('role')).toBe('listbox');
    expect(screen.getByRole('textbox', { name: 'Search Item' }).getAttribute('aria-controls')).toBe(id);
  });
});
