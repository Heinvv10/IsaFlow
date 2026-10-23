/**
 * The report-templates page is for ONE document's period when it is opened from the AFS document page
 * (?document_id=): it forwards that id to the API, which derives the period from the registry, and shows
 * which period the wording is for. A failed load clears the previous wording rather than keep it beside the error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui', () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import ReportTemplatesPage from '../../../pages/accounting/afs/report-templates';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const body = (period: unknown, text = 'PRACTITIONER WORDING') => new Response(JSON.stringify({
  success: true,
  data: { reportType: 'compilation', entityType: 'pty', framework: 'ifrs_smes', period,
    templates: { practitionerReport: text, directorsResponsibility: 'r', directorsReport: 'd', generalInformation: 'g' } },
}), { status: 200 });
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => { fetchMock.mockReset(); router.query = {}; router.isReady = true; });
afterEach(cleanup);

describe('report templates page and document_id', () => {
  it('forwards document_id to the API and says which period the wording is for', async () => {
    router.query = { document_id: 'doc-1' };
    fetchMock.mockResolvedValue(body({ start: '2026-01-01', end: '2027-02-28', months: 14, phrase: '14 months ended 2027-02-28' }));
    render(<ReportTemplatesPage />);
    await screen.findByText('PRACTITIONER WORDING');
    expect(urls()).toEqual(['/api/accounting/afs/report-templates?type=compilation&entity_type=pty&framework=ifrs_smes&document_id=doc-1']);
    expect(screen.getByTestId('template-period').textContent).toBe('Wording for the 14 months ended 2027-02-28 (2026-01-01 to 2027-02-28).');
  });

  it('without a document it sends none and says the dates are placeholders', async () => {
    fetchMock.mockResolvedValue(body(null));
    render(<ReportTemplatesPage />);
    await screen.findByText('PRACTITIONER WORDING');
    expect(urls()[0]).not.toContain('document_id');
    expect(screen.getByTestId('template-period').textContent).toMatch(/placeholders/);
  });

  it('waits for the router before asking, so a document link is never answered without its id', async () => {
    router.isReady = false;
    router.query = {};
    render(<ReportTemplatesPage />);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed load clears the previous wording and period and shows the error', async () => {
    router.query = { document_id: 'doc-1' };
    fetchMock.mockResolvedValueOnce(body({ start: '2026-01-01', end: '2027-02-28', months: 14, phrase: '14 months ended 2027-02-28' }));
    render(<ReportTemplatesPage />);
    await screen.findByText('PRACTITIONER WORDING');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: { message: 'Financial year 2027 not found' } }), { status: 404 }));
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'audit' } });
    await waitFor(() => expect(screen.getByText(/Financial year 2027 not found|Could not load report templates/)).toBeTruthy());
    expect(screen.queryByText('PRACTITIONER WORDING')).toBeNull();
    expect(screen.queryByTestId('template-period')).toBeNull();
    expect(urls()[1]).toContain('type=audit&entity_type=pty&framework=ifrs_smes&document_id=doc-1');
  });
});
