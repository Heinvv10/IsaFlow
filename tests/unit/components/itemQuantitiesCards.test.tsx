// Item quantities report: labelled cards below lg (item code = heading), wrapping header, 44px low-stock toggle and CSV button.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.data }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/reports/item-quantities';

afterEach(() => { cleanup(); state.data = []; });
const cls = (el: Element) => el.className.split(' ');
const row = (n: string, low: boolean) => ({ id: n, itemCode: `IT-${n}`, name: `Item ${n}`, category: 'Cables', uom: 'm', qtyOnHand: low ? 2 : 40, minLevel: 10, lowStock: low });
const HEADS = ['Code', 'Item', 'Category', 'UOM', 'On Hand', 'Min Level', 'Status'];

describe('Item quantities on touch', () => {
  it('is labelled cards matching the headers, code unlabelled as the heading', async () => {
    state.data = [row('1', true), row('2', false)];
    const { container } = render(<Page />);
    await screen.findByText('IT-1');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const trs = [...table.querySelectorAll('tbody tr')];
    expect(trs).toHaveLength(2);
    for (const r of trs) expect([...r.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, ...HEADS.slice(1)]);
    expect([...table.querySelectorAll('td[data-label="Status"]')].map((td) => td.textContent)).toEqual(['Low', 'OK']);
  });

  it('header and its actions wrap; the toggle and CSV are 44px', async () => {
    state.data = [row('1', false)];
    render(<Page />);
    await screen.findByText('IT-1');
    const toggle = screen.getByText('Low stock only').closest('label')!;
    expect(cls(toggle)).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('button', { name: /CSV/ }))).toContain('max-lg:min-h-11');
    expect(cls(toggle.parentElement!)).toContain('max-lg:flex-wrap');
    expect(cls(toggle.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });
});
