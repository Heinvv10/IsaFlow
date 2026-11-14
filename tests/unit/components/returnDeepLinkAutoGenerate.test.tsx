/**
 * A link from Ask IsaFlow (?from=&to=) lands on the figure it quoted: on a valid link the page's Generate runs, exactly once per
 * link period; on a bad link it never does. Generate is a read (GET), so running it for the person is safe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import type { NextRouter } from 'next/router';
import { apiFetch } from '@/lib/apiFetch';
import { ok } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'c1' }, companyRole: 'owner', companyId: 'c1', companies: [], loading: false }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/components/accounting/sars/VAT201ExceptionsPanel', () => ({ VAT201ExceptionsPanel: () => <div>exceptions</div> }));
vi.mock('@/components/accounting/sars/VAT201SarsSubmit', () => ({ VAT201SarsSubmit: () => <div>sars</div> }));

import VAT201Page from '../../../pages/accounting/sars/vat201';
import EMP201Page from '../../../pages/accounting/sars/emp201';

const VAT = { periodStart: '2026-09-01', periodEnd: '2026-10-31', sarsFields: [], warnings: [], filability: { filable: true, reason: null }, outputInvoices: [], inputInvoices: [] };
const EMP = {
  periodStart: '2026-10-01', periodEnd: '2026-10-31', totalPAYE: 0, totalETI: 0, payePayable: 0, etiCarry: { broughtForward: 0, used: 0, carriedForward: 0, refundClaimable: 0 },
  etiWarnings: [], totalUIF_employee: 0, totalUIF_employer: 0, totalUIF: 0, totalSDL: 0, employeeCount: 0, totalTaxableRemuneration: 0, totalDeductions: 0, payrollRuns: [], directivePayments: [],
};
const router = (query: Record<string, string>): NextRouter => ({ isReady: true, query } as unknown as NextRouter);
const calls = (needle: string) => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes(needle));

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('/api/accounting/companies?id=')) return ok({ vatPeriod: 'monthly', vatSystemType: 'invoice', vatPeriodAlignment: 'odd' });
    if (u.includes('sars-vat201')) return ok(VAT);
    if (u.includes('sars-emp201')) return ok(EMP);
    return ok({});
  });
});
afterEach(cleanup);

describe('VAT201 deep link', () => {
  it('generates once for a valid link, for that period, and again for a second link with another period', async () => {
    const view = (q: Record<string, string>) => <RouterContext.Provider value={router(q)}><VAT201Page /></RouterContext.Provider>;
    const { rerender } = render(view({ from: '2026-09-01', to: '2026-10-31' }));
    await waitFor(() => expect(calls('sars-vat201')).toHaveLength(1));
    expect(calls('sars-vat201')[0]).toContain('from=2026-09-01&to=2026-10-31');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(calls('sars-vat201')).toHaveLength(1); // not again on later renders
    rerender(view({ from: '2026-07-01', to: '2026-08-31' }));
    await waitFor(() => expect(calls('sars-vat201')).toHaveLength(2));
    expect(calls('sars-vat201')[1]).toContain('from=2026-07-01&to=2026-08-31');
  });
  it('never generates for a garbage link', async () => {
    render(<RouterContext.Provider value={router({ from: 'garbage', to: '2026-10-31' })}><VAT201Page /></RouterContext.Provider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
    expect(calls('sars-vat201')).toHaveLength(0);
  });
});

describe('EMP201 deep link', () => {
  it('generates once for a valid link and again for a different period; never for a garbage link', async () => {
    const view = (q: Record<string, string>) => <RouterContext.Provider value={router(q)}><EMP201Page /></RouterContext.Provider>;
    const { rerender } = render(view({ from: '2026-10-01', to: '2026-10-31' }));
    await waitFor(() => expect(calls('sars-emp201')).toHaveLength(1));
    expect(calls('sars-emp201')[0]).toContain('from=2026-10-01&to=2026-10-31');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(calls('sars-emp201')).toHaveLength(1);
    rerender(view({ from: '2026-09-01', to: '2026-09-30' }));
    await waitFor(() => expect(calls('sars-emp201')).toHaveLength(2));
    expect(calls('sars-emp201')[1]).toContain('from=2026-09-01&to=2026-09-30');
    cleanup();
    vi.mocked(apiFetch).mockClear();
    render(view({ from: 'nope', to: '2026-10-31' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
    expect(calls('sars-emp201')).toHaveLength(0);
  });
});
