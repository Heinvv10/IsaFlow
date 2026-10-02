/**
 * D2 (admin SARS codes actions): set-current, deprecate/restore and import all surface the server's message
 * from the real error envelope (alert() for the two row actions, inline text in the import wizard).
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
const refuse = (msg: string) => json({ success: false, error: { code: 'CONFLICT', message: msg } }, 409);
const RELEASE = { effective_year: 2027, brs_version: 'v25.2.0', released_at: '2026-09-01T00:00:00Z', is_current: false, notes: null, code_count: 1 };
const CODE = { code: '3601', effective_year: 2027, category: 'income', description: 'Salary', status: 'active', foreign_code: null,
  code_pair: null, applicability_note: null, source_document: null, source_url: null, official_excerpt: null, brs_version: 'v25.2.0',
  imported_at: '2026-09-01T00:00:00Z', used_by_companies: 0 };

/** The list answers; the one write path under test is refused. */
function script(failPath: string, failMethod: string, msg: string) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const u = String(url);
    const path = u.split('?')[0]!;
    if (path === failPath && (init?.method ?? 'GET') === failMethod) return refuse(msg);
    if (path === '/api/admin/payroll/sars-codes') return json({ success: true, data: { releases: [RELEASE], codes: [CODE], taxYear: 2027 } });
    return json({ success: true, data: {} });
  });
}

afterEach(() => { cleanup(); });

it('set-as-current refused: the alert carries the server message', async () => {
  const msg = 'D2 server says no: tax year 2027 has no codes to release';
  const alertSpy = vi.fn();
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('alert', alertSpy);
  script('/api/admin/payroll/sars-codes/release', 'POST', msg);
  render(<SarsCodesPage />);
  fireEvent.click(await screen.findByText('Set as current'));
  await vi.waitFor(() => expect(alertSpy).toHaveBeenCalledWith(msg));
});

it('deprecate refused: the alert carries the server message', async () => {
  const msg = 'D2 server says no: code 3601 is referenced by a locked pay run';
  const alertSpy = vi.fn();
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('alert', alertSpy);
  script('/api/admin/payroll/sars-codes/3601', 'PATCH', msg);
  render(<SarsCodesPage />);
  fireEvent.click(await screen.findByTitle('Mark deprecated'));
  await vi.waitFor(() => expect(alertSpy).toHaveBeenCalledWith(msg));
});

it('import refused: the wizard shows the server message', async () => {
  const msg = 'D2 server says no: sheet Master_Codes is missing the Category column';
  script('/api/admin/payroll/sars-codes/import', 'POST', msg);
  const { container } = render(<SarsCodesPage />);
  fireEvent.click(await screen.findByRole('button', { name: /import xlsx/i }));
  const input = container.querySelector('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File(['x'], 'codes.xlsx')] } });
  fireEvent.click(await screen.findByRole('button', { name: /import now/i }));
  expect(await screen.findByText(msg)).toBeTruthy();
});
