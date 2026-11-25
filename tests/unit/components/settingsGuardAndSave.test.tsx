// W3 (review follow-up): the leave guard, and Save's disabled wiring on the real page, including the two paths that once left it wrong.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (url: string, opts?: { shallow?: boolean }) => void;
const handlers = new Set<Handler>();
const emit = vi.fn();
const push = vi.fn(() => Promise.resolve(true));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: {}, push, events: { on: (_e: string, h: Handler) => handlers.add(h), off: (_e: string, h: Handler) => handlers.delete(h), emit } }),
}));
const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'c1' }, loading: false }) }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('@/components/accounting/settings/SettingsSidebar', () => ({ SettingsSidebar: () => null }));
vi.mock('@/components/accounting/settings/DimensionSettings', () => ({ DimensionSettings: () => null }));
vi.mock('@/components/accounting/settings/DetailsTab', () => ({
  DetailsTab: ({ company, onChange }: { company: { phone: string }; onChange: (f: string, v: string) => void }) =>
    <input aria-label="phone" value={company.phone ?? ''} onChange={(e) => onChange('phone', e.target.value)} />,
}));
vi.mock('@/components/accounting/settings/GeneralTab', () => ({ GeneralTab: () => null }));
vi.mock('@/components/accounting/settings/DefaultPaymentTermsCard', () => ({ DefaultPaymentTermsCard: () => null }));

import { useUnsavedChangesGuard } from '../../../src/components/accounting/settings/useUnsavedChangesGuard';
import { formSnapshot } from '../../../src/components/accounting/settings/settingsSnapshot';
import CompanySettingsPage from '../../../pages/accounting/company-settings';

afterEach(() => { cleanup(); handlers.clear(); vi.clearAllMocks(); });
const route = (url: string, shallow = false) => [...handlers].forEach((h) => h(url, { shallow }));

describe('useUnsavedChangesGuard', () => {
  it('clean: registers nothing', () => {
    renderHook(() => useUnsavedChangesGuard(false));
    expect(handlers.size).toBe(0);
  });

  it('dirty: cancels an in-app route change with a cancelled error, reports it, and offers it as pending', () => {
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    let thrown: unknown;
    act(() => { try { route('/accounting'); } catch (e) { thrown = e; } });
    expect((thrown as { cancelled?: boolean }).cancelled).toBe(true);
    expect(emit).toHaveBeenCalledWith('routeChangeError', thrown, '/accounting', { shallow: false });
    expect(result.current.pending).toBe('/accounting');
  });

  it('a shallow change (?tab=) is not leaving', () => {
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    expect(() => route('/accounting/company-settings?tab=vat', true)).not.toThrow();
    expect(result.current.pending).toBeNull();
  });

  it('Leave pushes the pending url and lets it through; Stay clears it', async () => {
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    act(() => { try { route('/accounting'); } catch { /* cancelled */ } });
    act(() => result.current.stay());
    expect(result.current.pending).toBeNull();
    expect(push).not.toHaveBeenCalled();
    act(() => { try { route('/accounting'); } catch { /* cancelled */ } });
    act(() => result.current.leave());
    expect(push).toHaveBeenCalledWith('/accounting');
    expect(() => route('/accounting')).not.toThrow(); // bypass while the push runs
  });

  it('unmount (or going clean) removes both listeners', () => {
    const add = vi.spyOn(window, 'addEventListener'); const rem = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useUnsavedChangesGuard(true));
    expect(handlers.size).toBe(1); expect(add).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    unmount();
    expect(handlers.size).toBe(0); expect(rem).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });
});

describe('formSnapshot', () => {
  it('ignores the server-derived financial-year fields and nothing else', () => {
    const f = (c: Record<string, unknown>) => formSnapshot({ company: c, docNumbers: [], messages: {}, docDisplayFields: {} });
    expect(f({ phone: '1', financialYearStartActual: 3, financialYearStartLocked: false, financialYearStartLockReason: null }))
      .toBe(f({ phone: '1', financialYearStartActual: 4, financialYearStartLocked: true, financialYearStartLockReason: 'posted' }));
    expect(f({ phone: '1' })).not.toBe(f({ phone: '2' }));
  });
});

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } });
const company = (over: Record<string, unknown> = {}) => ({ id: 'c1', name: 'Acme', phone: '011', financialYearStart: 3, financialYearStartActual: 3, ...over });

function serve(opts: { putCompany: () => Response; reread?: () => Response }) {
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.startsWith('/api/accounting/companies?id=')) return (opts.reread ?? (() => json(company())))();
    if (url === '/api/accounting/companies' && init?.method === 'PUT') return opts.putCompany();
    if (init?.method === 'PUT') return json({});
    if (url.startsWith('/api/accounting/company-documents')) return json([]);
    if (url.includes('document-numbers')) return json([{ documentType: 'invoice', prefix: 'INV', nextNumber: 1 }]);
    if (url.includes('type=messages')) return json([]);
    return json({});
  });
}
const saveBtn = () => screen.getByRole('button', { name: /Save Changes|No changes/ });
const phone = () => screen.getByLabelText('phone') as HTMLInputElement;
beforeEach(() => { handlers.clear(); });

describe('Company Settings Save wiring', () => {
  it('is disabled until loaded and clean; edit enables; a save that moves the year start (server re-read changes derived fields) ends clean', async () => {
    let reads = 0;
    serve({
      putCompany: () => json(company({ phone: '999', financialYearStart: 4 })),
      reread: () => json(reads++ === 0 ? company() : company({ phone: '999', financialYearStart: 4, financialYearStartActual: 4, financialYearStartLocked: true })),
    });
    render(<CompanySettingsPage />);
    await waitFor(() => expect(phone().value).toBe('011'));
    await waitFor(() => expect(saveBtn().textContent).toContain('No changes'));
    expect(saveBtn()).toBeDisabled();
    fireEvent.change(phone(), { target: { value: '999' } });
    expect(saveBtn()).toBeEnabled();
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(/saved/i)).toBeTruthy());
    await waitFor(() => expect(apiFetch.mock.calls.filter(([u]) => String(u).startsWith('/api/accounting/companies?id=')).length).toBeGreaterThanOrEqual(2)); // the year re-read ran
    await waitFor(() => expect(saveBtn()).toBeDisabled());
    expect(saveBtn().textContent).toContain('No changes');
  });

  it('a 409 Reload replaces unsaved edits everywhere, not just on the company', async () => {
    serve({ putCompany: () => new Response(JSON.stringify({ message: 'changed since you loaded them' }), { status: 409 }) });
    render(<CompanySettingsPage />);
    await waitFor(() => expect(phone().value).toBe('011'));
    await waitFor(() => expect(saveBtn()).toBeDisabled());
    fireEvent.change(phone(), { target: { value: '555' } });
    fireEvent.click(saveBtn());
    fireEvent.click(await screen.findByRole('button', { name: /Reload settings/ }));
    await waitFor(() => expect(phone().value).toBe('011'));
    await waitFor(() => expect(saveBtn()).toBeDisabled());
    expect(apiFetch.mock.calls.filter(([u]) => String(u).includes('document-numbers')).length).toBeGreaterThanOrEqual(2); // the supplementary reads ran again
  });
});
