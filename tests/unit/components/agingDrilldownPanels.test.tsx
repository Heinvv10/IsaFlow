// The aging drill-down panels: every invoice links to its detail page with the
// return context, and a failed load says so instead of rendering no invoices.
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...await orig<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { AgingInvoicesPanel } from '@/components/accounting/AgingInvoicesPanel';
import { DebtorInvoicesPanel } from '@/components/accounting/DebtorInvoicesPanel';

const CUSTOMER = '3f8a1c2e-1b2c-4d5e-8f90-a1b2c3d4e5f6';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const inTable = (node: ReactNode) => render(<table><tbody>{node}</tbody></table>);

afterEach(() => { vi.mocked(apiFetch).mockReset(); });

describe('AgingInvoicesPanel', () => {
  it('links each as-at invoice back with ar-aging, the customer and the date', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ invoices: [
      { id: 'i1', invoiceNumber: 'INV-1', entityId: CUSTOMER, entityName: 'Herotel', dueDate: '2026-05-01', totalAmount: 100, amountPaid: 0, balance: 100, disputedAmount: 25 },
      { id: 'i2', invoiceNumber: 'INV-2', entityId: CUSTOMER, entityName: 'Herotel', dueDate: '2026-06-01', totalAmount: 50, amountPaid: 0, balance: 50, dueDateMissing: true },
    ] }));

    inTable(<AgingInvoicesPanel side="ar" entityId={CUSTOMER} entityName="Herotel" asAtDate="2026-05-31" colSpan={8} />);

    const link = await screen.findByRole('link', { name: 'INV-1' });
    expect(link.getAttribute('href')).toBe(`/accounting/customer-invoices/i1?from=ar-aging&customer=${CUSTOMER}&as_at_date=2026-05-31`);
    expect(screen.getByRole('link', { name: 'INV-2' }).getAttribute('href')).toContain('/accounting/customer-invoices/i2?');
    expect(screen.getByText('30d')).toBeTruthy();
    expect(screen.getByText(/disputed/)).toBeTruthy();
    expect(screen.getByText(/no due date/)).toBeTruthy();
  });

  it('links AP invoices to the supplier invoice page', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ invoices: [
      { id: 's1', invoiceNumber: 'SI-1', entityId: CUSTOMER, entityName: 'Acme', dueDate: '2026-05-01', totalAmount: 1, amountPaid: 0, balance: 1 },
    ] }));

    inTable(<AgingInvoicesPanel side="ap" entityId={CUSTOMER} entityName="Acme" asAtDate="2026-05-31" colSpan={8} />);

    expect((await screen.findByRole('link', { name: 'SI-1' })).getAttribute('href'))
      .toBe(`/accounting/supplier-invoices/s1?from=ap-aging&supplier=${CUSTOMER}&as_at_date=2026-05-31`);
  });

  it('reports a failed load', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 403 }));
    inTable(<AgingInvoicesPanel side="ap" entityId={CUSTOMER} entityName="Acme" asAtDate="2026-05-31" colSpan={8} />);
    expect(await screen.findByText(/Could not load invoices for Acme \(Could not load the invoices - try again\)/)).toBeTruthy();
  });
});

describe('DebtorInvoicesPanel', () => {
  it('links each invoice back to Debtors Manager with the customer', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok([{
      id: 'd1', invoiceNumber: 'INV-9', invoiceDate: '2026-01-01', dueDate: '2026-02-01', totalAmount: 10,
      amountPaid: 0, outstanding: 10, daysOverdue: 5, status: 'sent', agingBucket: 'days30',
    }]));

    inTable(<DebtorInvoicesPanel clientId={CUSTOMER} clientName="Herotel" />);

    expect((await screen.findByRole('link', { name: 'INV-9' })).getAttribute('href'))
      .toBe(`/accounting/customer-invoices/d1?from=debtors&customer=${CUSTOMER}`);
  });

  it('reports a failed load instead of an empty list', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 500 }));
    inTable(<DebtorInvoicesPanel clientId={CUSTOMER} clientName="Herotel" />);
    expect(await screen.findByText(/Could not load invoices for Herotel \(Could not load the invoices - try again\)/)).toBeTruthy();
  });
});
