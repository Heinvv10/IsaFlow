/**
 * Every control of a supplier-bill line, in BOTH layouts (the wide table and the stacked cards): found by its
 * accessible name, each edit reaches onUpdate with the right key, field and value, Remove reaches onRemove, and the
 * VAT warning, "Supplier default" labels, the CC1 text and the total are on show.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve, empty500 } from '../helpers/d2R3a6';
import { accounts, coding, line, stubLayout } from '../helpers/billLineHarness';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { BillLineItemsTable, type BillLineItem } from '@/components/accounting/suppliers/BillLineItemsTable';

useApiJsonOverMock();

const LADDER = { items: [
  { id: 'f1', code: 'F1', name: 'Fibre', ccType: 'cc1', isActive: true, fnoCode: 'F1' },
  { id: 'p1', code: 'P1', name: 'Project', ccType: 'cc2', isActive: true, fnoCode: 'F1' },
] };
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(log.warn).mockReset(); serve(on('GET', 'detail=dimensions', () => ok(LADDER))); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const LAYOUTS = [['table', 1200], ['stacked cards', 500]] as const;

function mount(width: number, lines: BillLineItem[], extra: Partial<React.ComponentProps<typeof BillLineItemsTable>> = {}) {
  const layout = stubLayout(width);
  const onUpdate = vi.fn(); const onRemove = vi.fn();
  render(<BillLineItemsTable lines={lines} glAccounts={accounts} onAdd={vi.fn()} onUpdate={onUpdate} onRemove={onRemove}
    codingOptions={coding()} {...extra} />);
  layout.set(width);
  return { onUpdate, onRemove, layout };
}
const toggle = () => fireEvent.click(screen.getByRole('button', { name: /Dimensions$/ }));
/** Opens the Dimensions columns unless a line's own CC2 already opened them. */
const dims = () => { if (screen.getByRole('button', { name: /Dimensions$/ }).getAttribute('aria-expanded') === 'false') toggle(); };
const pick = (combo: string, option: string) => {
  fireEvent.click(screen.getAllByRole('combobox', { name: combo })[0]!);
  fireEvent.click(screen.getByRole('option', { name: option }));
};

