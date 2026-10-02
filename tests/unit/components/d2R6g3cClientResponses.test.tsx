// D2 round 6 (g3c): API keys, billing-tab invoices, impersonation banner, close agent action, top customers.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: unknown }) => <a>{children as never}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ asPath: '/', push: vi.fn() }) }));
vi.mock('@/components/admin/ConfirmModal', () => ({ ConfirmModal: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import { CaptureApiKeysSection } from '@/components/accounting/capture/CaptureApiKeysSection';
import { CompanyBillingTab } from '@/components/admin/companies/CompanyBillingTab';
import { ImpersonationBanner } from '@/components/layout/ImpersonationBanner';
import { CloseAgentPanel } from '@/components/accounting/close-agent/CloseAgentPanel';

useApiJsonOverMock();
const MSG = 'D2 server says no: this request was refused';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bad400 = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const noRaw = (t: string) => expect(t).not.toMatch(/JSON|Unexpected end|HTTP \d|Network error|Failed to/);
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('CaptureApiKeysSection', () => {
  const run = async (listRes: () => Response) => {
    const toast = vi.fn();
    vi.mocked(apiFetch).mockImplementation(async () => listRes());
    render(<CaptureApiKeysSection showToast={toast} />);
    await waitFor(() => expect(toast).toHaveBeenCalled());
    return toast;
  };
  it('4xx load shows the server message', async () => { expect((await run(bad400)).mock.calls[0]![0]).toBe(MSG); });
  it('empty 500 load shows a plain sentence', async () => {
    const m = (await run(empty500)).mock.calls[0]![0] as string; noRaw(m); expect(m).toMatch(/Could not load/);
  });
  it('a refused generate shows the server message and no key', async () => {
    const toast = vi.fn();
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => ((init?.method ?? 'GET') === 'POST' ? bad400() : ok([])));
    render(<CaptureApiKeysSection showToast={toast} />);
    fireEvent.change(await screen.findByPlaceholderText(/label|e\.g\./i), { target: { value: 'k1' } });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(MSG, false));
  });
});

describe('CompanyBillingTab invoices', () => {
  const inv = { id: 'i1', invoice_number: 'INV-D2-7', status: 'paid', amount_cents: 100, created_at: '2026-01-01T00:00:00Z' };
  const mount = async (invRes: () => Response) => {
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      String(url).includes('/invoices') ? invRes() : ok({ items: [] }));
    render(<CompanyBillingTab companyId="c-1" />);
  };
  it('a failed invoice load shows the server message instead of an empty table', async () => {
    await mount(bad400);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('empty 500 invoice load shows a plain sentence', async () => {
    await mount(empty500);
    expect(await screen.findByText(/Could not load invoices/)).toBeTruthy();
    noRaw(document.body.textContent ?? '');
  });
  it('200 shows the invoice', async () => {
    await mount(() => ok({ items: [inv] }));
    await waitFor(() => expect(document.body.textContent).toContain('INV-D2-7'));
  });
});

describe('ImpersonationBanner', () => {
  it('an empty 500 on return shows a plain sentence, not a JSON error, and re-enables the button', async () => {
    document.cookie = 'is_impersonating=1';
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    vi.stubGlobal('fetch', async () => empty500());
    render(<ImpersonationBanner />);
    fireEvent.click(await screen.findByRole('button', { name: /return to my session/i }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const m = String(alertSpy.mock.calls[0]![0]); noRaw(m); expect(m).toMatch(/Could not end impersonation/);
    await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false));
    document.cookie = 'is_impersonating=; max-age=0';
  });
});

describe('CloseAgentPanel', () => {
  it('an empty 500 on the periods load shows a plain sentence', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => empty500());
    render(<CloseAgentPanel period="2026-06" />);
    await waitFor(() => expect(document.body.textContent).toMatch(/Could not load the fiscal periods/));
    noRaw(document.body.textContent ?? '');
  });
  it('a 4xx periods load shows the server message', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => bad400());
    render(<CloseAgentPanel period="2026-06" />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
});
