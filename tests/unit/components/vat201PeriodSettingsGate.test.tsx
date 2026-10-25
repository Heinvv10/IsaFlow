/**
 * D6 (VAT201 page). The period selector used to render before the company's VAT
 * settings arrived: it printed the bi-monthly default, flipped its label to the
 * real period, and grew a row of quick-period chips that pushed Generate down
 * 46px — so a click aimed at the first position hit a chip and sent no request.
 * The selector now waits for the settings: one label, one stable Generate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { ok } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const ctx = vi.hoisted(() => ({ value: { activeCompany: { id: 'c1' } as { id: string } | null, companyRole: 'owner', loading: false } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ctx.value }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/components/accounting/sars/VAT201ExceptionsPanel', () => ({ VAT201ExceptionsPanel: () => <div>exceptions</div> }));
vi.mock('@/components/accounting/sars/VAT201SarsSubmit', () => ({ VAT201SarsSubmit: () => <div>sars</div> }));

import VAT201Page from '../../../pages/accounting/sars/vat201';

const REPORT = {
  periodStart: '2026-09-01', periodEnd: '2026-09-30', sarsFields: [], warnings: [],
  filability: { filable: true, reason: null }, outputInvoices: [], inputInvoices: [],
};
const MONTHLY = { vatPeriod: 'monthly', vatSystemType: 'invoice', vatPeriodAlignment: 'even' };

let releaseSettings: (r: Response) => void = () => {};
const vatRequests = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('sars-vat201'));

beforeEach(() => {
  ctx.value = { activeCompany: { id: 'c1' }, companyRole: 'owner', loading: false };
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('/api/accounting/companies?id=')) return new Promise<Response>((r) => { releaseSettings = r; });
    if (u.includes('sars-vat201')) return ok(REPORT);
    return ok({});
  });
});
afterEach(() => { cleanup(); });

describe('VAT201 period selector waits for the company VAT settings', () => {
  it('shows no period label and no Generate button until the settings arrive', () => {
    render(<VAT201Page />);
    expect(screen.getByTestId('vat201-period-loading')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /generate/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Bi-Monthly|Monthly/);
  });

  it('never shows the bi-monthly default to a monthly company', async () => {
    const labels: string[] = [];
    const observer = new MutationObserver(() => {
      const m = document.body.textContent?.match(/Bi-Monthly[^V]*|Monthly/);
      if (m && labels[labels.length - 1] !== m[0]) labels.push(m[0]);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    render(<VAT201Page />);
    await act(async () => { releaseSettings(ok(MONTHLY)); });
    await screen.findByRole('button', { name: /generate/i });
    observer.disconnect();
    expect(labels).toEqual(['Monthly']);
  });

  it('sends one request on the first Generate click', async () => {
    render(<VAT201Page />);
    await act(async () => { releaseSettings(ok(MONTHLY)); });
    fireEvent.click(await screen.findByRole('button', { name: /generate/i }));
    await waitFor(() => expect(vatRequests()).toHaveLength(1));
  });

  it('does not strand the page when the settings cannot be loaded: says so and still lets the user generate', async () => {
    render(<VAT201Page />);
    await act(async () => { releaseSettings(new Response('', { status: 500 })); });
    expect(await screen.findByText(/Could not load company VAT settings/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /generate/i })).toBeTruthy();
  });

  it('does not wait forever when there is no company to ask: the selector shows on its defaults', async () => {
    ctx.value = { activeCompany: null, companyRole: 'owner', loading: false };
    render(<VAT201Page />);
    expect(await screen.findByRole('button', { name: /generate/i })).toBeTruthy();
    expect(screen.queryByTestId('vat201-period-loading')).toBeNull();
  });

  it('keeps waiting while the company is still loading', () => {
    ctx.value = { activeCompany: null, companyRole: 'owner', loading: true };
    render(<VAT201Page />);
    expect(screen.getByTestId('vat201-period-loading')).toBeTruthy();
  });

  it('puts the review notices on the page after Generate, and the filability warning in the manual submit modal', async () => {
    const report = {
      ...REPORT,
      warnings: [{ code: 'uncoded-revenue-assumed-zero-rated', amount: 800, message: 'Confirm the uncoded revenue.' }],
      filability: { filable: false, reason: 'field 1 is negative' },
    };
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/api/accounting/companies?id=')) return ok(MONTHLY);
      if (u.includes('sars-vat201')) return (init?.method ?? 'GET') === 'POST' ? ok({ id: 's1' }) : ok(report);
      return ok({});
    });
    render(<VAT201Page />);
    fireEvent.click(await screen.findByRole('button', { name: /generate/i }));
    expect((await screen.findByTestId('vat201-notice-uncoded-revenue-assumed-zero-rated')).textContent).toMatch(/Confirm/);
    expect(screen.getByTestId('vat201-notice-filability').textContent).toMatch(/field 1 is negative/);
    fireEvent.click(await screen.findByRole('button', { name: /save draft/i }));
    fireEvent.click(await screen.findByRole('button', { name: /mark as submitted/i }));
    expect((await screen.findByTestId('vat201-submit-filability-warning')).textContent).toMatch(/field 1 is negative/);
  });
});
