// A page that checks the session on the server sends a browser with only the refresh
// cookie to /login?returnTo=...; AuthProvider renews there, and the page should resume.
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({ replaceLocation: vi.fn(), query: {} as Record<string, string>, isAuthenticated: true }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: vi.fn(), replace: vi.fn(), pathname: '/login' }) }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('next/image', () => ({ default: () => <span /> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ error: null, clearError: vi.fn(), isAuthenticated: h.isAuthenticated, loading: false }) }));
vi.mock('@/lib/auth/clearTenantClientState', () => ({ clearTenantClientState: vi.fn() }));
vi.mock('@/components/auth/LoginBrandPanel', () => ({ LoginBrandPanel: () => <div /> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import LoginPage from '../../../pages/login';

const AFS = '/accounting/afs/doc-1?period_end=2026-02-28';

beforeEach(() => {
  h.replaceLocation.mockReset();
  h.isAuthenticated = true;
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"success":true,"data":{}}', { status: 200 })));
  vi.stubGlobal('location', { hostname: 'app.isaflow.co.za', search: '', href: '', assign: vi.fn(), replace: h.replaceLocation });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('/login with a renewed session', () => {
  it('goes back to returnTo', () => {
    h.query = { returnTo: AFS };
    render(<LoginPage />);
    expect(h.replaceLocation).toHaveBeenCalledExactlyOnceWith(AFS);
  });

  it('stops on the form the second time, so a page that keeps refusing cannot loop', () => {
    h.query = { returnTo: AFS };
    render(<LoginPage />);
    cleanup();
    render(<LoginPage />);
    expect(h.replaceLocation).toHaveBeenCalledTimes(1);
  });

  it('resumes again once the cooldown has passed', () => {
    h.query = { returnTo: AFS };
    sessionStorage.setItem('isaflow_login_resumed_at', String(Date.now() - 61_000));
    render(<LoginPage />);
    expect(h.replaceLocation).toHaveBeenCalledExactlyOnceWith(AFS);
  });

  it.each([
    ['no returnTo', {}],
    ['an off-site returnTo', { returnTo: 'https://evil.example/x' }],
    ['a protocol-relative returnTo', { returnTo: '//evil.example/x' }],
    ['an unparseable returnTo', { returnTo: '//[' }],
    ['a backslash returnTo', { returnTo: '/\\evil.example/x' }],
    ['a returnTo hiding // behind a tab', { returnTo: '/\t/evil.example/x' }],
    ['a returnTo hiding // behind a newline', { returnTo: '/\n/evil.example/x' }],
    ['an invitation, where the visitor may be signing in as someone else', { invite: 't', returnTo: '/invite/t' }],
  ])('stays on the form with %s', (_label, query) => {
    h.query = query as Record<string, string>;
    render(<LoginPage />);
    expect(h.replaceLocation).not.toHaveBeenCalled();
  });

  it('stays on the form when storage is blocked, because the loop guard cannot work', () => {
    h.query = { returnTo: AFS };
    const denied = () => { throw new DOMException('denied', 'SecurityError'); };
    vi.stubGlobal('sessionStorage', { getItem: denied, setItem: denied });
    expect(() => render(<LoginPage />)).not.toThrow();
    expect(h.replaceLocation).not.toHaveBeenCalled();
  });

  it('stays on the form when not signed in', () => {
    h.isAuthenticated = false;
    h.query = { returnTo: AFS };
    render(<LoginPage />);
    expect(h.replaceLocation).not.toHaveBeenCalled();
  });
});
