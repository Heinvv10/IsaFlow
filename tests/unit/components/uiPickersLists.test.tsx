// AccountPicker, ItemPicker and TaxRatePicker over the real routes' shapes (ContactPicker: uiPickers.test.tsx).
// apiFetch is mocked at the boundary; the REAL apiJson/assertOk run on top, so a 4xx/5xx must surface as an error state.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import { AccountPicker, ItemPicker, TaxRatePicker } from '@/components/ui';
import { ok, fail, urls, ACCOUNTS, ITEMS } from '../helpers/pickerFixtures';


afterEach(() => { vi.mocked(apiFetch).mockReset(); });

const trigger = (name: string) => screen.getByRole('combobox', { name });
const openPicker = async (name: string) => { fireEvent.click(trigger(name)); return screen.findByRole('listbox'); };

function Controlled(props: { render: (v: string | null, set: (v: string | null) => void) => JSX.Element }) {
  const [v, setV] = useState<string | null>(null);
  return props.render(v, setV);
}

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

  it('with valueKey="code" carries the code, names the current value on mount, and applies refine', async () => {
    vi.mocked(apiFetch).mockImplementation(route);
    const onChange = vi.fn();
    render(<AccountPicker label="Account" valueKey="code" value="6100" onChange={onChange} refine={(rows) => rows.filter((r) => r.accountType === 'expense')} />);
    await waitFor(() => expect(trigger('Account').textContent).toContain('6100 · Repairs'));
    fireEvent.click(trigger('Account'));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['6000 · Rent', '6100 · Repairs']);
    fireEvent.click(screen.getByRole('option', { name: '6000 · Rent' }));
    expect(onChange).toHaveBeenCalledWith('6000', expect.objectContaining({ value: '6000' }));
  });

  it('typing while the chart is still loading waits for it instead of failing', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => {
      await gate;
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return ok(ACCOUNTS);
    });
    render(<AccountPicker label="Account" value={null} onChange={() => {}} />);
    fireEvent.click(trigger('Account'));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search Account' }), { target: { value: 'sales' } });
    await new Promise((r) => setTimeout(r, 400)); // the debounced search fires while the first load is still in flight
    release();
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['4000 · Sales']));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows at once, under the field, a failure to name the current value', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => fail(500));
    render(<AccountPicker label="Account" valueKey="code" value="6100" onChange={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toContain('boom');
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
