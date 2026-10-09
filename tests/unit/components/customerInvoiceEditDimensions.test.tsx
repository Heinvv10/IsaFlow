/**
 * The draft-invoice edit form sends back the CC1 / CC2 / BU each loaded line
 * carries (it does not edit them), so a save no longer strips them; a line
 * added on the form sends none (null), as the create form does.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';

const push = vi.fn();
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push, replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import EditInvoicePage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); });

const INVOICE = {
  id: 'inv-1', invoice_number: 'INV-DIMS', status: 'draft', client_id: 'c-1', invoice_date: '2031-03-01', tax_rate: 15,
  currency_code: 'ZAR', exchange_rate: 1,
  items: [
    { description: 'Tagged', quantity: 1, unit_price: 10, amount: 10, cc1_id: 'f-1', cc2_id: 'p-1', bu_id: 'b-1' },
    { description: 'Untagged', quantity: 2, unit_price: 5, amount: 10, cc1_id: null, cc2_id: null, bu_id: null },
  ],
};

describe('customer-invoices/edit and the line dimensions', () => {
  it('sends each loaded line\'s dimensions back unchanged, and null on a line added here', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/customers')) return ok([{ id: 'c-1', name: 'Client' }]);
      if (u.includes('currencies')) return ok([]);
      if (u.includes('customer-invoices-detail') && init?.method === 'PUT') return ok({ updated: true });
      return ok(INVOICE);
    });
    render(<EditInvoicePage />);
    await screen.findByDisplayValue('Tagged');
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    const blanks = screen.getAllByPlaceholderText('Item description').filter((el) => (el as HTMLInputElement).value === '');
    fireEvent.change(blanks[0]!, { target: { value: 'Added' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await vi.waitFor(() => expect(push).toHaveBeenCalled());

    const put = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'PUT')!;
    const items = JSON.parse(String(put[1]!.body)).items as Record<string, unknown>[];
    expect(items.map(({ description, cc1Id, cc2Id, buId }) => ({ description, cc1Id, cc2Id, buId }))).toEqual([
      { description: 'Tagged', cc1Id: 'f-1', cc2Id: 'p-1', buId: 'b-1' },
      { description: 'Untagged', cc1Id: null, cc2Id: null, buId: null },
      { description: 'Added', cc1Id: null, cc2Id: null, buId: null },
    ]);
  });
});
