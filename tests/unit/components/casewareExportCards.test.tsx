// CaseWare export mapping editor: the 5-column table (two text inputs per row) becomes labelled cards below lg, the inputs stack under their label at full width and 44px,
// the toolbar wraps and its controls are 44px, the empty row is a centred block.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { items: [1, 2].map((n) => ({ glAccountId: `g${n}`, accountCode: `100${n}`, accountName: `Account ${n}`, accountType: 'asset', accountSubtype: n === 1 ? 'bank' : null, externalCode: `B${n}0`, externalLabel: `Label ${n}` })) } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/reports/caseware-export';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Code', 'Account Name', 'Type', 'CaseWare Code', 'CaseWare Label'];

describe('CaseWare export on touch', () => {
  it('is labelled cards matching the headers, account code unlabelled as the heading', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Account 1');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const trs = [...table.querySelectorAll('tbody tr')];
    expect(trs).toHaveLength(2);
    for (const r of trs) expect([...r.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, ...HEADS.slice(1)]);
  });

  it('the mapping inputs sit under their label, full width at 44px', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Account 1');
    const inputs = [...container.querySelectorAll('tbody input')];
    expect(inputs).toHaveLength(4);
    for (const i of inputs) {
      expect(cls(i)).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:w-full']));
      expect(cls(i.closest('td')!)).toEqual(expect.arrayContaining(['max-lg:flex-col', 'max-lg:items-stretch', 'max-lg:!gap-1']));
    }
  });

  it('the toolbar wraps and its search and buttons are 44px', async () => {
    render(<Page />);
    await screen.findByText('Account 1');
    const search = screen.getByPlaceholderText('Search accounts...');
    expect(cls(search)).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:w-full']));
    for (const name of [/Auto-Suggest/, /Save All/, /Export CSV/]) expect(cls(screen.getByRole('button', { name }))).toContain('max-lg:min-h-11');
    expect(cls(search.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:w-full']));
    expect(cls(search.parentElement!.parentElement!)).toContain('max-lg:flex-wrap');
    expect(cls(screen.getByRole('link', { name: /Back to Reports/ }))).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:inline-flex', 'max-lg:items-center']));
  });

  it('the empty row is a centred full-width block', async () => {
    render(<Page />);
    await screen.findByText('Account 1');
    fireEvent.change(screen.getByPlaceholderText('Search accounts...'), { target: { value: 'zzz-no-match' } });
    const td = (await screen.findByText('No accounts found')).closest('td')!;
    expect(cls(td)).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
  });
});
