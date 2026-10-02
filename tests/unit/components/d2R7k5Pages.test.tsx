// D2 round 7 (k5): a failed response must never be dropped without a word. Portal comment, AP template download,
// approvals / jobs filter loads, missing-invoices chase settings, bulk-update cost centres, my-reports delete.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/head', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/lib/fetchAllSuppliers', () => ({ fetchAllSuppliers: async () => ({ suppliers: [], truncated: false }), truncatedSuppliersNotice: () => '' }));
vi.mock('@/components/practice/KanbanBoard', () => ({ KanbanBoard: () => null }));
vi.mock('@/components/accounting/suppliers/MissingInvoiceModals', () => ({ MissingInvoiceModals: () => null }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));

import PortalDocumentPage from '../../../pages/accounting/afs/portal/documents/[documentId]';
import ApInvoicesPage from '../../../pages/accounting/migration/ap-invoices';
import ApprovalsPage from '../../../pages/accounting/practice/approvals/index';
import JobsPage from '../../../pages/accounting/practice/jobs/index';
import MissingInvoicesPage from '../../../pages/accounting/suppliers/missing-invoices';
import BulkUpdatePage from '../../../pages/payroll/employees/bulk-update';
import MyReportsPage from '../../../pages/accounting/reports/my-reports';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(async () => { const { apiFetch } = await import('@/lib/apiFetch'); vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('portal document: submit a comment', () => {
  const props = {
    document: { id: 'd-1', document_type: 'afs', status: 'draft', fiscal_year: 2026 },
    sections: [{ id: 's-1', section_type: 'income_statement', content: null, ai_narrative: 'D2 narrative' }],
    canAnnotate: true,
  } as unknown as Parameters<typeof PortalDocumentPage>[0];
  const submit = async () => {
    render(<PortalDocumentPage {...props} />);
    fireEvent.click(await screen.findByText('+ Add comment'));
    fireEvent.change(screen.getByPlaceholderText(/add a comment/i), { target: { value: 'D2 please check' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  };
  it('400: the server message and the comment box stays open with the text', async () => {
    serve(on('POST', 'annotate', () => refuse()));
    await submit();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect((screen.getByPlaceholderText(/add a comment/i) as HTMLTextAreaElement).value).toBe('D2 please check');
    expect(screen.queryByText('Comment submitted.')).toBeNull();
  });
  it('empty 500: a plain sentence, no false success', async () => {
    serve(on('POST', 'annotate', () => empty500()));
    await submit();
    expect(await screen.findByText('Could not submit your comment - try again')).toBeDefined();
    expectNoJargon();
    expect(screen.queryByText('Comment submitted.')).toBeNull();
  });
  it('200: shows the comment as submitted', async () => {
    serve(on('POST', 'annotate', () => ok({})));
    await submit();
    expect(await screen.findByText('Comment submitted.')).toBeDefined();
  });
});

describe('AP invoice import: download template', () => {
  it('400: the server message (not a dead button)', async () => {
    serve(on('GET', 'migration/templates', () => refuse()));
    render(<ApInvoicesPage />);
    fireEvent.click(screen.getByRole('button', { name: /download csv template/i }));
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('empty 500: a plain sentence', async () => {
    serve(on('GET', 'migration/templates', () => empty500()));
    render(<ApInvoicesPage />);
    fireEvent.click(screen.getByRole('button', { name: /download csv template/i }));
    expect(await screen.findByText('Could not download the template - try again')).toBeDefined();
    expectNoJargon();
  });
  it('200: downloads the file and shows no error', async () => {
    const created = vi.fn(() => 'blob:d2');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    serve(on('GET', 'migration/templates', () => new Response('a,b', { status: 200 })));
    render(<ApInvoicesPage />);
    fireEvent.click(screen.getByRole('button', { name: /download csv template/i }));
    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(screen.queryByText(/could not download/i)).toBeNull();
  });
});

describe('practice approvals and jobs: filter loads', () => {
  const empty = ok({ entries: [], total: 0 });
  it('approvals: a refused client filter load shows the server message', async () => {
    serve(on('GET', 'practice/clients', () => refuse()), on('GET', 'time-entries', () => empty));
    render(<ApprovalsPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('approvals: an empty-500 user filter load shows a plain sentence', async () => {
    serve(on('GET', 'practice/users', () => empty500()), on('GET', 'time-entries', () => empty));
    render(<ApprovalsPage />);
    expect(await screen.findByText('Could not load the user filter - try again')).toBeDefined();
    expectNoJargon();
  });
  it('approvals: healthy loads show no filter error', async () => {
    serve(on('GET', 'time-entries', () => empty));
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    expect(screen.queryByText(/filter - try again/)).toBeNull();
  });
  it('jobs: a refused client filter load survives the jobs load (own message slot)', async () => {
    serve(on('GET', 'practice/clients', () => refuse()), on('GET', 'practice/jobs', () => ok({ jobs: [] })));
    render(<JobsPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('jobs: empty 500 -> plain sentence', async () => {
    serve(on('GET', 'practice/clients', () => empty500()), on('GET', 'practice/jobs', () => ok({ jobs: [] })));
    render(<JobsPage />);
    expect(await screen.findByText('Could not load the client filter - try again')).toBeDefined();
    expectNoJargon();
  });
});

describe('missing invoices: chase settings load', () => {
  it('400: the server message', async () => {
    serve(on('GET', 'chase-settings', () => refuse()), on('GET', 'expected-invoice-alerts', () => ok([])));
    render(<MissingInvoicesPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('empty 500: a plain sentence', async () => {
    serve(on('GET', 'chase-settings', () => empty500()), on('GET', 'expected-invoice-alerts', () => ok([])));
    render(<MissingInvoicesPage />);
    expect(await screen.findByText('Could not load the chase settings - try again')).toBeDefined();
    expectNoJargon();
  });
  it('200: the settings panel renders', async () => {
    serve(on('GET', 'chase-settings', () => ok({ chaseAutoSendEnabled: true, chaseGraceDays: 3, whatsappChaseEnabled: false })),
      on('GET', 'expected-invoice-alerts', () => ok([])));
    render(<MissingInvoicesPage />);
    expect(await screen.findByDisplayValue('3')).toBeDefined();
  });
});

describe('bulk update: cost centres load', () => {
  it('400: the server message', async () => {
    serve(on('GET', 'cost-centres', () => refuse()));
    render(<BulkUpdatePage />);
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('empty 500: a plain sentence', async () => {
    serve(on('GET', 'cost-centres', () => empty500()));
    render(<BulkUpdatePage />);
    expect(await screen.findByText('Could not load cost centres - try again')).toBeDefined();
    expectNoJargon();
  });
  it('200: lists the centres, no error', async () => {
    serve(on('GET', 'cost-centres', () => ok([{ id: 'cc-1', code: 'D2C', name: 'D2 Centre' }])));
    render(<BulkUpdatePage />);
    await waitFor(() => expect(document.body.textContent).toContain('D2 Centre'));
    expect(screen.queryByText(/could not load/i)).toBeNull();
  });
});

describe('my reports: delete', () => {
  const T = { id: 't-1', name: 'D2 Report', description: null, dataSource: 'customers', isShared: false, createdBy: 'u', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  const del = async (fail: (() => Response) | null) => {
    vi.stubGlobal('confirm', () => true);
    serve(on('DELETE', 'custom-reports', () => (fail ? fail() : ok({}))), on('GET', 'custom-reports', () => ok({ items: [T] })));
    render(<MyReportsPage />);
    await screen.findByText('D2 Report');
    fireEvent.click(document.querySelector('button[title="Delete"], button[aria-label="Delete"]') ?? screen.getAllByRole('button').find((b) => b.querySelector('svg.lucide-trash-2'))!);
  };
  it('400: the server message and the row stays', async () => {
    await del(() => refuse());
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByText('D2 Report')).toBeDefined();
  });
  it('empty 500: a plain sentence', async () => {
    await del(empty500);
    expect(await screen.findByText('Could not delete the report - try again')).toBeDefined();
    expectNoJargon();
  });
  it('200: the row goes', async () => {
    await del(null);
    expect(await screen.findByText('Report deleted')).toBeDefined();
    expect(screen.queryByText('D2 Report')).toBeNull();
  });
});
