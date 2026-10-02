// D2 round 10 (a): purchase-orders/new, batch-payments/new, batch-payments/[batchId]. Real route envelopes:
//   POST purchase-orders -> 201 { success, data: <po row> }; supplier-invoices -> data { invoices, total };
//   batch-payments?reservedFor -> data { [billId]: reserved }; batch-payments?id -> data batch + payments; batch-payments-action -> data { status }.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoJargon, ok, on, refuse, serve, writeCalls } from '../helpers/d2R3a6';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', push: vi.fn(async () => true), replace: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string, name: string) => void }) =>
    <button type="button" onClick={() => onChange('sup-1', 'D2 Supplier')}>pick supplier</button>,
}));

import { apiFetch } from '@/lib/apiFetch';
import NewPoPage from '../../../pages/accounting/purchase-orders/new';
import NewBatchPage from '../../../pages/accounting/batch-payments/new';
import BatchDetailPage from '../../../pages/accounting/batch-payments/[batchId]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.push.mockClear(); route.query = {}; });
afterEach(() => { cleanup(); });

const created = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 201 });

describe('purchase-orders/new (write only: POST /api/accounting/purchase-orders)', () => {
  function fillAndCreate() {
    render(<NewPoPage />);
    fireEvent.click(screen.getByText('pick supplier'));
    fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'D2 widgets' } });
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
  }
  it('a 400 refusal shows the server message and does not navigate', async () => {
    serve(on('POST', '/api/accounting/purchase-orders', () => refuse()));
    fillAndCreate();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(route.push).not.toHaveBeenCalled();
  });
  it('an empty 500 shows the page sentence and does not navigate', async () => {
    serve(on('POST', '/api/accounting/purchase-orders', empty500));
    fillAndCreate();
    expect(await screen.findByText('Could not create the purchase order - try again')).toBeDefined();
    expect(route.push).not.toHaveBeenCalled(); expectNoJargon();
  });
  it('success posts the typed lines and goes to the PO id from data.id', async () => {
    serve(on('POST', '/api/accounting/purchase-orders', () => created({ id: 'po-d2-77', po_number: 'PO-77' })));
    fillAndCreate();
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/purchase-orders/po-d2-77'));
    const body = JSON.parse(String((vi.mocked(apiFetch).mock.calls[0]![1] as RequestInit).body));
    expect(body.supplierId).toBe('sup-1');
    expect(body.items[0].description).toBe('D2 widgets');
  });
});

describe('batch-payments/new', () => {
  const bill = { id: 'b1', invoiceNumber: 'D2-INV-9', supplierId: 'sup-1', totalAmount: 500, amountPaid: 100 };
  const billsRoute = () => on('GET', 'supplier-invoices', () => ok({ invoices: [bill], total: 1 }));
  const reserved = () => on('GET', 'reservedFor', () => ok({ b1: 50 }));
  it('load: lists each outstanding bill with its available amount (outstanding less reserved) from the served fields', async () => {
    serve(billsRoute(), reserved());
    render(<NewBatchPage />);
    // 500 - 100 - 50 = 350
    expect(await screen.findByText(/D2-INV-9/)).toBeDefined();
    const opt = screen.getByText(/D2-INV-9/).textContent ?? '';
    expect(opt).toMatch(/350,00/); expect(opt).toMatch(/reserved/); expect(opt).toMatch(/50,00/);
  });
  it('load: a 400 refusal on the bill list shows the server message; an empty 500 shows the sentence', async () => {
    serve(on('GET', 'supplier-invoices', () => refuse()));
    render(<NewBatchPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    serve(on('GET', 'supplier-invoices', empty500));
    render(<NewBatchPage />);
    expect(await screen.findByText('Could not load supplier invoices - try again')).toBeDefined();
    expect(screen.queryByText(/D2-INV-9/)).toBeNull(); expectNoJargon();
  });
  const pickBill = () => {
    const sel = Array.from(document.querySelectorAll('select')).find((s) => s.getAttribute('name') === 'invoiceId') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'b1' } });
  };
  const create = async () => {
    render(<NewBatchPage />);
    await screen.findByText(/D2-INV-9/);
    fireEvent.click(screen.getByText('pick supplier'));
    pickBill();
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
  };
  it('write: a 400 refusal shows the server message and does not navigate', async () => {
    serve(billsRoute(), reserved(), on('POST', '/api/accounting/batch-payments', () => refuse()));
    await create();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(route.push).not.toHaveBeenCalled();
  });
  it('write: an empty 500 shows the sentence and does not navigate', async () => {
    serve(billsRoute(), reserved(), on('POST', '/api/accounting/batch-payments', empty500));
    await create();
    expect(await screen.findByText('Could not create the batch - try again')).toBeDefined();
    expect(route.push).not.toHaveBeenCalled(); expectNoJargon();
  });
  it('write: success posts the allocation (bill id, available amount) then goes to the batch list', async () => {
    serve(billsRoute(), reserved(), on('POST', '/api/accounting/batch-payments', () => ok({ id: 'batch-1' })));
    await create();
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/batch-payments'));
    expect(writeCalls('POST', '/api/accounting/batch-payments')).toBe(1);
    const post = vi.mocked(apiFetch).mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    const body = JSON.parse(String((post[1] as RequestInit).body));
    expect(body.payments[0].supplierId).toBe('sup-1');
    expect(body.payments[0].invoiceAllocations).toEqual([{ invoiceId: 'b1', amount: 350 }]);
  });
});