describe.each(LAYOUTS)('line controls in the %s layout', (name, width) => {
  it('is the layout under test', () => {
    mount(width, [line('a')]);
    expect(Boolean(screen.queryByRole('table'))).toBe(name === 'table');
  });

  it('reports every edit with the line key, the field and the value', () => {
    const { onUpdate, onRemove } = mount(width, [line('a', { quantity: 2, unitPrice: 10 }), line('b')]);
    dims();
    fireEvent.change(screen.getAllByPlaceholderText('Item description')[0]!, { target: { value: 'Widgets' } });
    expect(onUpdate).toHaveBeenLastCalledWith('a', 'description', 'Widgets');
    fireEvent.change(screen.getByLabelText('Line 1 account'), { target: { value: 'a1' } });
    expect(onUpdate).toHaveBeenLastCalledWith('a', 'glAccountId', 'a1');
    pick('CC2 project', 'P1 Project');
    expect(onUpdate).toHaveBeenLastCalledWith('a', 'cc2Id', 'p1');
    pick('BU', 'B1 Unit');
    expect(onUpdate).toHaveBeenLastCalledWith('a', 'buId', 'b1');
    fireEvent.change(screen.getByLabelText('Line 1 quantity'), { target: { value: '3' } });
    expect(onUpdate).toHaveBeenLastCalledWith('a', 'quantity', 3);
    fireEvent.change(screen.getByLabelText('Line 1 unit price'), { target: { value: '12.5' } });
    expect(onUpdate).toHaveBeenLastCalledWith('a', 'unitPrice', 12.5);
    fireEvent.click(screen.getByRole('button', { name: 'Remove line 2' }));
    expect(onRemove).toHaveBeenCalledWith('b');
  });

  it('shows the line total', () => {
    mount(width, [line('a', { quantity: 2, unitPrice: 10 })]);
    expect(screen.getByText(/20\.00/)).toBeTruthy();
  });

  it('shows the no-VAT warning for a line on a non-supply account that carries tax', () => {
    mount(width, [line('a', { taxRate: 15, glAccountId: 'a2' })]);
    expect(screen.getByText(/no supply, so no VAT/)).toBeTruthy();
  });

  it('labels the blank choice of a defaulted CC2 and BU as the supplier default', () => {
    mount(width, [line('a')], { supplierDefaults: { cc2Id: 'p1', buId: 'b1', note: '', status: 'ready' } });
    dims();
    expect(screen.getAllByText('Supplier default')).toHaveLength(2);
  });

  it('shows the CC1 the server will apply, read from the cost-centre ladder', async () => {
    mount(width, [line('a', { cc2Id: 'p1' })]);
    dims();
    await waitFor(() => expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: F1 Fibre'));
  });

  it('shows the supplier default FNO for a line that names no CC, and the default CC2 FNO ahead of it', async () => {
    mount(width, [line('a')], { supplierDefaults: { cc2Id: 'p1', buId: '', cc1Id: 'f1', note: '', status: 'ready' } });
    dims();
    await waitFor(() => expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: F1 Fibre'));
  });

  it('says loading, never "no CC1", while the ladder is on its way', async () => {
    serve(() => new Promise<Response>(() => undefined));
    mount(width, [line('a', { cc2Id: 'p1' })]);
    dims();
    expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: loading…');
  });

  it('says it could not be loaded when the read fails, logs it, and leaves the form usable', async () => {
    serve(on('GET', 'detail=dimensions', () => empty500()));
    const { onUpdate } = mount(width, [line('a', { cc2Id: 'p1' })]);
    dims();
    await waitFor(() => expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: could not be loaded'));
    expect(log.warn).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Line 1 quantity'), { target: { value: '4' } });
    expect(onUpdate).toHaveBeenLastCalledWith('a', 'quantity', 4);
  });

  it('names the description and takes a quantity to 2 decimals, no less than 0.01', () => {
    mount(width, [line('a', { quantity: 1.25 })]);
    expect(screen.getByRole('textbox', { name: 'Line 1 description' })).toBeTruthy();
    const qty = screen.getByRole('textbox', { name: 'Line 1 quantity' }) as HTMLInputElement;
    expect([qty.value, qty.validity.valid]).toEqual(['1.25', true]);
    fireEvent.change(qty, { target: { value: '0' } });
    expect(qty.validity.valid).toBe(false); // below the 0.01 minimum
    fireEvent.change(qty, { target: { value: '1.255' } });
    expect(qty.value).toBe('0'); // a third decimal is refused
  });

  it('is a tab stop only as a table, where it scrolls sideways', () => {
    mount(width, [line('a')]);
    expect(screen.getByRole('region', { name: 'Invoice lines' }).getAttribute('tabindex')).toBe(name === 'table' ? '0' : null);
  });

  it('shows the CC1 read-only: no control is named for it and no edit in the line sets cc1Id', async () => {
    const { onUpdate } = mount(width, [line('a', { cc2Id: 'p1' })]);
    dims();
    await waitFor(() => expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: F1 Fibre'));
    const region = screen.getByRole('region', { name: 'Invoice lines' });
    for (const role of ['textbox', 'combobox', 'spinbutton', 'listbox', 'checkbox'] as const) {
      expect(within(region).queryAllByRole(role, { name: /CC1|FNO/i }), role).toHaveLength(0);
    }
    region.querySelectorAll('input, select, textarea').forEach((el) => fireEvent.change(el, { target: { value: '7' } }));
    pick('CC2 project', 'P1 Project');
    pick('BU', 'B1 Unit');
    expect(onUpdate).toHaveBeenCalled();
    expect(onUpdate.mock.calls.filter(([, field]) => field === 'cc1Id')).toEqual([]);
  });

  it.each(['loading', 'failed'] as const)('says the CC1 is unknown, never a value or a dash, while the supplier defaults are %s', async (status) => {
    mount(width, [line('a'), line('b', { cc2Id: 'p1' })], { supplierDefaults: { cc2Id: '', buId: '', cc1Id: 'f1', note: '', status } });
    dims();
    // Line 1 names no CC, so the server applies the supplier's default; line 2's own CC2 decides its FNO.
    await waitFor(() => expect(screen.getAllByTestId('line-cc1').map((e) => e.textContent))
      .toEqual(['CC1: unknown, applied on save', 'CC1: F1 Fibre']));
  });

  it('marks an inactive FNO as one the server will refuse', async () => {
    serve(on('GET', 'detail=dimensions', () => ok({ items: [
      { id: 'f9', code: 'F9', name: 'Old', ccType: 'cc1', isActive: false, fnoCode: 'F9' },
      { id: 'p9', code: 'P9', name: 'Proj', ccType: 'cc2', isActive: true, fnoCode: 'F9' },
    ] })));
    mount(width, [line('a', { cc2Id: 'p9' })]);
    dims();
    await waitFor(() => expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: F9 Old (inactive, cannot be saved)'));
  });
});

describe('the cost-centre ladder is read once', () => {
  it('does not read it again when Dimensions is toggled off and on', async () => {
    mount(1200, [line('a', { cc2Id: 'p1' })]);
    const reads = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('detail=dimensions')).length;
    toggle(); // the line carries a CC2, so Dimensions is already open: this closes it
    toggle();
    await waitFor(() => expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: F1 Fibre'));
    toggle(); toggle();
    expect(reads()).toBe(1);
  });

  it('offers Retry when the read fails, and Retry reads it again', async () => {
    let calls = 0;
    serve((url) => (url.includes('detail=dimensions') ? (++calls === 1 ? empty500() : ok(LADDER)) : undefined));
    mount(1200, [line('a', { cc2Id: 'p1' })]);
    await waitFor(() => expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: could not be loaded'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading the CC1s' }));
    await waitFor(() => expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: F1 Fibre'));
    expect(calls).toBe(2);
    expect(screen.queryByRole('button', { name: 'Retry loading the CC1s' })).toBeNull();
  });

  it('reads it again after a failure the next time Dimensions opens', async () => {
    let calls = 0;
    serve((url) => (url.includes('detail=dimensions') ? (++calls === 1 ? empty500() : ok(LADDER)) : undefined));
    mount(1200, [line('a', { cc2Id: 'p1' })]);
    await waitFor(() => expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: could not be loaded'));
    toggle(); toggle();
    await waitFor(() => expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: F1 Fibre'));
    expect(calls).toBe(2);
  });
});

describe('stacked cards: one column under 420', () => {
  const grids = (w: number) => {
    mount(w, [line('a')]);
    dims();
    return {
      pair: screen.getByText('CC2 project', { selector: 'span' }).closest('.grid')!.className,
      amounts: screen.getByText('Qty').closest('.grid')!.className,
    };
  };
  it('puts CC2 and BU, and Qty / Unit Price / Total, on shared rows from 420 up', () => {
    const g = grids(420);
    expect(g.pair).toContain('grid-cols-2');
    expect(g.amounts).toContain('grid-cols-3');
  });
  it('puts each on its own row under 420', () => {
    const g = grids(419);
    expect(g.pair).toContain('grid-cols-1');
    expect(g.amounts).toContain('grid-cols-2');
  });
  it('keeps the total at the right edge of the card when the amounts wrap under 420', () => {
    mount(419, [line('a')]);
    expect(screen.getByText('Total').parentElement!.className).toContain('col-start-2');
  });
  it('gives the description its own full-width row above the coding', () => {
    mount(500, [line('a')]);
    const card = screen.getByPlaceholderText('Item description').closest('li')!;
    expect(within(card).getByText('Line 1 description')).toBeTruthy();
  });
});
