// R-127: Unapply on the supplier payment page. A posted payment that pays bills
// can take its cash back off them without being voided — the payment stays, the
// bills reopen. It is also the first step of undoing a bank-first settlement,
// whose payment cannot be voided while it pays a bill.
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const query: Record<string, string> = {};
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import PaymentDetail from '../../../pages/accounting/supplier-payments/[paymentId]';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const allocation = { id: 'a1', paymentId: 'p1', invoiceId: 'i1', amountAllocated: 115, invoiceNumber: 'INV-7' };
const payment = (status: string, allocations: unknown[]) => ({ id: 'p1', paymentNumber: 'SP-1', supplierId: 1,
  supplierName: 'S', paymentDate: '2026-09-21', totalAmount: 115, paymentMethod: 'eft', status, allocations });

afterEach(() => vi.mocked(apiFetch).mockReset());

it.each(['processed', 'reconciled'])('a %s payment that pays bills offers Unapply, explains it, and sends action=unapply', async (status) => {
  query.paymentId = 'p1';
  const bodies: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('supplier-payments-action')) { bodies.push(String(init?.body)); return ok({}); }
    return ok(payment(status, [allocation]));
  });
  render(<PaymentDetail />);
  fireEvent.click(await screen.findByRole('button', { name: 'Unapply' }));
  expect(await screen.findByText(/reopens the bills it pays/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Unapply payment' }));
  await vi.waitFor(() => expect(bodies).toEqual([JSON.stringify({ action: 'unapply', paymentId: 'p1' })]));
});

it('a processed payment that pays nothing offers no Unapply', async () => {
  query.paymentId = 'p1';
  vi.mocked(apiFetch).mockImplementation(async () => ok(payment('processed', [])));
  render(<PaymentDetail />);
  expect(await screen.findByRole('button', { name: 'Void (reverse journal)' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Unapply' })).toBeNull();
});

it('a draft payment offers no Unapply', async () => {
  query.paymentId = 'p1';
  vi.mocked(apiFetch).mockImplementation(async () => ok(payment('draft', [allocation])));
  render(<PaymentDetail />);
  expect(await screen.findByRole('button', { name: 'Cancel payment' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Unapply' })).toBeNull();
});
