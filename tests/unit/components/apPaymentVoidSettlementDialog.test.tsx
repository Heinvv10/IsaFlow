// R-127 L1: the Void confirmation says what Void will do. A plain processed
// payment reverses its journal (DR Bank / CR AP). A bank-first SETTLEMENT payment
// (settlesProvisionalJeId set) does something else: it undoes the settlement,
// reverses the bank-first provisional, and frees the bank line for allocation.
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
const payment = (extra: Record<string, unknown> = {}) => ({ id: 'p1', paymentNumber: 'SP-1', supplierId: 1,
  supplierName: 'S', paymentDate: '2026-09-21', totalAmount: 115, paymentMethod: 'eft', status: 'processed',
  allocations: [], ...extra });

afterEach(() => vi.mocked(apiFetch).mockReset());

it('a settlement payment\'s Void says it reverses the settlement and the provisional and frees the bank line', async () => {
  query.paymentId = 'p1';
  vi.mocked(apiFetch).mockImplementation(async () => ok(payment({ settlesProvisionalJeId: 'je-prov' })));
  render(<PaymentDetail />);
  fireEvent.click(await screen.findByRole('button', { name: 'Void (reverse journal)' }));
  expect(await screen.findByText(/reverses the settlement and the bank-first provisional journal/)).toBeTruthy();
  expect(screen.getByText(/frees the bank line for allocation/)).toBeTruthy();
  expect(screen.queryByText(/DR Bank \/ CR Accounts Payable/)).toBeNull();
});

it('a plain processed payment\'s Void keeps the journal-reversal copy', async () => {
  query.paymentId = 'p1';
  vi.mocked(apiFetch).mockImplementation(async () => ok(payment()));
  render(<PaymentDetail />);
  fireEvent.click(await screen.findByRole('button', { name: 'Void (reverse journal)' }));
  expect(await screen.findByText(/DR Bank \/ CR Accounts Payable/)).toBeTruthy();
  expect(screen.queryByText(/bank-first provisional/)).toBeNull();
});