describe('batch-payments/[batchId] (route: data = batch row + payments[] + billCount)', () => {
  const batch = (status: string) => ({ id: 'bt1', batchNumber: 'BATCH-D2-88', batchDate: '2026-09-30', totalAmount: 1234.5, paymentCount: 2,
    paymentMethod: 'eft', status, billCount: 3,
    payments: [{ id: 'p1', paymentNumber: 'PAY-D2-1', supplierName: 'D2 Acme Ltd', amount: 700, status: 'draft' },
      { id: 'p2', paymentNumber: 'PAY-D2-2', supplierName: 'D2 Beta Ltd', amount: 534.5, status: 'draft' }] });
  beforeEach(() => { route.query = { batchId: 'bt1' }; });
  it('load: shows the batch number, total, method and each payment row from the served fields', async () => {
    serve(on('GET', 'batch-payments?id=bt1', () => ok(batch('draft'))));
    render(<BatchDetailPage />);
    expect(await screen.findByText('BATCH-D2-88')).toBeDefined();
    expect(document.body.textContent).toMatch(/1[\s  ]234,50/);
    const row = screen.getByText('PAY-D2-1').closest('tr') as HTMLElement;
    expect(within(row).getByText('D2 Acme Ltd')).toBeDefined();
    expect(screen.getByText('D2 Beta Ltd')).toBeDefined();
    expect(screen.getByRole('button', { name: /Approve/ })).toBeDefined();
  });
  it('load: a 400 refusal shows the server message; an empty 500 shows the sentence; no batch is shown', async () => {
    serve(on('GET', 'batch-payments?id=', () => refuse()));
    render(<BatchDetailPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    serve(on('GET', 'batch-payments?id=', empty500));
    render(<BatchDetailPage />);
    expect(await screen.findByText('Could not load the batch - try again')).toBeDefined();
    expect(screen.queryByText('BATCH-D2-88')).toBeNull(); expectNoJargon();
  });
  const withAction = (answer: () => Response) => {
    let status = 'draft';
    serve(on('POST', 'batch-payments-action', () => { const r = answer(); if (r.ok) status = 'approved'; return r; }),
      (u, m) => (m === 'GET' && u.includes('batch-payments?id=') ? ok(batch(status)) : undefined));
  };
  it('action: a 400 refusal shows the server message and the batch stays draft', async () => {
    withAction(() => refuse());
    render(<BatchDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('action: an empty 500 shows the sentence', async () => {
    withAction(empty500);
    render(<BatchDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    expect(await screen.findByText('Could not approve the batch - try again')).toBeDefined(); expectNoJargon();
  });
  it('action: success reloads the batch, which now offers Process instead of Approve', async () => {
    withAction(() => ok({ status: 'approved' }));
    render(<BatchDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    expect(await screen.findByRole('button', { name: /Process/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });
});
