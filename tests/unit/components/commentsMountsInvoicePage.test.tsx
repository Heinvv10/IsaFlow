// M14: a mention's invoice link opens the FULL invoice page, which mounts the CommentsPanel on that invoice.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, ok, routerEvents, serveInvoice } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/sars/MarkVatDeclaredElsewhereButton', () => ({ MarkVatDeclaredElsewhereButton: () => null }));
vi.mock('@/components/accounting/comments/CommentsPanel', () => ({
  CommentsPanel: (p: { recordType: string; recordId: string }) => <div data-testid="panel" data-type={p.recordType} data-id={p.recordId} />,
}));

import ViewPage from '../../../pages/accounting/customer-invoices/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(apiFetch).mockReset(); });

const VIEW = {
  id: 'inv-1', invoice_number: 'INV-1', client_name: 'Client', client_email: 'c@client.example', project_name: '', status: 'approved',
  invoice_date: '2026-09-01', due_date: '2026-10-01', due_date_source: 'manual', subtotal: 100, tax_rate: 0, tax_amount: 0, total_amount: 100,
  amount_paid: 0, notes: '', gl_journal_entry_id: null, currency_code: 'ZAR', exchange_rate: 1,
  items: [{ id: 'l-1', description: 'Line', quantity: 1, unit_price: 100, amount: 100, tax_rate: 0 }], approval: null,
};

describe('the full invoice page', () => {
  it('mounts the comments panel on this invoice', async () => {
    serveInvoice((u) => (u.includes('adjacent') ? ok({ prevId: null, nextId: null }) : undefined), VIEW);
    render(<ViewPage />);
    for (let i = 0; i < 8; i++) await advance(0);
    const panel = screen.getByTestId('panel');
    expect([panel.dataset.type, panel.dataset.id]).toEqual(['customer_invoice', 'inv-1']);
  });
});
