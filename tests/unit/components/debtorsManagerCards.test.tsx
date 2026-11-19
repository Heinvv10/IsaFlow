// Debtors manager: aging, expanded-invoice and overdue tables are cards below lg with 44px links.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/x', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...await orig<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import DebtorsManagerPage from '../../../pages/accounting/debtors-manager/index';
import { DebtorInvoicesPanel } from '@/components/accounting/DebtorInvoicesPanel';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const labels = (el: Element | null) => [...(el?.querySelectorAll('td[data-label]') ?? [])].map(td => td.getAttribute('data-label'));

beforeEach(() => vi.mocked(apiFetch).mockReset());
afterEach(cleanup);

describe('debtors manager on touch', () => {
  it('renders the aging and overdue tables as labelled cards with 44px links and search', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({
      summary: [{ clientId: 'c1', clientName: 'Acme', invoiceCount: 2, current: 10, days30: 20, days60: 0, days90: 0, days90Plus: 5, totalOutstanding: 35 }],
      stats: { totalOutstanding: 35, clientCount: 1, totalOverdue: 25, overdueCount: 1, avgDaysOutstanding: 12, collectionRate: 80 },
      overdueInvoices: [{ id: 'i1', invoiceNumber: 'INV-1', clientId: 'c1', clientName: 'Acme', dueDate: '2026-10-01', daysOverdue: 40, outstanding: 25 }],
    }));
    const { container } = render(<DebtorsManagerPage />);
    await screen.findByText('INV-1');
    const tables = container.querySelectorAll('table');
    expect(tables).toHaveLength(2);
    for (const t of tables) expect(t.className).toContain('table-cards');
    expect(labels(tables[0].querySelector('tbody tr'))).toEqual(['Current', '1–30 Days', '31–60 Days', '61–90 Days', '90+ Days', 'Total']);
    expect(labels(tables[0].querySelector('tfoot tr'))).toEqual(['Current', '1–30 Days', '31–60 Days', '61–90 Days', '90+ Days', 'Total']);
    expect(labels(tables[1].querySelector('tbody tr'))).toEqual(['Customer', 'Due Date', 'Days Overdue', 'Outstanding']);
    // Chevron sits in the card corner and the empty totals cell is hidden, so neither adds a blank line to a card.
    expect(tables[0].querySelector('tbody tr td:first-child')?.className).toContain('max-lg:!absolute');
    expect(tables[0].querySelector('tfoot tr td:first-child')?.className).toContain('max-lg:!hidden');
    expect(screen.getByRole('link', { name: 'Acme' }).className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('link', { name: 'INV-1' }).className).toContain('max-lg:min-h-11');
    expect(screen.getByLabelText('Search customer').className).toContain('max-lg:min-h-11');
  });

  it('renders the expanded invoice panel as a card table too', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok([
      { id: 'i1', invoiceNumber: 'INV-1', invoiceDate: '2026-09-01', dueDate: '2026-10-01', totalAmount: 100, amountPaid: 0, outstanding: 100, agingBucket: 'days30', daysOverdue: 10 },
    ]));
    const { container } = render(<table><tbody><DebtorInvoicesPanel clientId="c1" clientName="Acme" /></tbody></table>);
    await screen.findByRole('link', { name: 'INV-1' });
    const inner = container.querySelector('table table');
    expect(inner?.className).toContain('table-cards');
    expect(labels(inner?.querySelector('tbody tr') ?? null)).toEqual(['Invoice #', 'Invoice Date', 'Due Date', 'Total', 'Paid', 'Outstanding', 'Days Overdue']);
    expect(screen.getByRole('link', { name: 'INV-1' }).className).toContain('max-lg:min-h-11');
  });
});
