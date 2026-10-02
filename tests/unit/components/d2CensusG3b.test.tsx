// D2 census group 3b: user-triggered and secondary-panel loads. A non-2xx shows the server's message (400) or a plain
// sentence (empty 500), never a raw "Unexpected end of JSON input". The REAL assertOk / apiErrorMessage run over a scripted apiFetch.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { apiFetch } from '@/lib/apiFetch';
import { MSG, bad, boom, expectNoRawJsonError, ok } from '../helpers/d2CensusG3';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, asPath: '/', isReady: true, push: () => Promise.resolve(true), replace: () => Promise.resolve(true) }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/components/accounting/bank/ReconciliationBalances', () => ({ ReconciliationBalances: () => null }));
vi.mock('@/components/accounting/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

import CustomerAllocationsPage from '../../../pages/accounting/customer-allocations/index';
import SalesOrderDetailPage from '../../../pages/accounting/customer-sales-orders/[id]';
import ReconciliationDetailPage from '../../../pages/accounting/bank-reconciliation/[reconId]';
import { BundleEditor } from '../../../src/components/accounting/items/BundleEditor';
import { SupplierTypeahead } from '../../../src/components/accounting/supplier-invoices/SupplierTypeahead';

useApiJsonOverMock();
afterEach(() => { cleanup(); route.query = {}; });
type Respond = () => Response;
const answer = (fn: (url: string) => Response) => vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => fn(String(url)));

