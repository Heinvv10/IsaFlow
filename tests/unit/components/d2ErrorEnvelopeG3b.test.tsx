/**
 * D2 (action sites): builder run/save, disclosure-notes save, caseware auto-suggest. The real error envelope
 * `{ success:false, error:{ code, message } }` must reach the user, not the generic fallback.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/accounting/reports/ReportBuilderFilters', () => ({ ReportBuilderFilters: () => null }));
vi.mock('@/components/accounting/reports/ReportBuilderPreview', () => ({ ReportBuilderPreview: (p: { rowCount: number }) => (p.rowCount > 0 ? <div>{`ran ${p.rowCount} rows`}</div> : null) }));
vi.mock('@/components/accounting/reports/ReportBuilderSidebar', () => ({
  ReportBuilderSidebar: (p: { onSourceChange: (s: string) => void; onAddField: (f: { field: string; label: string; type: string }) => void }) => (
    <div>
      <button onClick={() => p.onSourceChange('gl_transactions')}>pick source</button>
      <button onClick={() => p.onAddField({ field: 'amount', label: 'Amount', type: 'number' })}>add field</button>
    </div>
  ),
}));

import { apiFetch } from '@/lib/apiFetch';
import BuilderPage from '../../../pages/accounting/reports/builder';
import DisclosureNotesPage from '../../../pages/accounting/reports/disclosure-notes';
import CaseWareExportPage from '../../../pages/accounting/reports/caseware-export';

useApiJsonOverMock();
afterEach(cleanup);
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ success: true, data });
const refuse = (msg: string, status: number) => json({ success: false, error: { code: 'REFUSED', message: msg } }, status);

/** Refuses the request for which `isTarget(path, method)` is true; answers everything else with success. */
function script(isTarget: (path: string, method: string) => boolean, msg: string, status: number, okData: unknown = {}) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const method = String((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    return isTarget(String(url), method) ? refuse(msg, status) : ok(okData);
  });
}

async function configureBuilder() {
  render(<BuilderPage />);
  fireEvent.click(screen.getByText('pick source'));
  fireEvent.click(screen.getByText('add field'));
}

describe('report builder toast shows the server message', () => {
  it('when running the report is refused', async () => {
    const msg = 'D2 server says no: builder run refused';
    script((p) => p.endsWith('/custom-reports-run'), msg, 422, { fields: [] });
    await configureBuilder();
    fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
    expect(await screen.findByText(msg)).toBeTruthy();
  });

  it('when saving the report is refused', async () => {
    const msg = 'D2 server says no: builder save refused';
    script((p, m) => p.endsWith('/custom-reports') && m === 'POST', msg, 409, { fields: [] });
    await configureBuilder();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(msg)).toBeTruthy();
  });
});

it('disclosure-notes shows the server message when saving a manual note is refused', async () => {
  const msg = 'D2 server says no: manual note refused';
  script((p, m) => p.includes('disclosure-notes-manual') && m === 'POST', msg, 400, { notes: [] });
  render(<DisclosureNotesPage />);
  fireEvent.click(await screen.findByRole('button', { name: /add note/i }));
  fireEvent.change(screen.getByPlaceholderText(/subsequent events/i), { target: { value: 'Title' } });
  fireEvent.change(screen.getByPlaceholderText(/enter note content/i), { target: { value: 'Body' } });
  fireEvent.click(screen.getByRole('button', { name: /save note/i }));
  expect(await screen.findByText(new RegExp(msg))).toBeTruthy();
});

it('caseware-export shows the server message when auto-suggest is refused', async () => {
  const msg = 'D2 server says no: auto-suggest refused';
  script((p, m) => p.includes('account-mappings') && m === 'POST', msg, 500, { items: [] });
  render(<CaseWareExportPage />);
  fireEvent.click(await screen.findByRole('button', { name: /auto-suggest/i }));
  expect(await screen.findByText(new RegExp(msg))).toBeTruthy();
});

describe('success: the actions complete', () => {
  it('success: builder run completes and hands the result to the preview', async () => {
    script(() => false, '', 0, { fields: [], columns: [], rows: [], totals: {}, rowCount: 4242 });
    await configureBuilder();
    fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
    expect(await screen.findByText('ran 4242 rows')).toBeTruthy();
  });

  it('success: builder save completes', async () => {
    script(() => false, '', 0, { fields: [], id: 'rep-1' });
    await configureBuilder();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText('Report saved successfully')).toBeTruthy();
  });

  it('success: disclosure-notes save completes and reloads the list', async () => {
    let saved = false;
    vi.mocked(apiFetch).mockReset().mockImplementation(async (_url, init) => {
      if (String((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST') { saved = true; return ok({}); }
      return ok({ notes: saved ? [{ noteNumber: 20, title: 'Quasar Subsequent Event', content: 'c', source: 'manual', id: 'n1' }] : [] });
    });
    render(<DisclosureNotesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add note/i }));
    fireEvent.change(screen.getByPlaceholderText(/subsequent events/i), { target: { value: 'Title' } });
    fireEvent.change(screen.getByPlaceholderText(/enter note content/i), { target: { value: 'Body' } });
    fireEvent.click(screen.getByRole('button', { name: /save note/i }));
    expect(await screen.findByText('Quasar Subsequent Event')).toBeTruthy();
    expect(screen.queryByPlaceholderText(/enter note content/i)).toBeNull();
  });

  it('success: caseware-export auto-suggest completes', async () => {
    script(() => false, '', 0, { items: [], applied: 3 });
    render(<CaseWareExportPage />);
    fireEvent.click(await screen.findByRole('button', { name: /auto-suggest/i }));
    expect(await screen.findByText('Auto-suggested 3 account codes')).toBeTruthy();
  });
});
