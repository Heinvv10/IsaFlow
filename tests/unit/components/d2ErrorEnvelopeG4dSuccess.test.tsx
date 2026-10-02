/**
 * D2 success paths for the admin SARS codes actions in d2ErrorEnvelopeG4d: set-current and deprecate reload the
 * list without raising the alert; the import wizard reaches its done step with the server's result.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import SarsCodesPage from '../../../pages/admin/payroll/sars-codes';

void mockedApiFetchModule;
useApiJsonOverMock();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const RELEASE = { effective_year: 2027, brs_version: 'v25.2.0', released_at: '2026-09-01T00:00:00Z', is_current: false, notes: null, code_count: 1 };
const CODE = { code: '3601', effective_year: 2027, category: 'income', description: 'Salary', status: 'active', foreign_code: null,
  code_pair: null, applicability_note: null, source_document: null, source_url: null, official_excerpt: null, brs_version: 'v25.2.0',
  imported_at: '2026-09-01T00:00:00Z', used_by_companies: 0 };

const IMPORTED = { effectiveYear: 2027, brsVersion: 'v25.2.0', upserted: 4321, setCurrent: false,
  diff: { added: [], removed: [], changed: [] } };

/** The list answers; every write succeeds with `writeData`. */
function script(writeData: unknown = {}) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url).split('?')[0]!;
    if (path === '/api/admin/payroll/sars-codes' && (init?.method ?? 'GET') === 'GET') {
      return json({ success: true, data: { releases: [RELEASE], codes: [CODE], taxYear: 2027 } });
    }
    return json({ success: true, data: writeData });
  });
}
const listLoads = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).split('?')[0] === '/api/admin/payroll/sars-codes').length;

afterEach(() => { cleanup(); });

it('success: set-as-current completes', async () => {
  const alertSpy = vi.fn();
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('alert', alertSpy);
  script();
  render(<SarsCodesPage />);
  fireEvent.click(await screen.findByText('Set as current'));
  await vi.waitFor(() => expect(listLoads()).toBe(2));
  expect(alertSpy).not.toHaveBeenCalled();
});

it('success: deprecate completes', async () => {
  const alertSpy = vi.fn();
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('alert', alertSpy);
  script();
  render(<SarsCodesPage />);
  fireEvent.click(await screen.findByTitle('Mark deprecated'));
  await vi.waitFor(() => expect(listLoads()).toBe(2));
  expect(alertSpy).not.toHaveBeenCalled();
});

it('success: import completes', async () => {
  script(IMPORTED);
  const { container } = render(<SarsCodesPage />);
  fireEvent.click(await screen.findByRole('button', { name: /import xlsx/i }));
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'codes.xlsx')] } });
  fireEvent.click(await screen.findByRole('button', { name: /import now/i }));
  expect(await screen.findByText(/Imported 4321 codes for tax year 2027/)).toBeTruthy();
});
