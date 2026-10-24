// Shared pickers (ContactPicker, AccountPicker, ItemPicker, TaxRatePicker) over the real routes' shapes.
// apiFetch is mocked at the boundary; the REAL apiJson/assertOk run on top, so a 4xx/5xx must surface as an error state.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import { ContactPicker, AccountPicker, ItemPicker, TaxRatePicker } from '@/components/ui';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fail = (status = 500) => new Response(JSON.stringify({ success: false, error: { message: 'boom' } }), { status });
const urls = () => vi.mocked(apiFetch).mock.calls.map((c) => String(c[0]));

const CUSTOMERS = [
  { id: 'c1', name: 'Acme Trading' },
  { id: 'c2', name: 'Bravo Logistics' },
  { id: 'c3', name: 'Acme Holdings' },
];
const ACCOUNTS = [
  { id: 'a1', accountCode: '1000', accountName: 'Cash at Bank', accountType: 'asset', accountSubtype: 'bank' },
  { id: 'a2', accountCode: '4000', accountName: 'Sales', accountType: 'revenue' },
  { id: 'a3', accountCode: '6000', accountName: 'Rent', accountType: 'expense' },
  { id: 'a4', accountCode: '6100', accountName: 'Repairs', accountType: 'expense' },
];
const ITEMS = [
  { id: 'i1', code: 'WID-1', description: 'Widget' },
  { id: 'i2', code: 'SVC-1', description: 'Consulting hour' },
];

afterEach(() => { vi.mocked(apiFetch).mockReset(); });

const trigger = (name: string) => screen.getByRole('combobox', { name });
const openPicker = async (name: string) => { fireEvent.click(trigger(name)); return screen.findByRole('listbox'); };

function Controlled(props: { render: (v: string | null, set: (v: string | null) => void) => JSX.Element }) {
  const [v, setV] = useState<string | null>(null);
  return props.render(v, setV);
}

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

