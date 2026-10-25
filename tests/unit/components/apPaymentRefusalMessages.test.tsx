// The three AP pages that meet the K-063/K-064/K-066 refusals must show the
// refusal's own words. The 400 body is produced by `apiResponse.badRequest` —
// the serializer every one of those routes answers through — so the shape is
// the real `{ success: false, error: { code, message } }`, not a guess. Two of
// the pages rendered `json.error` (that object) and crashed React; the third
// read an absent `json.message` and showed "Failed".
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';
import type { ReactNode } from 'react';

const query: Record<string, string> = {};
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', activeCompany: { id: 'c1' } }) })); // BatchBankFileNotice reads the role
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { apiResponse } from '@/lib/apiResponse';
import BatchDetail from '../../../pages/accounting/batch-payments/[batchId]';
import PaymentDetail from '../../../pages/accounting/supplier-payments/[paymentId]';
import NewBatch from '../../../pages/accounting/batch-payments/new';

/** The exact body a route sends for `apiResponse.badRequest(res, message)`. */
function refusal(message: string): Response {
  let body: unknown;
  const res = { status: () => res, json: (b: unknown) => { body = b; return res; } } as unknown as NextApiResponse;
  apiResponse.badRequest(res, message);
  return new Response(JSON.stringify(body), { status: 400 });
}
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

afterEach(() => vi.mocked(apiFetch).mockReset());

it('batch detail shows why Process was refused', async () => {
  query.batchId = 'b1';
  const text = 'Invoice INV-9 is cancelled and cannot receive a payment.';
  vi.mocked(apiFetch).mockImplementation(async (url: string) => url.includes('batch-payments-action')
    ? refusal(text)
    : ok({ id: 'b1', batchNumber: 'BAT-1', batchDate: '2026-09-21', totalAmount: 100, paymentCount: 1,
      paymentMethod: 'eft', status: 'approved', payments: [] }));
  render(<BatchDetail />);
  fireEvent.click(await screen.findByText(/Process/));
  expect(await screen.findByText(text)).toBeTruthy();
});

it('payment detail shows why Process was refused', async () => {
  query.paymentId = 'p1';
  const text = 'Payment SP-1 belongs to batch b1 — process it through its batch.';
  vi.mocked(apiFetch).mockImplementation(async (url: string) => url.includes('supplier-payments-action')
    ? refusal(text)
    : ok({ id: 'p1', paymentNumber: 'SP-1', supplierId: 1, supplierName: 'S', paymentDate: '2026-09-21',
      totalAmount: 100, paymentMethod: 'eft', status: 'approved', allocations: [] }));
  render(<PaymentDetail />);
  fireEvent.click(await screen.findByText(/Process/));
  expect(await screen.findByText(text)).toBeTruthy();
});

// The supplier column is a server-searched SupplierSelect (PUR-01): open it and click the hit.
async function pickSupplier(container: HTMLElement, name: string) {
  fireEvent.focus(container.querySelector('input[name="supplierIdSearch"]')!);
  fireEvent.click(await screen.findByRole('button', { name }));
}

it('new batch shows why the batch was refused, not a bare "Failed"', async () => {
  const text = 'R1500.00 exceeds the R1000.00 outstanding on invoice INV-7.';
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    // The two lists in the shapes their routes really answer: suppliers-list
    // snake_case rows under `suppliers` (company_name often null), and
    // supplier-invoices camelCase under `invoices`.
    if (url.includes('suppliers-list')) {
      return ok({ suppliers: [{ id: 's1', name: 'Supplier One', company_name: null }], total: 1 });
    }
    if (url.includes('supplier-invoices')) {
      return ok({ invoices: [{ id: 'i1', supplierId: 's1', invoiceNumber: 'INV-7', totalAmount: 1000, amountPaid: 0 }] });
    }
    if (url.includes('reservedFor')) return ok({});
    return refusal(text);
  });
  const { container } = render(<NewBatch />);
  await pickSupplier(container, 'Supplier One');
  await screen.findByText(/INV-7/);
  fireEvent.change(container.querySelector('select[name="invoiceId"]')!, { target: { value: 'i1' } });
  fireEvent.change(container.querySelector('input[name="amount"]')!, { target: { value: '1500' } });
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByText(text)).toBeTruthy();
  expect(screen.queryByText('Failed')).toBeNull();
});

it('new batch offers a bill at what is still available after reservations, not its raw outstanding', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url.includes('suppliers-list')) return ok({ suppliers: [{ id: 's1', name: 'Supplier One', company_name: null }], total: 1 });
    if (url.includes('supplier-invoices')) {
      return ok({ invoices: [{ id: 'i1', supplierId: 's1', invoiceNumber: 'INV-5', totalAmount: 500, amountPaid: 0 }] });
    }
    if (url.includes('reservedFor=i1')) return ok({ i1: 200 });
    return ok({});
  });
  const { container } = render(<NewBatch />);
  await pickSupplier(container, 'Supplier One');
  const option = await screen.findByText(/INV-5/);
  expect(option.textContent).toMatch(/300\.00 available \(R\s?200\.00 reserved\)/);
  fireEvent.change(container.querySelector('select[name="invoiceId"]')!, { target: { value: 'i1' } });
  expect((container.querySelector('input[name="amount"]') as HTMLInputElement).value).toBe('300');
});

it('new batch still lists bills, at their outstanding, when reservations cannot be loaded — and says so', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url.includes('suppliers-list')) return ok({ suppliers: [{ id: 's1', name: 'Supplier One', company_name: null }], total: 1 });
    if (url.includes('supplier-invoices')) {
      return ok({ invoices: [{ id: 'i1', supplierId: 's1', invoiceNumber: 'INV-8', totalAmount: 500, amountPaid: 0 }] });
    }
    if (url.includes('reservedFor')) return refusal('reservedFor must be a comma-separated list of up to 500 bill ids.');
    return ok({});
  });
  const { container } = render(<NewBatch />);
  expect(await screen.findByRole('status')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('could not be loaded');
  await pickSupplier(container, 'Supplier One');
  const option = await screen.findByText(/INV-8/);
  expect(option.textContent).toMatch(/500\.00/);
  expect(option.textContent).not.toContain('reserved');
});
