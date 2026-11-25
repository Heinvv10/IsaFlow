// Item adjustments: the stock table becomes labelled cards below lg; the button and form controls are 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: [{ id: 'i1', item_code: 'WID-1', item_name: 'Widget', category: 'Parts', current_quantity: 12, uom: 'ea' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/item-adjustments';

afterEach(cleanup);
const HEADS = ['Code', 'Item', 'Category', 'On Hand', 'UOM'];

describe('Item adjustments on touch', () => {
  it('turns the table into labelled cards whose labels equal the headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Widget');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(HEADS);
    const row = table.querySelector(':scope > tbody > tr')!;
    expect([...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('makes New Adjustment and every form control 44px on phones, and the header wraps', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Widget');
    const open = screen.getByRole('button', { name: /New Adjustment/ });
    expect(open.className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!.className).toContain('max-lg:flex-wrap');
    fireEvent.click(open);
    const form = container.querySelector('form')!;
    // The date field's calendar button is inset-y-0 inside its input, so it takes the input's height (checked in the browser run).
    const controls = [...form.querySelectorAll('select, input:not([type=hidden]), button:not([aria-label="Choose date"])')];
    expect(controls).toHaveLength(7); // item, type, quantity, date, reason, cancel, save
    for (const c of controls) expect(c.className, c.outerHTML.slice(0, 80)).toContain('max-lg:min-h-11');
  });
});
