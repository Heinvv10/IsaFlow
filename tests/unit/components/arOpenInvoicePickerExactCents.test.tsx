// The invoice pickers on the receipt and write-off forms list an invoice while any cent is owing: the server (and
// recomputeInvoiceStatus) treat R0.01 owing as 'partially_paid', so a form that hides it strands the last cent.
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { okRes } from '../helpers/d2CensusH4';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import NewPaymentPage from '../../../pages/accounting/customer-payments/new';
import WriteOffsPage from '../../../pages/accounting/write-offs/index';

const INVOICES = [
  { id: 'i-cent', invoice_number: 'INV-CENT', total_amount: 200, amount_paid: 199.99 },
  { id: 'i-none', invoice_number: 'INV-NONE', total_amount: 200, amount_paid: 200 },
];

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('/customers')) return okRes([{ id: 'c-1', name: 'Client One', company_name: 'Client One' }]);
    if (u.includes('customer-invoices')) return okRes({ invoices: INVOICES });
    return okRes({ items: [] });
  });
});
afterEach(() => { cleanup(); });

describe('open-invoice pickers, whole cents', () => {
  it('the receipt form offers an invoice owing one cent, and not one owing nothing', async () => {
    const { container } = render(<NewPaymentPage />);
    await screen.findByRole('option', { name: 'Client One' });
    fireEvent.change(container.querySelector('select[name="clientId"]')!, { target: { value: 'c-1' } });

    expect(await screen.findByRole('option', { name: /INV-CENT/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /INV-NONE/ })).toBeNull();
  });

  it('the write-off form offers an invoice owing one cent, and not one owing nothing', async () => {
    const { container } = render(<WriteOffsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /New Write-Off/ }));
    await screen.findByRole('option', { name: 'Client One' });
    fireEvent.change(container.querySelector('select')!, { target: { value: 'c-1' } });

    expect(await screen.findByRole('option', { name: /INV-CENT/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /INV-NONE/ })).toBeNull();
  });
});
