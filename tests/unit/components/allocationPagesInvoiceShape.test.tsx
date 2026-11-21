/**
 * #1685: the supplier / customer allocation pages must read the invoice list the way the API really returns it.
 * Supplier list: camelCase totalAmount / amountPaid / balance / invoiceDate (no total / outstanding / date).
 * Customer list: /customer-invoices-list, snake_case invoice_number / total_amount / amount_paid / invoice_date, string amounts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierAllocationsPage from '../../../pages/accounting/supplier-allocations';
import CustomerAllocationsPage from '../../../pages/accounting/customer-allocations';
import WriteOffsPage from '../../../pages/accounting/write-offs';
import { customerOpenRows, supplierOpenRows } from '@/components/accounting/allocations/openInvoiceRows';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(cleanup);

const SUPPLIER_BILLS = [
  { id: 'i1', invoiceNumber: 'INV-1', supplierId: 's1', invoiceDate: '2026-10-01', totalAmount: '230.00', amountPaid: '115.00', balance: '115.00', status: 'approved' },
  { id: 'i2', invoiceNumber: 'INV-2', supplierId: 's1', invoiceDate: '2026-10-02', totalAmount: '0.30', amountPaid: '0.10', balance: '0.20', status: 'approved' },
];
const CUSTOMER_INVOICES = [
  { id: 'c1', invoice_number: 'CI-1', client_id: 'k1', invoice_date: '2026-10-01', total_amount: '230.00', amount_paid: '115.00', status: 'sent' },
  { id: 'c2', invoice_number: 'CI-2', client_id: 'k1', invoice_date: '2026-10-02', total_amount: '0.30', amount_paid: '0.10', status: 'sent' },
];

describe('supplier-allocations', () => {
  it('ticking a bill pre-fills its balance, not NaN, and shows the invoice date', async () => {
    serve(
      on('GET', '/api/accounting/supplier-payments', () => ok({ payments: [{ id: 'p1', paymentNumber: 'PAY-1', supplierName: 'Sup', supplierId: 's1', date: '2026-11-01', totalAmount: 500, allocatedAmount: 0 }] })),
      on('GET', '/api/accounting/supplier-invoices', () => ok({ invoices: SUPPLIER_BILLS, total: 2 })),
    );
    render(<SupplierAllocationsPage />);
    fireEvent.click(await screen.findByText('PAY-1'));
    await screen.findByText('INV-1');
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    expect((screen.getByRole('textbox', { name: 'Allocate to INV-1' }) as HTMLInputElement).value).toBe('115');
    expect((screen.getByRole('textbox', { name: 'Allocate to INV-2' }) as HTMLInputElement).value).toBe('0.2');
    expect(document.body.textContent).not.toMatch(/NaN/);
    await waitFor(() => expect(screen.getByRole('button', { name: /Allocate/ })).toBeTruthy());
    expect(document.body.textContent).toMatch(/1 Oct 2026|2026-10-01|01 Oct 2026/);
  });
});

describe('customer-allocations', () => {
  it('loads the invoices from customer-invoices-list and pre-fills each balance in cents', async () => {
    serve(
      on('GET', '/api/accounting/customer-payments', () => ok({ payments: [{ id: 'r1', paymentNumber: 'REC-1', clientName: 'Cust', clientId: 'k1', date: '2026-11-01', totalAmount: 500, allocatedAmount: 0 }] })),
      on('GET', '/api/accounting/customer-invoices-list', () => ok({ invoices: CUSTOMER_INVOICES, total: 2 })),
    );
    render(<CustomerAllocationsPage />);
    fireEvent.click(await screen.findByText('REC-1'));
    await screen.findByText('CI-1');
    const urls = vi.mocked(apiFetch).mock.calls.map(([u]) => String(u));
    expect(urls.some(u => u.includes('/api/accounting/customer-invoices-list?') && u.includes('client_id=k1'))).toBe(true);
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    expect((screen.getByRole('textbox', { name: 'Allocate to CI-1' }) as HTMLInputElement).value).toBe('115');
    expect((screen.getByRole('textbox', { name: 'Allocate to CI-2' }) as HTMLInputElement).value).toBe('0.2');
    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});

describe('openInvoiceRows', () => {
  it('supplier: balance in cents; falls back to total - paid; drops settled and unreadable rows', () => {
    const rows = supplierOpenRows([
      ...SUPPLIER_BILLS,
      { id: 'x', invoiceNumber: 'NOBAL', invoiceDate: '2026-10-03', totalAmount: '0.30', amountPaid: '0.10' }, // 0.3 - 0.1 = 0.19999999999999998 in floats
      { id: 'z', invoiceNumber: 'PAID', totalAmount: '10.00', amountPaid: '10.00', balance: '0.00' },
      { id: 'bad', invoiceNumber: 'BAD' },
    ]);
    expect(rows.map(r => [r.invoiceNumber, r.outstanding])).toEqual([['INV-1', 115], ['INV-2', 0.2], ['NOBAL', 0.2]]);
    expect(rows[0]).toMatchObject({ date: '2026-10-01', total: 230 });
  });
  it('supplier: the API balance wins over total - paid (a credit note can lower it)', () => {
    const rows = supplierOpenRows([{ id: 'c', invoiceNumber: 'CRD', invoiceDate: '2026-10-04', totalAmount: '100.00', amountPaid: '0.00', balance: '60.00' }]);
    expect(rows[0]?.outstanding).toBe(60);
  });
  it('customer: total_amount - amount_paid in cents', () => {
    const rows = customerOpenRows(CUSTOMER_INVOICES);
    expect(rows.map(r => [r.invoiceNumber, r.total, r.outstanding])).toEqual([['CI-1', 230, 115], ['CI-2', 0.3, 0.2]]);
  });
});

// ---- #1685 follow-up: every open status, every page, no silent drop ----
import { fetchAllPages, MAX_PAGES, CUSTOMER_PAGE_SIZE, SUPPLIER_PAGE_SIZE, PAYMENT_PAGE_SIZE } from '@/components/accounting/allocations/openInvoiceFetch';

const calls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u));
const supplierPayment = on('GET', '/api/accounting/supplier-payments', () => ok({ payments: [{ id: 'p1', paymentNumber: 'PAY-1', supplierName: 'Sup', supplierId: 's1', paymentDate: '2026-11-01', totalAmount: 500, allocatedAmount: 0 }] }));
const customerPayment = on('GET', '/api/accounting/customer-payments', () => ok({ payments: [{ id: 'r1', paymentNumber: 'REC-1', clientName: 'Cust', clientId: 'k1', paymentDate: '2026-11-01', totalAmount: 500, allocatedAmount: 0 }] }));
const bill = (n: number, status = 'approved') => ({ id: `b${n}`, invoiceNumber: `B-${n}`, invoiceDate: '2026-10-01', totalAmount: '10.00', amountPaid: '0.00', balance: '10.00', status });
const urlParam = (u: string, k: string) => new URL(u, 'http://x').searchParams.get(k);

describe('supplier-allocations: statuses and paging', () => {
  it('asks for approved AND partially_paid at limit 200, and lists the partially paid bill with its balance', async () => {
    serve(supplierPayment, (u, m) => {
      if (m !== 'GET' || !u.includes('/api/accounting/supplier-invoices')) return undefined;
      return urlParam(u, 'status') === 'partially_paid'
        ? ok({ invoices: [{ ...bill(2, 'partially_paid'), totalAmount: '100.00', amountPaid: '40.00', balance: '60.00' }], total: 1 })
        : ok({ invoices: [bill(1)], total: 1 });
    });
    render(<SupplierAllocationsPage />);
    fireEvent.click(await screen.findByText('PAY-1'));
    await screen.findByText('B-2');
    const inv = calls().filter(u => u.includes('/supplier-invoices'));
    expect(inv.map(u => urlParam(u, 'status')).sort()).toEqual(['approved', 'partially_paid']);
    expect(inv.every(u => urlParam(u, 'limit') === '200' && urlParam(u, 'supplier_id') === 's1')).toBe(true);
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    expect((screen.getByRole('textbox', { name: 'Allocate to B-2' }) as HTMLInputElement).value).toBe('60');
    expect(document.body.textContent).toMatch(/Nov 2026/); // the payment row carries its date (paymentDate)
  });

  it('pages past 200: 201 approved bills take two requests (offset 0, 200) and all 201 are listed', async () => {
    const all = Array.from({ length: 201 }, (_, i) => bill(i));
    serve(supplierPayment, (u, m) => {
      if (m !== 'GET' || !u.includes('/api/accounting/supplier-invoices')) return undefined;
      if (urlParam(u, 'status') !== 'approved') return ok({ invoices: [], total: 0 });
      const off = Number(urlParam(u, 'offset'));
      return ok({ invoices: all.slice(off, off + 200), total: 201 });
    });
    render(<SupplierAllocationsPage />);
    fireEvent.click(await screen.findByText('PAY-1'));
    await screen.findByText('B-200');
    expect(screen.getAllByRole('checkbox')).toHaveLength(201);
    expect(calls().filter(u => u.includes('status=approved')).map(u => urlParam(u, 'offset'))).toEqual(['0', '200']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a list that cannot be read to the end says "Showing N of M" instead of dropping rows silently', async () => {
    serve(supplierPayment, (u, m) => {
      if (m !== 'GET' || !u.includes('/api/accounting/supplier-invoices')) return undefined;
      if (urlParam(u, 'status') !== 'approved') return ok({ invoices: [], total: 0 });
      const off = Number(urlParam(u, 'offset'));
      return ok({ invoices: Array.from({ length: 200 }, (_, i) => bill(off + i)), total: 1_000_000 });
    });
    render(<SupplierAllocationsPage />);
    fireEvent.click(await screen.findByText('PAY-1'));
    expect((await screen.findByRole('alert')).textContent).toContain(`Showing ${MAX_PAGES * SUPPLIER_PAGE_SIZE} of 1000000`);
  });
});

describe('customer-allocations: paging', () => {
  it('asks for every open status at limit 100 and pages past 100 (page=1, page=2)', async () => {
    const all = Array.from({ length: 101 }, (_, i) => ({ ...CUSTOMER_INVOICES[0]!, id: `c${i}`, invoice_number: `CI-${i}` }));
    serve(customerPayment, (u, m) => {
      if (m !== 'GET' || !u.includes('/api/accounting/customer-invoices-list')) return undefined;
      const page = Number(urlParam(u, 'page'));
      return ok({ invoices: all.slice((page - 1) * 100, page * 100), total: 101 });
    });
    render(<CustomerAllocationsPage />);
    fireEvent.click(await screen.findByText('REC-1'));
    await screen.findByText('CI-100');
    expect(screen.getAllByRole('checkbox')).toHaveLength(101);
    const urls = calls().filter(u => u.includes('customer-invoices-list'));
    expect(urls.map(u => urlParam(u, 'page'))).toEqual(['1', '2']);
    expect(new URL(urls[0]!, 'http://x').searchParams.getAll('status')).toEqual(['approved', 'sent', 'partially_paid', 'overdue']);
    expect(urls.every(u => urlParam(u, 'limit') === '100')).toBe(true);
    expect(document.body.textContent).toMatch(/Nov 2026/);
  });
});

describe('fetchAllPages', () => {
  it('stops at total, flags an empty page short of total, and flags a cut-off at the cap', async () => {
    const mk = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: String(from + i) }));
    expect(await fetchAllPages(async i => ({ rows: i === 0 ? mk(0, 2) : mk(2, 1), total: 3 }))).toMatchObject({ total: 3, truncated: false });
    expect((await fetchAllPages(async i => ({ rows: i === 0 ? mk(0, 2) : [], total: 9 }))).truncated).toBe(true); // short of its own total: flagged, never passed off as whole
    expect((await fetchAllPages(async i => ({ rows: mk(i * 2, 2), total: 99 }), 3))).toMatchObject({ truncated: true });
  });
});

describe('write-offs: the invoice picker', () => {
  it('reads customer-invoices-list (the old /api/customer-invoices is a 404) and lists the open invoice', async () => {
    serve(
      on('GET', '/api/accounting/customers', () => ok([{ id: 'k1', name: 'Cust One' }])),
      on('GET', '/api/accounting/write-offs', () => ok([])),
      on('GET', '/api/accounting/customer-invoices-list', () => ok({ invoices: CUSTOMER_INVOICES, total: 2 })),
    );
    render(<WriteOffsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /new|add|write.?off/i }));
    const clientSelect = (await screen.findAllByRole('combobox'))[0] as HTMLSelectElement;
    await screen.findByRole('option', { name: /Cust One/ });
    fireEvent.change(clientSelect, { target: { value: 'k1' } });
    await screen.findByRole('option', { name: /CI-1/ });
    const urls = calls().filter(u => u.includes('customer-invoices'));
    expect(urls.every(u => u.startsWith('/api/accounting/customer-invoices-list?'))).toBe(true);
    expect(urls.some(u => u.includes('client_id=k1'))).toBe(true);
  });
});

describe('write-offs: picker balances and currency', () => {
  const openPicker = async (invoices: Record<string, unknown>[]) => {
    serve(
      on('GET', '/api/accounting/customers', () => ok([{ id: 'k1', name: 'Cust One' }])),
      on('GET', '/api/accounting/write-offs', () => ok([])),
      on('GET', '/api/accounting/customer-invoices-list', () => ok({ invoices, total: invoices.length })),
    );
    render(<WriteOffsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /new|add|write.?off/i }));
    const [clientSelect, invoiceSelect] = (await screen.findAllByRole('combobox')) as HTMLSelectElement[];
    await screen.findByRole('option', { name: /Cust One/ });
    fireEvent.change(clientSelect!, { target: { value: 'k1' } });
    return invoiceSelect!;
  };

  it('defaults and caps the amount at the cent balance (R100.10 - R100.00 is 0.10, not 0.0999…)', async () => {
    const invoiceSelect = await openPicker([{ ...CUSTOMER_INVOICES[0]!, id: 'f1', invoice_number: 'FRAC', total_amount: '100.10', amount_paid: '100.00' }]);
    await screen.findByRole('option', { name: /FRAC/ });
    fireEvent.change(invoiceSelect, { target: { value: 'f1' } });
    const amount = screen.getByPlaceholderText('Amount *') as HTMLInputElement;
    await waitFor(() => expect(amount.value).toBe('0.10'));
    // The cap is enforced by the field's own validity (an AmountInput has no max attribute): 0.11 is over, 0.10 is not.
    fireEvent.change(amount, { target: { value: '0.11' } });
    expect(amount.validity.valid).toBe(false);
    fireEvent.change(amount, { target: { value: '0.10' } });
    expect(amount.validity.valid).toBe(true);
  });

  it('does not offer a foreign-currency invoice (approval refuses it); ZAR and unset are offered', async () => {
    await openPicker([
      { ...CUSTOMER_INVOICES[0]!, id: 'u1', invoice_number: 'USD-INV', currency_code: 'USD' },
      { ...CUSTOMER_INVOICES[0]!, id: 'z1', invoice_number: 'ZAR-INV', currency_code: 'zar ' },
      { ...CUSTOMER_INVOICES[0]!, id: 'n1', invoice_number: 'NOCUR-INV', currency_code: null },
    ]);
    await screen.findByRole('option', { name: /ZAR-INV/ });
    expect(screen.getByRole('option', { name: /NOCUR-INV/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /USD-INV/ })).toBeNull();
  });
});

// ---- #1685 review follow-ups: stale responses, dedupe, truncation, payment paging ----
const gate = () => { let open!: () => void; const wait = new Promise<void>(r => { open = r; }); return { wait, open }; };
const flush = () => new Promise<void>(r => setTimeout(r, 30));

describe('stale responses: the last pick wins', () => {
  it('supplier-allocations: pick A then B, A answers last: B\'s bills stay, A\'s never show', async () => {
    const gA = gate(); const gB = gate();
    serve(
      on('GET', '/api/accounting/supplier-payments', () => ok({ payments: [
        { id: 'p1', paymentNumber: 'PAY-A', supplierName: 'A', supplierId: 's1', paymentDate: '2026-11-01', totalAmount: 500, allocatedAmount: 0 },
        { id: 'p2', paymentNumber: 'PAY-B', supplierName: 'B', supplierId: 's2', paymentDate: '2026-11-01', totalAmount: 500, allocatedAmount: 0 }] })),
      async (u, m) => {
        if (m !== 'GET' || !u.includes('/api/accounting/supplier-invoices')) return undefined;
        const a = urlParam(u, 'supplier_id') === 's1';
        await (a ? gA : gB).wait;
        return ok({ invoices: urlParam(u, 'status') === 'approved' ? [{ ...bill(a ? 1 : 2), invoiceNumber: a ? 'A-BILL' : 'B-BILL' }] : [], total: urlParam(u, 'status') === 'approved' ? 1 : 0 });
      },
    );
    render(<SupplierAllocationsPage />);
    fireEvent.click(await screen.findByText('PAY-A'));
    fireEvent.click(await screen.findByText('PAY-B'));
    gB.open();
    await screen.findByText('B-BILL');
    gA.open();
    await flush();
    expect(screen.queryByText('A-BILL')).toBeNull();
    expect(screen.getByText('B-BILL')).toBeTruthy();
    expect(screen.getByText(/Invoices for B/)).toBeTruthy();
  });

  it('customer-allocations: pick A then B, A answers last: B\'s invoices stay', async () => {
    const gA = gate(); const gB = gate();
    serve(
      on('GET', '/api/accounting/customer-payments', () => ok({ payments: [
        { id: 'r1', paymentNumber: 'REC-A', clientName: 'A', clientId: 'k1', paymentDate: '2026-11-01', totalAmount: 500, allocatedAmount: 0 },
        { id: 'r2', paymentNumber: 'REC-B', clientName: 'B', clientId: 'k2', paymentDate: '2026-11-01', totalAmount: 500, allocatedAmount: 0 }] })),
      async (u, m) => {
        if (m !== 'GET' || !u.includes('/api/accounting/customer-invoices-list')) return undefined;
        const a = urlParam(u, 'client_id') === 'k1';
        await (a ? gA : gB).wait;
        return ok({ invoices: [{ ...CUSTOMER_INVOICES[0]!, id: a ? 'ca' : 'cb', invoice_number: a ? 'A-INV' : 'B-INV' }], total: 1 });
      },
    );
    render(<CustomerAllocationsPage />);
    fireEvent.click(await screen.findByText('REC-A'));
    fireEvent.click(await screen.findByText('REC-B'));
    gB.open();
    await screen.findByText('B-INV');
    gA.open();
    await flush();
    expect(screen.queryByText('A-INV')).toBeNull();
    expect(screen.getByText('B-INV')).toBeTruthy();
  });

  it('write-offs: pick client A then B, A answers last: only B\'s invoices are offered', async () => {
    const gA = gate(); const gB = gate();
    serve(
      on('GET', '/api/accounting/customers', () => ok([{ id: 'k1', name: 'Client A' }, { id: 'k2', name: 'Client B' }])),
      on('GET', '/api/accounting/write-offs', () => ok([])),
      async (u, m) => {
        if (m !== 'GET' || !u.includes('/api/accounting/customer-invoices-list')) return undefined;
        const a = urlParam(u, 'client_id') === 'k1';
        await (a ? gA : gB).wait;
        return ok({ invoices: [{ ...CUSTOMER_INVOICES[0]!, id: a ? 'ca' : 'cb', invoice_number: a ? 'A-INV' : 'B-INV' }], total: 1 });
      },
    );
    render(<WriteOffsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /new|add|write.?off/i }));
    const clientSelect = (await screen.findAllByRole('combobox'))[0] as HTMLSelectElement;
    await screen.findByRole('option', { name: /Client B/ });
    fireEvent.change(clientSelect, { target: { value: 'k1' } });
    fireEvent.change(clientSelect, { target: { value: 'k2' } });
    gB.open();
    await screen.findByRole('option', { name: /B-INV/ });
    gA.open();
    await flush();
    expect(screen.queryByRole('option', { name: /A-INV/ })).toBeNull();
    expect(screen.getByRole('option', { name: /B-INV/ })).toBeTruthy();
  });
});

describe('fetchAllPages: distinct rows', () => {
  const mk = (...ids: string[]) => ids.map(id => ({ id }));
  it('a row repeated at a page boundary is listed once, and paging stops when the distinct ids reach total', async () => {
    const pages = [mk('a', 'b'), mk('b', 'c')];
    let calls = 0;
    const out = await fetchAllPages(async i => { calls++; return { rows: pages[i] ?? [], total: 3 }; });
    expect(out.rows.map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(out).toMatchObject({ total: 3, truncated: false });
    expect(calls).toBe(2);
  });
  it('a server that keeps repeating the same rows ends truncated at the cap, with the distinct count', async () => {
    const out = await fetchAllPages(async () => ({ rows: mk('a', 'b'), total: 99 }), 3);
    expect(out.rows).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });
});

describe('truncation and paging on the pages', () => {
  it('customer-allocations: an endless list shows "Showing N of M" from MAX_PAGES', async () => {
    serve(customerPayment, (u, m) => {
      if (m !== 'GET' || !u.includes('/api/accounting/customer-invoices-list')) return undefined;
      const page = Number(urlParam(u, 'page'));
      return ok({ invoices: Array.from({ length: CUSTOMER_PAGE_SIZE }, (_, i) => ({ ...CUSTOMER_INVOICES[0]!, id: `c${page}-${i}`, invoice_number: `CI-${page}-${i}` })), total: 1_000_000 });
    });
    render(<CustomerAllocationsPage />);
    fireEvent.click(await screen.findByText('REC-1'));
    expect((await screen.findByRole('alert')).textContent).toContain(`Showing ${MAX_PAGES * CUSTOMER_PAGE_SIZE} of 1000000`);
  });

  it('write-offs: an endless list shows the note in its own status line, not as an error', async () => {
    serve(
      on('GET', '/api/accounting/customers', () => ok([{ id: 'k1', name: 'Client A' }])),
      on('GET', '/api/accounting/write-offs', () => ok([])),
      (u, m) => {
        if (m !== 'GET' || !u.includes('/api/accounting/customer-invoices-list')) return undefined;
        const page = Number(urlParam(u, 'page'));
        return ok({ invoices: Array.from({ length: CUSTOMER_PAGE_SIZE }, (_, i) => ({ ...CUSTOMER_INVOICES[0]!, id: `w${page}-${i}`, invoice_number: `W-${page}-${i}` })), total: 1_000_000 });
      },
    );
    render(<WriteOffsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /new|add|write.?off/i }));
    const clientSelect = (await screen.findAllByRole('combobox'))[0] as HTMLSelectElement;
    await screen.findByRole('option', { name: /Client A/ });
    fireEvent.change(clientSelect, { target: { value: 'k1' } });
    const note = await screen.findByRole('status');
    expect(note.textContent).toContain(`Showing ${MAX_PAGES * CUSTOMER_PAGE_SIZE} of 1000000`);
    expect(document.body.textContent).not.toMatch(/Could not load/);
  });

  const payment = (kind: 'supplier' | 'customer', i: number) => kind === 'supplier'
    ? { id: `p${i}`, paymentNumber: `PAY-${i}`, supplierName: 'S', supplierId: 's1', paymentDate: '2026-11-01', totalAmount: 10, allocatedAmount: 0 }
    : { id: `r${i}`, paymentNumber: `REC-${i}`, clientName: 'C', clientId: 'k1', paymentDate: '2026-11-01', totalAmount: 10, allocatedAmount: 0 };

  it.each([['supplier', SupplierAllocationsPage], ['customer', CustomerAllocationsPage]] as const)(
    '%s payments: 201 payments take two requests (offset 0, 200) and all 201 are counted', async (kind, Page) => {
      const all = Array.from({ length: 201 }, (_, i) => payment(kind, i));
      serve((u, m) => {
        if (m !== 'GET' || !u.includes(`/api/accounting/${kind}-payments`)) return undefined;
        const off = Number(urlParam(u, 'offset'));
        return ok({ payments: all.slice(off, off + PAYMENT_PAGE_SIZE), total: 201 });
      });
      render(<Page />);
      await screen.findByText(/201 (payment|receipt)\(s\)/);
      const reqs = calls().filter(u => u.includes(`/api/accounting/${kind}-payments`));
      expect(reqs.map(u => urlParam(u, 'offset'))).toEqual(['0', '200']);
      expect(reqs.every(u => urlParam(u, 'limit') === '200')).toBe(true);
      expect(screen.queryByRole('status')).toBeNull();
    });

  it.each([['supplier', SupplierAllocationsPage], ['customer', CustomerAllocationsPage]] as const)(
    '%s payments: an endless list says "Showing N of M" rather than hiding the rest', async (kind, Page) => {
      serve((u, m) => {
        if (m !== 'GET' || !u.includes(`/api/accounting/${kind}-payments`)) return undefined;
        const off = Number(urlParam(u, 'offset'));
        return ok({ payments: Array.from({ length: PAYMENT_PAGE_SIZE }, (_, i) => payment(kind, off + i)), total: 1_000_000 });
      });
      render(<Page />);
      expect((await screen.findByRole('status')).textContent).toContain(`Showing ${MAX_PAGES * PAYMENT_PAGE_SIZE} of 1000000`);
    });

  it('customer-allocations: a row repeated across the page boundary is listed once', async () => {
    const all = Array.from({ length: 101 }, (_, i) => ({ ...CUSTOMER_INVOICES[0]!, id: `c${i}`, invoice_number: `CI-${i}` }));
    serve(customerPayment, (u, m) => {
      if (m !== 'GET' || !u.includes('/api/accounting/customer-invoices-list')) return undefined;
      const page = Number(urlParam(u, 'page'));
      return ok({ invoices: page === 1 ? all.slice(0, 100) : all.slice(99), total: 101 }); // page 2 repeats c99
    });
    render(<CustomerAllocationsPage />);
    fireEvent.click(await screen.findByText('REC-1'));
    await screen.findByText('CI-100');
    expect(screen.getAllByRole('checkbox')).toHaveLength(101);
  });
});
