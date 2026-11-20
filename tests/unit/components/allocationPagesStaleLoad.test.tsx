/** #1695: an invoice load still in flight when an allocation succeeds must not touch the page afterwards. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, refuse, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierAllocationsPage from '../../../pages/accounting/supplier-allocations';
import CustomerAllocationsPage from '../../../pages/accounting/customer-allocations';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(cleanup);

const CUSTOMER_INVOICE = { id: 'c1', invoice_number: 'CI-1', client_id: 'k1', invoice_date: '2026-10-01', total_amount: '230.00', amount_paid: '115.00', status: 'sent' };
const bill = (n: number, status = 'approved') => ({ id: `b${n}`, invoiceNumber: `B-${n}`, invoiceDate: '2026-10-01', totalAmount: '10.00', amountPaid: '0.00', balance: '10.00', status });
const urlParam = (u: string, k: string) => new URL(u, 'http://x').searchParams.get(k);
const gate = () => { let open!: () => void; const wait = new Promise<void>(r => { open = r; }); return { wait, open }; };
const flush = () => new Promise<void>(r => setTimeout(r, 30));

describe('allocating while another receipt\'s invoices are still loading', () => {
  // Pick A, tick, press Allocate (POST held), pick B (B's invoice load held), POST succeeds, then B's load fails.
  // doAllocate bumps loadSeq, so that older load must not put its error on a page that has just allocated.
  it.each([
    ['supplier', SupplierAllocationsPage, 'PAY', 'supplier-payments', 'supplier-invoices', 'supplier-allocations', 'supplier_id', 's2'],
    ['customer', CustomerAllocationsPage, 'REC', 'customer-payments', 'customer-invoices-list', 'customer-allocations', 'client_id', 'k2'],
  ] as const)('%s: a stale invoice load that fails after the allocation shows no error', async (kind, Page, prefix, payPart, invPart, allocPart, idParam, bId) => {
    const gPost = gate(); const gB = gate();
    const pay = (id: string, n: string, owner: string) => kind === 'supplier'
      ? { id, paymentNumber: `${prefix}-${n}`, supplierName: n, supplierId: owner, paymentDate: '2026-11-01', totalAmount: 500, allocatedAmount: 0 }
      : { id, paymentNumber: `${prefix}-${n}`, clientName: n, clientId: owner, paymentDate: '2026-11-01', totalAmount: 500, allocatedAmount: 0 };
    const owners = kind === 'supplier' ? ['s1', 's2'] : ['k1', 'k2'];
    serve(
      on('GET', `/api/accounting/${payPart}`, () => ok({ payments: [pay('pa', 'A', owners[0]!), pay('pb', 'B', owners[1]!)] })),
      async (u, m) => {
        if (m === 'POST' && u.includes(`/api/accounting/${allocPart}`)) { await gPost.wait; return ok({}); }
        if (m !== 'GET' || !u.includes(`/api/accounting/${invPart}`)) return undefined;
        if (urlParam(u, idParam) === bId) { await gB.wait; return refuse('B invoices refused'); }
        return ok(kind === 'supplier'
          ? { invoices: urlParam(u, 'status') === 'approved' ? [bill(1)] : [], total: urlParam(u, 'status') === 'approved' ? 1 : 0 }
          : { invoices: [{ ...CUSTOMER_INVOICE, id: 'ca', invoice_number: 'A-INV' }], total: 1 });
      },
    );
    render(<Page />);
    fireEvent.click(await screen.findByText(`${prefix}-A`));
    await screen.findByText(kind === 'supplier' ? 'B-1' : 'A-INV');
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    fireEvent.click(screen.getByRole('button', { name: /Allocate/ }));
    fireEvent.click(await screen.findByText(`${prefix}-B`));
    gPost.open();
    await screen.findByText('Allocated successfully');
    gB.open();
    await flush();
    expect(document.body.textContent).not.toMatch(/B invoices refused|Could not load invoices|Could not load the supplier invoices/);
    expect(screen.getByText('Allocated successfully')).toBeTruthy();
  });
});