describe('AccountPicker', () => {
  const route = async () => ok(ACCOUNTS);

  it('lists GL accounts as "code name"', async () => {
    vi.mocked(apiFetch).mockImplementation(route);
    render(<AccountPicker label="Account" value={null} onChange={() => {}} />);
    await openPicker('Account');
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
      '1000 · Cash at Bank', '4000 · Sales', '6000 · Rent', '6100 · Repairs',
    ]);
  });

  it('filters by account type', async () => {
    vi.mocked(apiFetch).mockImplementation(route);
    render(<AccountPicker label="Expense account" accountType="expense" value={null} onChange={() => {}} />);
    await openPicker('Expense account');
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['6000 · Rent', '6100 · Repairs']);
  });

  it('filters by subtype and by several types', async () => {
    vi.mocked(apiFetch).mockImplementation(route);
    const { unmount } = render(<AccountPicker label="Bank" accountSubtype="bank" value={null} onChange={() => {}} />);
    await openPicker('Bank');
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['1000 · Cash at Bank']);
    unmount();
    render(<AccountPicker label="P&L" accountType={['revenue', 'expense']} value={null} onChange={() => {}} />);
    await openPicker('P&L');
    expect(await screen.findAllByRole('option')).toHaveLength(3);
  });

  it('typeahead matches code or name without refetching the chart', async () => {
    vi.mocked(apiFetch).mockImplementation(route);
    render(<AccountPicker label="Account" value={null} onChange={() => {}} />);
    await openPicker('Account');
    await screen.findAllByRole('option');
    const search = screen.getByRole('textbox', { name: 'Search Account' });
    fireEvent.change(search, { target: { value: '61' } });
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['6100 · Repairs']));
    fireEvent.change(search, { target: { value: 'sales' } });
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['4000 · Sales']));
    expect(urls()).toHaveLength(1);
  });

  it('selects with the keyboard', async () => {
    vi.mocked(apiFetch).mockImplementation(route);
    const onChange = vi.fn();
    render(<Controlled render={(v, set) => <AccountPicker label="Account" value={v} onChange={(val, o) => { set(val); onChange(val, o); }} />} />);
    fireEvent.keyDown(trigger('Account'), { key: 'Enter' });
    await screen.findAllByRole('option');
    const search = screen.getByRole('textbox', { name: 'Search Account' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('a1', expect.objectContaining({ label: '1000 · Cash at Bank' }));
    await waitFor(() => expect(trigger('Account').textContent).toContain('Cash at Bank'));
  });

  it('create-new passes the query', async () => {
    vi.mocked(apiFetch).mockImplementation(route);
    const onCreateNew = vi.fn();
    render(<AccountPicker label="Account" value={null} onChange={() => {}} onCreateNew={onCreateNew} />);
    await openPicker('Account');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Account' }), { target: { value: 'Fuel' } });
    fireEvent.click(await screen.findByRole('option', { name: /Create new account.*Fuel/ }));
    expect(onCreateNew).toHaveBeenCalledWith('Fuel');
  });

  it('shows an error when the chart fails to load, and recovers on reopen', async () => {
    vi.mocked(apiFetch).mockImplementationOnce(async () => fail(503));
    render(<AccountPicker label="Account" value={null} onChange={() => {}} />);
    fireEvent.click(trigger('Account'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No options')).toBeNull();
    fireEvent.click(trigger('Account')); // close
    vi.mocked(apiFetch).mockImplementation(route);
    fireEvent.click(trigger('Account')); // reopen: refetches, not a cached failure
    expect(await screen.findAllByRole('option')).toHaveLength(4);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ItemPicker', () => {
  const route = async (u: unknown) => {
    const q = (new URL(String(u), 'http://x').searchParams.get('q') ?? '').toLowerCase();
    return ok(ITEMS.filter((i) => `${i.code} ${i.description}`.toLowerCase().includes(q)));
  };

  it('loads active items and searches server-side', async () => {
    vi.mocked(apiFetch).mockImplementation(route);
    render(<ItemPicker label="Item" value={null} onChange={() => {}} />);
    await openPicker('Item');
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['WID-1 · Widget', 'SVC-1 · Consulting hour']);
    expect(urls()[0]).toContain('/api/accounting/items?');
    expect(urls()[0]).toContain('active=true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Item' }), { target: { value: 'consult' } });
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['SVC-1 · Consulting hour']));
    expect(urls().at(-1)).toContain('q=consult');
  });

  it('selects with the keyboard and offers create-new', async () => {
    vi.mocked(apiFetch).mockImplementation(route);
    const onChange = vi.fn();
    const onCreateNew = vi.fn();
    render(<ItemPicker label="Item" value={null} onChange={onChange} onCreateNew={onCreateNew} />);
    fireEvent.keyDown(trigger('Item'), { key: 'ArrowDown' });
    await screen.findAllByRole('option', { name: /Widget/ });
    const search = screen.getByRole('textbox', { name: 'Search Item' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('i1', expect.objectContaining({ value: 'i1' }));

    fireEvent.keyDown(trigger('Item'), { key: 'ArrowDown' });
    await screen.findAllByRole('option', { name: /Widget/ });
    const s2 = screen.getByRole('textbox', { name: 'Search Item' });
    // down past the 2 items reaches "Create new item" and Enter on it creates
    for (let n = 0; n < 3; n++) fireEvent.keyDown(s2, { key: 'ArrowDown' });
    fireEvent.keyDown(s2, { key: 'Enter' });
    expect(onCreateNew).toHaveBeenCalledWith('');
  });

  it('shows an error when items fail to load', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => fail(500));
    render(<ItemPicker label="Item" value={null} onChange={() => {}} />);
    fireEvent.click(trigger('Item'));
    expect((await screen.findByRole('alert')).textContent).toContain('boom');
    expect(screen.queryByText('No options')).toBeNull();
  });
});

describe('TaxRatePicker', () => {
  it('lists the VAT codes with the standard rate, with no network call', async () => {
    render(<TaxRatePicker label="VAT" value={null} onChange={() => {}} />);
    await openPicker('VAT');
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['No VAT', 'Standard 15%', 'Zero Rated', 'Exempt']);
    expect(urls()).toHaveLength(0);
  });

  it('filters by typeahead, restricts codes, and selects with the keyboard', async () => {
    const onChange = vi.fn();
    render(<TaxRatePicker label="VAT" codes={['standard', 'zero_rated', 'exempt']} value={null} onChange={onChange} />);
    fireEvent.keyDown(trigger('VAT'), { key: 'Enter' });
    await screen.findAllByRole('option');
    const search = screen.getByRole('textbox', { name: 'Search VAT' });
    fireEvent.change(search, { target: { value: 'zero' } });
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Zero Rated']));
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('zero_rated', expect.objectContaining({ label: 'Zero Rated' }));
  });

  it('displays the label of the current value without opening', () => {
    render(<TaxRatePicker label="VAT" value="standard" onChange={() => {}} />);
    expect(trigger('VAT').textContent).toContain('Standard 15%');
  });

  it('create-new is available and passes the query', async () => {
    const onCreateNew = vi.fn();
    render(<TaxRatePicker label="VAT" value={null} onChange={() => {}} onCreateNew={onCreateNew} />);
    await openPicker('VAT');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search VAT' }), { target: { value: 'reduced' } });
    fireEvent.click(await screen.findByRole('option', { name: /Create new tax rate.*reduced/ }));
    expect(onCreateNew).toHaveBeenCalledWith('reduced');
  });
});
