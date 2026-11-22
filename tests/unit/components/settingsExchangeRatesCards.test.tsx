// Exchange rates settings: the rates table becomes labelled cards below lg; the form, converter, refresh and delete controls are 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => {
    const data = String(url).includes('currencies')
      ? { currencies: [{ code: 'ZAR', name: 'Rand', symbol: 'R' }, { code: 'USD', name: 'US Dollar', symbol: '$' }] }
      : { rates: [{ id: 'r1', fromCurrency: 'USD', toCurrency: 'ZAR', rate: 18.5, effectiveDate: '2026-11-01' }] };
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));

import Page from '../../../pages/accounting/settings/exchange-rates';

afterEach(cleanup);
const min = (el: Element, name: string) => expect(el.className, name).toContain('max-lg:min-h-11');

describe('Exchange rates settings on touch', () => {
  it('turns the rates table into labelled cards; the actions cell has no label', async () => {
    const { container } = render(<Page />);
    await screen.findByText('18.500000');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(['From', 'To', 'Rate', 'Effective Date', 'Actions']);
    const row = table.querySelector(':scope > tbody > tr')!;
    expect([...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual(['From', 'To', 'Rate', 'Effective Date', null]);
  });

  it('makes refresh and delete 44px square targets', async () => {
    render(<Page />);
    await screen.findByText('18.500000');
    for (const title of ['Refresh', 'Delete rate']) {
      const b = screen.getByTitle(title);
      for (const c of ['max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center']) expect(b.className, title).toContain(c);
    }
  });

  it('makes every select and number input of the add form and the converter 44px, and the buttons too', async () => {
    const { container } = render(<Page />);
    await screen.findByText('18.500000');
    const fields = [...container.querySelectorAll('select, input[type=number]')];
    expect(fields).toHaveLength(6); // add: from, to, rate; converter: amount, from, to
    for (const f of fields) min(f, f.outerHTML.slice(0, 50));
    const buttons = [...container.querySelectorAll('button')].filter(b => !b.title);
    expect(buttons.map(b => b.textContent?.trim())).toEqual(['Add Rate', 'Convert']);
    for (const b of buttons) min(b, b.textContent ?? '');
  });

  it('drops the converter arrow on phones: wrapped onto its own line it points at nothing', async () => {
    const { container } = render(<Page />);
    await screen.findByText('18.500000');
    const arrow = container.querySelector('svg.lucide-arrow-right')!;
    expect(arrow.getAttribute('class')).toContain('max-lg:hidden');
  });
});
