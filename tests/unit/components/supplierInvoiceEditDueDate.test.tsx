/**
 * The supplier bill page and the due date (payment-terms programme): its edit form names the due date only when the user
 * changed it (an out-of-date copy sent back would undo a Re-apply and record the date as set by hand), and the posted
 * bill's due-date editor is mounted with the stored source.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' } }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ap/ThreeWayMatchPanel', () => ({ ThreeWayMatchPanel: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierInvoiceDetailPage from '../../../pages/accounting/supplier-invoices/[invoiceId]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const invoice = {
  id: 'inv-1', invoiceNumber: 'INV-001', supplierName: 'Acme Supplies', status: 'draft', invoiceDate: '2026-03-01',
  dueDate: '2026-03-31', dueDateSource: 'terms', paymentTerms: '30 days', subtotal: 1000, taxAmount: 150, taxRate: 15,
  totalAmount: 1150, balance: 1150, notes: '', items: [],
};
const ok = (data: unknown) => ({ ok: true, json: () => Promise.resolve({ data }) });
const puts = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
const putBody = () => JSON.parse(String((puts()[0]![1] as RequestInit).body)) as Record<string, unknown>;

beforeEach(() => { cleanup(); fetchMock.mockReset(); });

describe('the edit form names the due date only when the user changed it', () => {
  it('a save with the due date untouched sends no dueDate', async () => {
    fetchMock.mockResolvedValueOnce(ok(invoice));
    render(<SupplierInvoiceDetailPage />);
    fireEvent.click(await screen.findByText('Edit'));
    fetchMock.mockImplementation(async (_u: unknown, init?: RequestInit) => ok(init?.method === 'PUT' ? {} : invoice));
    fireEvent.click(await screen.findByText('Save'));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = putBody();
    expect(body.id).toBe('inv-1');
    expect('dueDate' in body).toBe(false);
  });

  it('a due date the user changed is sent', async () => {
    fetchMock.mockResolvedValueOnce(ok(invoice));
    render(<SupplierInvoiceDetailPage />);
    fireEvent.click(await screen.findByText('Edit'));
    typeDate(await screen.findByLabelText('Due Date'), '15 Apr 2026');
    fetchMock.mockImplementation(async (_u: unknown, init?: RequestInit) => ok(init?.method === 'PUT' ? {} : invoice));
    fireEvent.click(await screen.findByText('Save'));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody().dueDate).toBe('2026-04-15');
  });
});

describe('the posted bill\'s due-date editor', () => {
  it.each([['approved', true], ['partially_paid', true], ['draft', false], ['paid', false]])('a %s bill: editor shown = %s, with the stored source', async (status, shown) => {
    fetchMock.mockResolvedValueOnce(ok({ ...invoice, status, dueDateSource: 'manual' }));
    render(<SupplierInvoiceDetailPage />);
    await screen.findByRole('heading', { name: 'INV-001' });
    expect(Boolean(screen.queryByText('Change due date'))).toBe(shown);
    expect(Boolean(screen.queryByText('(Set by hand)'))).toBe(shown);
  });
});