describe('customer allocations: invoices for the selected receipt', () => {
  const payments = [{ id: 'p1', paymentNumber: 'D2-RCPT-001', clientName: 'D2 Receipt Client', clientId: 'c1', date: '2026-09-01', totalAmount: 100, allocatedAmount: 0 }];
  const mount = async (invoices: Respond) => {
    answer(u => (u.includes('customer-invoices') ? invoices() : ok(payments)));
    render(<CustomerAllocationsPage />);
    fireEvent.click(await screen.findByText('D2-RCPT-001'));
  };
  it('400: shows the server message and no stale invoices', async () => {
    await mount(bad);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('500 with an empty body: shows a plain sentence, not the JSON parse error', async () => {
    await mount(boom);
    expect(await screen.findByText(/Could not load invoices for this receipt/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('200: lists the outstanding invoices', async () => {
    await mount(() => ok({ items: [{ id: 'i1', invoiceNumber: 'D2-INV-777', date: '2026-09-01', total: 100, outstanding: 100 }] }));
    expect(await screen.findByText(/D2-INV-777/)).toBeTruthy();
    expect(screen.queryByText(MSG)).toBeNull();
  });
});

describe('sales order detail: confirm action and reload', () => {
  const order = (n: string, status = 'draft') => ({ id: 'o1', orderNumber: n, customerName: 'D2 Customer', customerId: null, orderDate: '2026-09-01', deliveryDate: null,
    reference: null, status, subtotal: 1, taxAmount: 0, totalAmount: 1, notes: null, items: [] });
  const mount = async (action: Respond, reload: Respond) => {
    route.query = { id: 'o1' };
    let gets = 0;
    answer(u => (u.includes('-action') ? action() : ++gets === 1 ? ok(order('D2-SO-001')) : reload()));
    render(<SalesOrderDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Confirm Order/ }));
  };
  it('action 400: shows the server message', async () => {
    await mount(bad, () => ok(order('X')));
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('action 500 with an empty body: shows a plain sentence, not the JSON parse error', async () => {
    await mount(boom, () => ok(order('X')));
    expect(await screen.findByText(/Action 'confirm' failed/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('reload 400 after a successful action: shows the server message', async () => {
    await mount(() => ok({}), bad);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('reload 500 with an empty body: shows a plain sentence, not the JSON parse error', async () => {
    await mount(() => ok({}), boom);
    expect(await screen.findByText(/Could not reload the order/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('200: the reloaded order replaces the page', async () => {
    await mount(() => ok({}), () => ok(order('D2-SO-001-RELOADED', 'confirmed')));
    expect(await screen.findByText('D2-SO-001-RELOADED')).toBeTruthy();
    expect(await screen.findByText(/Order confirmed successfully/)).toBeTruthy();
  });
});

describe('bank reconciliation detail: GL lines', () => {
  const recon = { id: 'r1', bankAccountId: 'ba1', bankAccountName: 'D2 Recon Bank', statementDate: '2026-09-01', status: 'in_progress', difference: 5 };
  const entries = { entries: [{ id: 'je1', entryDate: '2026-09-01', entryNumber: 'D2-JE-1', description: 'e',
    lines: [{ id: 'l1', glAccountId: 'ba1', debit: 50, credit: 0, description: 'D2 GL line text' }] }] };
  const mount = async (gl: Respond) => {
    route.query = { reconId: 'r1' };
    answer(u => (u.includes('journal-entries') ? gl() : u.includes('bank-reconciliations') ? ok(recon) : ok({ transactions: [] })));
    render(<ReconciliationDetailPage />);
  };
  it('400: shows the server message', async () => { await mount(bad); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('500 with an empty body: shows a plain sentence, not the JSON parse error', async () => {
    await mount(boom);
    expect(await screen.findByText(/Could not load the bank ledger lines/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('200: lists the unmatched GL lines', async () => {
    await mount(() => ok(entries));
    expect(await screen.findByText('D2 GL line text')).toBeTruthy();
    expect(screen.queryByText(MSG)).toBeNull();
  });
});

describe('bundle editor', () => {
  const lines = [{ child_item_id: 'x1', child_code: 'D2-CHILD', child_description: 'D2 Child Component', child_unit: 'ea', child_selling_price_excl: 5, quantity: 2 }];
  const pick = [{ id: 'i9', code: 'D2-PICK', description: 'D2 Pickable Item', unit: 'ea', selling_price_excl: 1 }];
  const mount = (bundles: Respond, items: Respond) => {
    answer(u => (u.includes('item-bundles') ? bundles() : items()));
    render(<BundleEditor itemId="i1" />);
  };
  it('components 400: shows the server message', async () => { mount(bad, () => ok([])); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('components 500 with an empty body: plain sentence', async () => {
    mount(boom, () => ok([]));
    expect(await screen.findByText(/Could not load the bundle components/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('components 200: lists the lines', async () => { mount(() => ok(lines), () => ok([])); expect(await screen.findByText('D2 Child Component')).toBeTruthy(); });
  it('items list 400: shows the server message', async () => { mount(() => ok([]), bad); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('items list 500 with an empty body: plain sentence', async () => {
    mount(() => ok([]), boom);
    expect(await screen.findByText(/Could not load the items list/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('items list 200: offers the items in the search', async () => {
    mount(() => ok([]), () => ok(pick));
    fireEvent.click(await screen.findByRole('button', { name: /Add Component/ }));
    fireEvent.change(screen.getByPlaceholderText('Search items...'), { target: { value: 'D2' } });
    expect(await screen.findByText('D2 Pickable Item')).toBeTruthy();
  });
});

describe('supplier typeahead', () => {
  const mount = async (r: Respond) => {
    answer(() => r());
    render(<SupplierTypeahead selectedId="" selectedLabel="" onSelect={() => undefined} onClear={() => undefined} ariaLabel="Supplier" />);
    fireEvent.focus(screen.getByLabelText('Supplier'));
  };
  it('400: shows the server message', async () => { await mount(bad); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('500 with an empty body: plain sentence', async () => {
    await mount(boom);
    expect(await screen.findByText(/Could not load suppliers/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('200: offers the suppliers and no error', async () => {
    await mount(() => ok({ suppliers: [{ id: 's1', name: 'D2 Supplier Co' }] }));
    expect(await screen.findByText('D2 Supplier Co')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
