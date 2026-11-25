// W3 (review follow-up): the leave guard, and Save's disabled wiring on the real page, including the two paths that once left it wrong.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn(() => Promise.resolve(true));
const beforePopState = vi.fn();
// The shared router every public instance delegates to; push/replace are prototype-style (not own) like Next's.
const sharedPush = vi.fn(() => Promise.resolve(true));
class Shared { push = sharedPush; replace = vi.fn(() => Promise.resolve(true)); }
const shared = new Shared();
vi.mock('next/router', () => ({
  useRouter: () => ({ query: {}, asPath: '/accounting/company-settings', push, beforePopState }),
  default: { get router() { return shared; } },
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

afterEach(() => { cleanup(); vi.clearAllMocks(); document.querySelectorAll('a').forEach((a) => a.remove()); });
const rejections: unknown[] = [];
const onRej = (e: PromiseRejectionEvent) => rejections.push(e.reason);
beforeEach(() => { rejections.length = 0; window.addEventListener('unhandledrejection', onRej); });
afterEach(() => window.removeEventListener('unhandledrejection', onRej));
const link = (href: string, attrs: Record<string, string> = {}) => {
  const a = document.body.appendChild(document.createElement('a')); a.href = href;
  Object.entries(attrs).forEach(([k, v]) => a.setAttribute(k, v));
  const onReact = vi.fn(); a.addEventListener('click', (e) => { onReact(); e.preventDefault(); }); // stands in for next/link
  return { a, onReact };
};
const click = (a: Element, init: MouseEventInit = {}) => a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));

describe('useUnsavedChangesGuard', () => {
  it('clean: a link click goes through and the pop-state handler is untouched', () => {
    renderHook(() => useUnsavedChangesGuard(false));
    const { a, onReact } = link('/accounting');
    click(a);
    expect(onReact).toHaveBeenCalled();
    expect(beforePopState).not.toHaveBeenCalled();
  });

  it('dirty: a click on another page stops before the router (no push, no rejection) and is offered as pending', async () => {
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    const { a, onReact } = link('/accounting');
    act(() => { click(a); });
    await Promise.resolve();
    expect(onReact).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled(); expect(sharedPush).not.toHaveBeenCalled();
    expect(rejections).toEqual([]);
    expect(result.current.pending).toBe('/accounting');
  });

  it('leaves alone: the same page (?tab=, #hash), new tab, modified click, download, other origin', () => {
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    const same = link(`${window.location.pathname}?tab=vat`);
    const blank = link('/accounting', { target: '_blank' });
    const mod = link('/accounting');
    const dl = link('/x.pdf', { download: '' });
    const ext = link('https://example.invalid/x');
    act(() => { click(same.a); click(blank.a); click(mod.a, { ctrlKey: true }); click(dl.a); click(ext.a); });
    for (const l of [same, blank, mod, dl, ext]) expect(l.onReact).toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
  });

  it('Back/Forward: the pop-state handler refuses and offers the target; unmount restores the default', () => {
    const { result, unmount } = renderHook(() => useUnsavedChangesGuard(true));
    const handler = beforePopState.mock.calls[0]![0] as (s: { as: string }) => boolean;
    let allowed = true;
    act(() => { allowed = handler({ as: '/accounting/bank' }); });
    expect(allowed).toBe(false);
    expect(result.current.pending).toBe('/accounting/bank');
    unmount();
    expect((beforePopState.mock.calls.at(-1)![0] as () => boolean)()).toBe(true);
  });

  it('Leave pushes the pending url; Stay clears it; push() is guarded while dirty', () => {
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    act(() => result.current.push('/accounting'));
    expect(push).not.toHaveBeenCalled();
    expect(result.current.pending).toBe('/accounting');
    act(() => result.current.stay());
    expect(result.current.pending).toBeNull();
    act(() => result.current.push('/accounting'));
    act(() => result.current.leave());
    expect(sharedPush).toHaveBeenCalledWith('/accounting'); // the original shared push, not the wrapped one
  });

  it('an anchor marked data-no-guard is never intercepted', () => {
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    const l = link('/logout', { 'data-no-guard': '' });
    act(() => { click(l.a); });
    expect(l.onReact).toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
  });

  it('a refused Back/Forward puts this page URL back before asking', () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    renderHook(() => useUnsavedChangesGuard(true));
    const handler = beforePopState.mock.calls[0]![0] as (s: { as: string }) => boolean;
    act(() => { handler({ as: '/accounting/bank' }); });
    expect(pushState).toHaveBeenCalledWith(null, '', '/accounting/company-settings');
  });

  it('programmatic push/replace to another page (command palette, menus) opens the dialog and resolves false; Leave runs the original', async () => {
    const origPush = shared.push; const origReplace = shared.replace;
    const { result, unmount } = renderHook(() => useUnsavedChangesGuard(true));
    expect(shared.push).not.toBe(origPush);
    let r: unknown;
    await act(async () => { r = await (shared.push as (u: string) => Promise<boolean>)('/accounting/bank'); });
    expect(r).toBe(false);
    expect(origPush).not.toHaveBeenCalled();
    expect(result.current.pending).toBe('/accounting/bank');
    await act(async () => { r = await (shared.replace as (u: string) => Promise<boolean>)('/accounting/bank'); });
    expect(r).toBe(false);
    expect(origReplace).not.toHaveBeenCalled();
    act(() => result.current.leave());
    expect(origPush).toHaveBeenCalledWith('/accounting/bank');
    expect(rejections).toEqual([]);
    unmount();
    expect(shared.push).toBe(origPush); expect(shared.replace).toBe(origReplace);
  });

  it('programmatic calls to this page or shallow pass straight through', async () => {
    const origPush = shared.push;
    renderHook(() => useUnsavedChangesGuard(true));
    await (shared.push as (u: string, a?: unknown, o?: object) => Promise<boolean>)('/accounting/bank', undefined, { shallow: true });
    await (shared.push as (u: string) => Promise<boolean>)(`${window.location.pathname}?tab=vat`);
    expect(origPush).toHaveBeenCalledTimes(2);
  });

  it('cleanup does not clobber a wrapper someone installed after ours', () => {
    const { unmount } = renderHook(() => useUnsavedChangesGuard(true));
    const theirs = vi.fn(); shared.push = theirs as never;
    unmount();
    expect(shared.push).toBe(theirs);
    shared.push = sharedPush;
  });

  it('unmount (or going clean) removes the listeners', () => {
    const rem = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useUnsavedChangesGuard(true));
    unmount();
    expect(rem).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    const { a, onReact } = link('/accounting');
    click(a);
    expect(onReact).toHaveBeenCalled();
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
