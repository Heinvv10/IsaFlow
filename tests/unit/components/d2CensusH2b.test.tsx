/**
 * D2 census group 2 (b): the report-builder field list and the supplier-statement PDF letterhead lookup used to
 * call res.json() with no ok check. A 400 must show the server's message, an empty-body 500 a plain sentence, and
 * a good 200 must reach the field list / the PDF. REAL assertOk / apiErrorMessage over a scripted apiFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/modules/accounting/utils/statementPdf', () => ({ generateStatementPdf: vi.fn(async () => new Blob(['pdf'])) }));
vi.mock('@/components/accounting/reports/ReportBuilderSidebar', () => ({
  ReportBuilderSidebar: (p: { onSourceChange: (s: string) => void }) => <button onClick={() => p.onSourceChange('d2src')}>pick source</button>,
}));
vi.mock('@/components/accounting/reports/ReportBuilderFilters', () => ({
  ReportBuilderFilters: (p: { availableFields: { field: string; label: string }[] }) => <div>{p.availableFields.map(f => <span key={f.field}>{f.label}</span>)}</div>,
}));
vi.mock('@/components/accounting/reports/ReportBuilderPreview', () => ({ ReportBuilderPreview: () => null }));
const router = vi.hoisted(() => ({ query: { supplierId: 's1' }, isReady: true, asPath: '/', push: vi.fn(), replace: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { generateStatementPdf } from '@/modules/accounting/utils/statementPdf';
import ReportBuilderPage from '../../../pages/accounting/reports/builder';
import SupplierStatementPage from '../../../pages/accounting/supplier-statements/[supplierId]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:d2');
  URL.revokeObjectURL = vi.fn();
  vi.mocked(notify.error).mockClear();
  vi.mocked(generateStatementPdf).mockClear();
});
afterEach(() => { cleanup(); });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bad = (m: string) => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: m } }), { status: 400 });
const MSG = 'D2 server says no: this data is not available';
const STATEMENT = {
  supplier: { id: 's1', name: 'D2 Supplier', email: '', phone: '' },
  transactions: [{ id: 1, date: '2026-01-01', type: 'invoice', reference: 'INV-D2-9', description: 'x', debit: 100, credit: 0, balance: 100 }],
  summary: { totalInvoiced: 100, totalPaid: 0, totalReturns: 0, balance: 100 },
};

describe('report builder: field list for the chosen source', () => {
  const run = async (answer: () => Response) => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => answer());
    render(<ReportBuilderPage />);
    fireEvent.click(screen.getByText('pick source'));
  };

  it('400: the server message is shown', async () => {
    await run(() => bad(MSG));
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
  });

  it('500 with an empty body: a plain sentence, not a JSON parse error', async () => {
    await run(() => new Response('', { status: 500 }));
    expect(await screen.findByText(/Could not load report fields - try again/)).toBeTruthy();
    expect(screen.queryByText(/JSON|Unexpected end/)).toBeNull();
  });

  it('200: the fields reach the filter bar', async () => {
    await run(() => ok({ fields: [{ field: 'f1', label: 'D2 Field One', type: 'text' }] }));
    expect(await screen.findByText('D2 Field One')).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });
});

describe('supplier statement: company details for the PDF letterhead', () => {
  const run = async (company: () => Response) => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => (String(url).includes('company-details') ? company() : ok(STATEMENT)));
    render(<SupplierStatementPage />);
    const btn = (await screen.findByText('PDF')).closest('button') as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
  };

  it('400: the server message is shown and no letterhead-less PDF is made', async () => {
    await run(() => bad(MSG));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(MSG));
    expect(generateStatementPdf).not.toHaveBeenCalled();
  });

  it('500 with an empty body: a plain sentence, not a JSON parse error', async () => {
    await run(() => new Response('', { status: 500 }));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not load your company details for the PDF - try again'));
    expect(JSON.stringify(vi.mocked(notify.error).mock.calls)).not.toMatch(/JSON|Unexpected end/);
    expect(generateStatementPdf).not.toHaveBeenCalled();
  });

  it('200: the PDF is generated with the company details', async () => {
    await run(() => ok({ name: 'D2 Company (Pty) Ltd', vat_number: '4123456789' }));
    await waitFor(() => expect(generateStatementPdf).toHaveBeenCalledWith(expect.objectContaining({ companyName: 'D2 Company (Pty) Ltd' })));
    expect(notify.error).not.toHaveBeenCalled();
  });
});
