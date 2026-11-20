// Supplier statements balances list: cards below lg with labelled cells and 44px controls.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href, className, title }: { children: ReactNode; href: string; className?: string; title?: string }) => <a href={href} className={className} title={title}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/x', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...await orig<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierStatementsPage from '../../../pages/accounting/supplier-statements/index';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const labels = (el: Element | null) => [...(el?.querySelectorAll('td[data-label]') ?? [])].map(td => td.getAttribute('data-label'));

beforeEach(() => vi.mocked(apiFetch).mockReset());
afterEach(cleanup);

describe('supplier statements balances on touch', () => {
  it('renders the balances table as labelled cards with a 44px chevron, links and controls', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok([
      { entityId: 's1', entityName: 'Acme Supplies', current: 10, days30: 20, days60: 0, days90: 0, days120Plus: 5, onAccount: 0, netBalance: 35 },
    ]));
    const { container } = render(<SupplierStatementsPage />);
    await screen.findByText('Acme Supplies');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    // Labels come from the column headers, so a renamed header cannot drift from its data-label.
    const COLS = [...table.querySelectorAll('thead th')].slice(1, 8).map(th => th.textContent);
    expect(COLS).toHaveLength(7);
    expect(labels(table.querySelector('tbody tr'))).toEqual(COLS);
    // The TOTAL row is a card too, and its empty trailing cell must not add a blank line.
    const total = [...table.querySelectorAll('tbody tr')].find(tr => tr.textContent?.startsWith('TOTAL'))!;
    expect(labels(total)).toEqual(COLS);
    expect(total.querySelector('td:last-child')?.className).toContain('max-lg:!hidden');
    expect(screen.getByRole('link', { name: 'Acme Supplies' }).className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('link', { name: 'Acme Supplies' }).className).not.toMatch(/(^|\s)inline-flex/);
    // The name link is already a 44px target to the same page, so the chevron cell is hidden on cards.
    expect(screen.getByTitle('View Acme Supplies statement').closest('td')?.className).toContain('max-lg:!hidden');
    expect(screen.getByRole('button', { name: /Export CSV/ }).className).toContain('max-lg:min-h-11');
    expect(screen.getByPlaceholderText('Search supplier...').className).toContain('max-lg:min-h-11');
  });
});
