/**
 * D9 round 2: while /api/auth/me cannot answer, the REAL AppLayout tells the
 * user why the page is not loading, offers Retry, keeps retrying in the
 * background, and shows the page by itself once the auth service is back,
 * with no reload. Only `fetch` is stubbed for the auth path; AppLayout's own
 * chrome (nav, menus, tour) is mocked out because it is not under test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', query: {}, asPath: '/accounting', push: vi.fn(), replace: vi.fn(), events: { on: vi.fn(), off: vi.fn() } }) }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', activeCompany: null }) }));
vi.mock('@/hooks/useTrackPageVisit', () => ({ useTrackPageVisit: () => undefined }));
vi.mock('@/lib/auth/sessionHeartbeat', () => ({ startSessionHeartbeat: () => () => undefined }));
const { nothing } = vi.hoisted(() => ({ nothing: () => null }));
vi.mock('@/components/layout/CompanySwitcher', () => ({ CompanySwitcher: nothing }));
vi.mock('@/components/layout/CreateNewMenu', () => ({ CreateNewMenu: nothing }));
vi.mock('@/components/layout/SettingsMenu', () => ({ SettingsMenu: nothing }));
vi.mock('@/components/ui/TableDensityToggle', () => ({ TableDensityToggle: nothing }));
vi.mock('@/components/layout/SidebarNav', () => ({ SidebarNav: nothing }));
vi.mock('@/components/accounting/SecondaryModuleNav', () => ({ SecondaryModuleNav: nothing }));
vi.mock('@/components/layout/CommandPalette', () => ({ CommandPalette: nothing }));
vi.mock('@/components/layout/ShortcutHelpOverlay', () => ({ ShortcutHelpOverlay: nothing }));
vi.mock('@/components/onboarding/AccountingTour', () => ({ AccountingTour: nothing }));
vi.mock('@/components/onboarding/SetupGuideButton', () => ({ SetupGuideButton: nothing }));
vi.mock('@/components/layout/ImpersonationBanner', () => ({ ImpersonationBanner: nothing }));
vi.mock('@/components/payroll/PayrollPeriodBar', () => ({ PayrollPeriodBar: nothing }));

import { AuthProvider } from '@/contexts/AuthContext';
import { AppLayout } from '@/components/layout/AppLayout';

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { success: true, data: { user: { id: 'u-1', email: 'owner@example.test', first_name: 'Ada', last_name: 'Owner' } } };
const MESSAGE = /can.t reach the sign-in service right now/i;

/** /api/auth/me answers from a queue (the last entry repeats); nothing else may be fetched. */
function meFetch(answers: Array<Response | Error>) {
  return vi.fn(async (url: string) => {
    if (url !== '/api/auth/me') throw new Error(`unexpected fetch ${url}`);
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  });
}

function renderPage() {
  return render(<AuthProvider><AppLayout><p>customers page</p></AppLayout></AuthProvider>);
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('AppLayout during an auth-service outage', () => {
  it.each([['503', json(503)], ['a network error', new TypeError('Failed to fetch')]])(
    'a first /api/auth/me failing with %s explains itself and offers Retry, instead of a bare spinner', async (_l, failure) => {
      vi.stubGlobal('fetch', meFetch([failure]));
      renderPage();
      expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
      expect(screen.getByText(/you.re still signed in/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(screen.queryByText('customers page')).toBeNull();
    });

  it('Retry asks again at once and shows the page when the service answers', async () => {
    const fetch = meFetch([json(503), json(200, ME)]);
    vi.stubGlobal('fetch', fetch);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('customers page')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(MESSAGE)).toBeNull();
  });

  it('an already-open page recovers on its own, without a reload, when /api/auth/me answers 200', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = meFetch([json(503), json(503), json(200, ME)]);
    vi.stubGlobal('fetch', fetch);
    renderPage();
    await screen.findByText(MESSAGE);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(await screen.findByText('customers page')).toBeInTheDocument();
    expect(screen.queryByText(MESSAGE)).toBeNull();
  });

  it('a normal first load shows the page and never the outage message', async () => {
    vi.stubGlobal('fetch', meFetch([json(200, ME)]));
    renderPage();
    expect(await screen.findByText('customers page')).toBeInTheDocument();
    expect(screen.queryByText(MESSAGE)).toBeNull();
  });
});
