// Shared pickers (ContactPicker, AccountPicker, ItemPicker, TaxRatePicker) over the real routes' shapes.
// apiFetch is mocked at the boundary; the REAL apiJson/assertOk run on top, so a 4xx/5xx must surface as an error state.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    vi.mocked(apiFetch).mockImplementation(async (u) => route(String(u)));
    render(<ContactPicker kind="supplier" label="Supplier" value={null} onChange={() => {}} />);
    await openPicker('Supplier');
    await screen.findByRole('option', { name: 'Bravo Logistics' });
    const search = screen.getByRole('textbox', { name: 'Search Supplier' });
    for (const q of ['a', 'ac', 'acm']) {
      fireEvent.change(search, { target: { value: q } });
      await new Promise((r) => setTimeout(r, 60)); // keystrokes arrive well inside the 250 ms window
    }
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Bravo Logistics' })).toBeNull());
    const searched = urls().filter((u) => u.includes('q=') && !u.endsWith('q='));
    expect(searched).toHaveLength(1);
    expect(searched[0]).toContain('/api/accounting/suppliers-list');
    expect(searched[0]).toContain('q=acm');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Acme Trading', 'Acme Holdings']);
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
