// Cancel vs Void on the AP pages. Cancel is offered only where no money has
// moved (draft / approved) and says so; Void is offered for a processed payment
// and says it reverses the journal. An approved batch has a Cancel control too.
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const query: Record<string, string> = {};
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', activeCompany: { id: 'c1' } }) })); // BatchBankFileNotice reads the role
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import BatchDetail from '../../../pages/accounting/batch-payments/[batchId]';
import PaymentDetail from '../../../pages/accounting/supplier-payments/[paymentId]';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const payment = (status: string) => ({ id: 'p1', paymentNumber: 'SP-1', supplierId: 1, supplierName: 'S',
  paymentDate: '2026-09-21', totalAmount: 100, paymentMethod: 'eft', status, allocations: [] });

afterEach(() => vi.mocked(apiFetch).mockReset());

it.each(['draft', 'approved'])('a %s payment offers Cancel, explains it posts nothing, and sends action=cancel', async (status) => {
  query.paymentId = 'p1';
  const bodies: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('supplier-payments-action')) { bodies.push(String(init?.body)); return ok({ status: 'cancelled' }); }
    return ok(payment(status));
  });
  render(<PaymentDetail />);
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel payment' }));
  expect(screen.queryByRole('button', { name: /Void/ })).toBeNull();
  expect(await screen.findByText(/Nothing has been posted for this payment yet/)).toBeTruthy();
  expect(screen.getByText(/use Void instead/)).toBeTruthy();
  const confirm = screen.getAllByRole('button', { name: 'Cancel payment' }).at(-1)!;
  fireEvent.click(confirm);
  await vi.waitFor(() => expect(bodies).toEqual([JSON.stringify({ action: 'cancel', paymentId: 'p1' })]));
});

it('a processed payment offers Void (reverse journal), never Cancel', async () => {
  query.paymentId = 'p1';
  vi.mocked(apiFetch).mockImplementation(async () => ok(payment('processed')));
  render(<PaymentDetail />);
  fireEvent.click(await screen.findByRole('button', { name: 'Void (reverse journal)' }));
  expect(screen.queryByRole('button', { name: 'Cancel payment' })).toBeNull();
  expect(await screen.findByText(/Void reverses its journal/)).toBeTruthy();
});

it('an approved batch shows a Cancel control', async () => {
  query.batchId = 'b1';
  vi.mocked(apiFetch).mockImplementation(async () => ok({ id: 'b1', batchNumber: 'BAT-1', batchDate: '2026-09-21',
    totalAmount: 100, paymentCount: 1, paymentMethod: 'eft', status: 'approved', payments: [] }));
  render(<BatchDetail />);
  expect(await screen.findByRole('button', { name: /Cancel/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Process/ })).toBeTruthy();
});

it('an allocation row shows its invoice number and rand amount, not the UUID and "RNaN"', async () => {
  query.paymentId = 'p1';
  vi.mocked(apiFetch).mockImplementation(async () => ok({ ...payment('approved'),
    allocations: [{ id: 'a1', paymentId: 'p1', invoiceId: 'i-uuid', amountAllocated: 1234.5, invoiceNumber: 'INV-42' }] }));
  const { container } = render(<PaymentDetail />);
  expect(await screen.findByText('INV-42')).toBeTruthy();
  expect(container.textContent).not.toContain('NaN');
  expect(container.textContent).toMatch(/1[\s\u00a0]?234\.50/);
});

it('a batch member offers no Process, Void or Cancel, and links to its batch', async () => {
  query.paymentId = 'p1';
  vi.mocked(apiFetch).mockImplementation(async () => ok({ ...payment('approved'), batchId: 'b9' }));
  render(<PaymentDetail />);
  expect(await screen.findByText(/managed in its batch/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'open the batch' }).getAttribute('href')).toBe('/accounting/batch-payments/b9');
  for (const name of [/Process/, /Void/, 'Cancel payment']) expect(screen.queryByRole('button', { name })).toBeNull();
});

it.each(['processed', 'approved', 'reversed'])('Reverse batch appears only on a processed batch (%s)', async (status) => {
  query.batchId = 'b1';
  vi.mocked(apiFetch).mockImplementation(async () => ok({ id: 'b1', batchNumber: 'BAT-1', batchDate: '2026-09-21',
    totalAmount: 600, paymentCount: 3, paymentMethod: 'eft', status, payments: [], billCount: 2 }));
  render(<BatchDetail />);
  await screen.findByText('BAT-1');
  const button = screen.queryByRole('button', { name: /Reverse batch/ });
  if (status !== 'processed') { expect(button).toBeNull(); return; }
  fireEvent.click(button!);
  expect(await screen.findByText(/posts a reversing journal .* and reopens 2 bills/)).toBeTruthy();
});
