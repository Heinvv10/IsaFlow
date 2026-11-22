// Currencies: the currency table becomes labelled cards below lg; tabs, refresh, add form and row action are 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => {
    const u = String(url);
    const data = u.includes('accounting-settings') ? { value: 'ZAR' }
      : u.includes('exchange-rates') ? []
        : [{ code: 'ZAR', name: 'Rand', symbol: 'R', decimalPlaces: 2, isActive: true }, { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isActive: true }];
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));

import Page from '../../../pages/accounting/currencies/index';

afterEach(cleanup);
const HEADS = ['Code', 'Name', 'Symbol', 'Decimals', 'Status', ''];

describe('Currencies on touch', () => {
  it('turns the currency table into labelled cards; the code cell heads the card and the action cell has no label', async () => {
    const { container } = render(<Page />);
    await screen.findAllByText('US Dollar');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll(':scope > tbody > tr')];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect([...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual([null, 'Name', 'Symbol', 'Decimals', 'Status', null]);
    // The reporting currency has no action, so its last cell is empty: on a card it must vanish (`!`: the card CSS on td out-ranks a plain utility).
    for (const row of rows) expect(row.lastElementChild!.className.split(' ')).toContain('max-lg:empty:!hidden');
  });

  it('makes refresh, both tabs, Add Currency and the row action 44px', async () => {
    render(<Page />);
    await screen.findAllByText('US Dollar');
    for (const el of [screen.getByTitle('Refresh'), screen.getByRole('button', { name: 'Currencies' }), screen.getByRole('button', { name: 'Exchange Rates' }),
      screen.getByRole('button', { name: /Add Currency/ }), screen.getByRole('button', { name: /Deactivate/ })]) {
      expect(el.className, el.textContent ?? '').toContain('max-lg:min-h-11');
    }
    // The row action is the card's last line: it spans the card instead of floating at the right edge.
    expect(screen.getByRole('button', { name: /Deactivate/ }).className).toContain('max-lg:w-full');
  });

  it('makes every field and button of the add form 44px', async () => {
    render(<Page />);
    await screen.findAllByText('US Dollar');
    fireEvent.click(screen.getByRole('button', { name: /Add Currency/ }));
    const form = screen.getByText('New Currency').parentElement!;
    const controls = [...form.querySelectorAll('input, button')];
    expect(controls).toHaveLength(6); // code, name, symbol, decimals, cancel, save
    for (const c of controls) expect(c.className, c.outerHTML.slice(0, 60)).toContain('max-lg:min-h-11');
  });
});
