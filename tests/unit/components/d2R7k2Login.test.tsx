// D2 round 7 (k2): after a good sign-in the landing-target lookup is a convenience. A failed lookup is logged and the
// user still lands on the default page (never a stuck form, never an error banner); a good one is honoured.
import { cleanup, configure, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

configure({ asyncUtilTimeout: 4000 });
const h = vi.hoisted(() => ({ warn: vi.fn(), assign: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/login' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/image', () => ({ default: () => <span /> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ error: null, clearError: vi.fn(), isAuthenticated: false, loading: false }) }));
vi.mock('@/lib/auth/clearTenantClientState', () => ({ clearTenantClientState: vi.fn() }));
vi.mock('@/components/auth/LoginBrandPanel', () => ({ LoginBrandPanel: () => <div /> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: h.warn, debug: vi.fn() } }));

import LoginPage from '../../../pages/login';

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const serve = (landing: () => Response) => fetchMock.mockImplementation(async (url: string) =>
  String(url).includes('/api/auth/landing') ? landing() : json({ success: true, data: {} }));

beforeEach(() => {
  fetchMock.mockReset(); h.warn.mockReset(); h.assign.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', { hostname: 'app.isaflow.co.za', search: '', href: '', assign: h.assign });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function signIn() {
  const { container } = render(<LoginPage />);
  fireEvent.change(container.querySelector('input[name="email"]')!, { target: { value: 'qa@example.test' } });
  fireEvent.change(container.querySelector('input[name="password"]')!, { target: { value: 'pw-123456' } });
  fireEvent.submit(container.querySelector('form')!);
}

describe('post-login landing lookup', () => {
  it('an empty-body 500 is logged and the user still lands on the default page with no error banner', async () => {
    serve(() => new Response('', { status: 500 }));
    signIn();
    await waitFor(() => expect(h.assign).toHaveBeenCalledWith('/accounting'));
    expect(h.warn).toHaveBeenCalledWith('Landing target lookup failed; using the default', expect.anything(), 'login');
    expect(document.body.textContent).not.toMatch(/could not|unavailable|JSON|HTTP \d/i);
  });
  it('a 200 with a firm target lands there and logs nothing', async () => {
    serve(() => json({ success: true, data: { defaultTarget: '/bureau' } }));
    signIn();
    await waitFor(() => expect(h.assign).toHaveBeenCalledWith('/bureau'));
    expect(h.warn).not.toHaveBeenCalled();
  });
  it('a 200 with the onboarding target lands on onboarding', async () => {
    serve(() => json({ success: true, data: { defaultTarget: '/onboarding' } }));
    signIn();
    await waitFor(() => expect(h.assign).toHaveBeenCalledWith('/onboarding'));
  });
});
