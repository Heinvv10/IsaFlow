/**
 * D2: the dashboard's overdue action row is gated on and labelled by the TRUE count
 * (overdueInvoiceCount), not the length of the (capped) row list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import { apiFetch } from '@/lib/apiFetch';
import { TodoWidget } from '@/components/accounting/dashboard/TodoWidget';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `i${i}`, invoiceNumber: `INV-${i}`, clientName: 'Client', amount: 100, daysOverdue: 5,
}));
const serve = (data: unknown) => vi.mocked(apiFetch).mockResolvedValue(
  new Response(JSON.stringify({ success: true, data }), { status: 200 }),
);
const base = { pendingSupplierPayments: [], uncategorizedBankTxns: 0, draftInvoices: 0 };

describe('TodoWidget overdue row', () => {
  it('labels the true count while only 10 rows are loaded', async () => {
    serve({ ...base, overdueInvoiceCount: 27, overdueInvoices: rows(10) });
    render(<TodoWidget />);
    expect(await screen.findByText('27 overdue invoices')).toBeTruthy();
  });

  it('shows the row when the count is positive even if the list is empty', async () => {
    serve({ ...base, overdueInvoiceCount: 3, overdueInvoices: [] });
    render(<TodoWidget />);
    expect(await screen.findByText('3 overdue invoices')).toBeTruthy();
  });
});
