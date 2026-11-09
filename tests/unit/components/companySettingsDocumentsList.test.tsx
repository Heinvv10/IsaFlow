// Company settings > Statutory Documents: GET company-documents answers `{ data: { items: [...] } }`.
// The page and the post-upload refresh both read `data.items`; reading `data` as the array showed
// "No documents uploaded yet." for every company that had documents.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CompanySettingsPage from '../../../pages/accounting/company-settings';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ activeCompany: { id: 'company-a' }, loading: false }), useCompanyRoleOrNull: () => 'owner',
}));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { tab: 'details' } }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

const COR = { id: 'doc-1', documentType: 'cipc_certificate', documentName: 'COR14.3.pdf', mimeType: 'application/pdf',
  fileSize: 2048, uploadedAt: '2026-11-09T08:00:00.000Z', notes: null };
const SHARE = { ...COR, id: 'doc-2', documentType: 'share_certificate', documentName: 'Share cert.pdf' };
let listed: unknown[] = [COR];
let afterUpload: unknown[] = [SHARE, COR];

beforeEach(() => {
  listed = [COR];
  afterUpload = [SHARE, COR];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.startsWith('/api/accounting/companies?')) return Response.json({ success: true, data: { id: 'company-a', name: 'Example Co' } });
    if (u === '/api/accounting/company-documents' && init?.method === 'POST') {
      listed = afterUpload;
      return Response.json({ success: true, data: { id: 'doc-2' } });
    }
    if (u.startsWith('/api/accounting/company-documents?companyId=company-a')) {
      return Response.json({ success: true, data: { items: listed }, meta: {} });
    }
    if (u.includes('financial-year-end-change')) return new Response('{}', { status: 503 });
    return Response.json({ success: true, data: [] });
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const docRows = () => screen.getAllByRole('row').slice(1);

it('lists the stored document, with its upload date, instead of "No documents uploaded yet."', async () => {
  render(<CompanySettingsPage />);
  const cell = await screen.findByText('COR14.3.pdf');
  expect(screen.queryByText(/No documents uploaded yet/)).toBeNull();
  expect(docRows()).toHaveLength(1);
  expect(within(cell.closest('tr') as HTMLElement).getByText('09 Nov 2026')).toBeTruthy();
});

it('a fresh upload refreshes the list from data.items', async () => {
  const { container } = render(<CompanySettingsPage />);
  await screen.findByText('COR14.3.pdf');
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'.repeat(2048)], 'Share cert.pdf', { type: 'application/pdf' })] } });
  await screen.findByText('Share cert.pdf');
  await waitFor(() => expect(docRows()).toHaveLength(2));
  expect(screen.getByText('COR14.3.pdf')).toBeTruthy();
});

it('a list in any other shape is reported, not shown as "No documents uploaded yet."', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/api/accounting/companies?')) return Response.json({ success: true, data: { id: 'company-a', name: 'Example Co' } });
    if (u.includes('financial-year-end-change')) return new Response('{}', { status: 503 });
    return Response.json({ success: true, data: [COR] }); // bare array: not the documents list shape
  });
  render(<CompanySettingsPage />);
  await screen.findByText(/Could not load the statutory documents/);
});

it('a refresh in any other shape after an upload is reported', async () => {
  const { container } = render(<CompanySettingsPage />);
  await screen.findByText('COR14.3.pdf');
  afterUpload = [{ id: 7, documentName: null }];
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'.repeat(2048)], 'Share cert.pdf', { type: 'application/pdf' })] } });
  await screen.findByText(/uploaded but the list could not be refreshed/);
  expect(screen.getByText('COR14.3.pdf')).toBeTruthy();
});

it('an earlier load error is kept when the documents list is also in another shape', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/api/accounting/companies?')) return Response.json({ success: true, data: { id: 'company-a', name: 'Example Co' } });
    if (u.includes('type=messages')) return new Response('{}', { status: 500 });
    if (u.includes('financial-year-end-change')) return new Response('{}', { status: 503 });
    return Response.json({ success: true, data: [COR] });
  });
  render(<CompanySettingsPage />);
  await screen.findByText(/Could not load some company settings/);
  expect(screen.queryByText(/Could not load the statutory documents/)).toBeNull();
});
