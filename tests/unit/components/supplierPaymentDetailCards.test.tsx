// Supplier payment detail: the allocation table becomes labelled cards below lg; the back link, actions and links are 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ payment: {} as Record<string, unknown> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { paymentId: 'p1' }, asPath: '/', isReady: true, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/components/accounting/ap/PaymentDetailsCard', () => ({ PaymentDetailsCard: () => null }));
vi.mock('@/components/accounting/approvals/DocumentApprovalPanel', () => ({ DocumentApprovalPanel: () => null, isApprovalHeld: () => false }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.payment }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/supplier-payments/[paymentId]';

afterEach(cleanup);
const base = {
  id: 'p1', paymentNumber: 'SP-0001', supplierId: 1, supplierName: 'Acme Supplies', paymentDate: '2026-11-01', totalAmount: 300,
  paymentMethod: 'eft', status: 'draft', journalEntryId: 'abcdef12-3456',
  allocations: [{ id: 'a1', invoiceId: 'i1', invoiceNumber: 'SI-1', amountAllocated: 100 }, { id: 'a2', invoiceId: 'i2', invoiceNumber: 'SI-2', amountAllocated: 200 }],
};
const min = (el: Element, name: string) => expect(el.className, name).toContain('max-lg:min-h-11');

describe('Supplier payment detail on touch', () => {
  it('turns the allocation table into labelled cards, totals row included', async () => {
    state.payment = base;
    const { container } = render(<Page />);
    await screen.findByText('SI-1');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(['Invoice', 'Amount Allocated']);
    const rows = [...table.querySelectorAll(':scope > tbody > tr')];
    expect(rows).toHaveLength(3); // two allocations and the Total row
    const labels = (r: Element) => [...r.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'));
    for (const r of rows.slice(0, 2)) expect(labels(r)).toEqual(['Invoice', 'Amount Allocated']);
    expect(labels(rows[2])).toEqual([null, 'Amount Allocated']); // the Total cell heads its card instead of reading "INVOICE Total"
  });

  it('makes the back link, draft actions and GL journal link 44px, and the header wraps', async () => {
    state.payment = base;
    render(<Page />);
    await screen.findByText('SI-1');
    const back = screen.getByRole('link', { name: '' });
    expect(back.getAttribute('href')).toBe('/accounting/supplier-payments');
    for (const c of ['max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center']) expect(back.className).toContain(c);
    for (const name of [/Approve/, /Cancel payment/]) min(screen.getByRole('button', { name }), String(name));
    min(screen.getByRole('link', { name: /abcdef12/ }), 'journal link');
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.parentElement!.parentElement!.className).toContain('max-lg:flex-wrap'); // back + icon + title + badge
    expect(title.parentElement!.parentElement!.parentElement!.className).toContain('max-lg:flex-wrap'); // title group + actions
    expect(screen.getByRole('button', { name: /Approve/ }).parentElement!.className).toContain('max-lg:flex-wrap');
  });

  it('makes Unapply and Void 44px on a processed payment', async () => {
    state.payment = { ...base, status: 'processed' };
    render(<Page />);
    await screen.findByText('SI-1');
    for (const name of [/Unapply/, /Void/]) min(screen.getByRole('button', { name }), String(name));
  });

  it('makes Process 44px on an approved payment', async () => {
    state.payment = { ...base, status: 'approved' };
    render(<Page />);
    await screen.findByText('SI-1');
    min(screen.getByRole('button', { name: /Process/ }), 'Process');
  });

  it('makes the batch link 44px on a batch member', async () => {
    state.payment = { ...base, batchId: 'b1' };
    render(<Page />);
    await screen.findByText('SI-1');
    min(screen.getByRole('link', { name: /open the batch/ }), 'batch link');
  });
});
