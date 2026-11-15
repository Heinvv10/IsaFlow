// Admin audit 2026-11-14, item 1.11 (code-4 F-12): the SARS codes page's confirms
// overclaimed. "Set as current" said "All new payroll runs will use this year's
// codes", but is_current is read only by this admin page (which year it opens on;
// getCurrentTaxYear has no caller); payroll and IRP5 checks use the run's own tax
// year. Deprecating a code said it "will block new payroll runs"; it makes IRP5
// and year-end validation report an error for that code and year, and blocks no
// pay run. The confirms now say what happens. Payroll tax behaviour is unchanged.
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import SarsCodesPage from '../../../pages/admin/payroll/sars-codes';

const releases = [
  { effective_year: 2027, brs_version: '24.0.1', released_at: '2026-03-01', is_current: true, notes: null, code_count: 1 },
  { effective_year: 2026, brs_version: '23.0.0', released_at: '2025-03-01', is_current: false, notes: null, code_count: 1 },
];
const code = {
  code: '3601', effective_year: 2027, category: 'income', description: 'Salary', status: 'active', foreign_code: '3651',
  code_pair: null, applicability_note: null, source_document: null, source_url: null, official_excerpt: null,
  brs_version: '24.0.1', imported_at: '2026-03-01', used_by_companies: 3,
};
let confirmSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(apiFetch).mockImplementation(async () =>
    new Response(JSON.stringify({ success: true, data: { releases, codes: [code], taxYear: 2027 } }), { status: 200 }));
  confirmSpy = vi.fn(() => false); // the admin declines: nothing is posted
  vi.stubGlobal('confirm', confirmSpy);
});
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

const posted = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');

describe('SARS codes confirms say what the action does', () => {
  it('"Set as current" does not claim payroll runs use it', async () => {
    render(<SarsCodesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /set as current/i }));
    const text = String(confirmSpy.mock.calls[0]?.[0]);
    expect(text).not.toMatch(/payroll runs will use/i);
    expect(text).toMatch(/2026/);
    expect(text).toMatch(/only/i);
    expect(text).toMatch(/payroll.*not/i);
    expect(posted()).toEqual([]);
    expect(document.body.textContent).not.toMatch(/drives all new payroll runs/i);
  });

  it('deprecating a code in use names the IRP5 effect, not a payroll-run block', async () => {
    render(<SarsCodesPage />);
    fireEvent.click(await screen.findByTitle('Mark deprecated'));
    const text = String(confirmSpy.mock.calls[0]?.[0]);
    expect(text).not.toMatch(/block new payroll runs/i);
    expect(text).toMatch(/IRP5/);
    expect(text).toMatch(/3 companies/);
    expect(posted()).toEqual([]);
  });
});
