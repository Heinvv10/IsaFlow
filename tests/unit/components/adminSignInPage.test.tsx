// Audit P2.5 #7: the admin host's sign-in must read as the admin console, not
// the marketing sign-in, and the app-host /login must stay as it is.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/login' }) }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('next/image', () => ({ default: ({ alt }: { alt: string }) => <span>{alt}</span> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ error: null, clearError: vi.fn(), isAuthenticated: false, loading: false }) }));
vi.mock('@/lib/auth/clearTenantClientState', () => ({ clearTenantClientState: vi.fn() }));
vi.mock('@/components/auth/LoginBrandPanel', () => ({ LoginBrandPanel: () => <div>marketing brand panel</div> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import AdminSignInPage from '../../../pages/console-sign-in';
import LoginPage from '../../../pages/login';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"success":true,"data":{}}', { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('admin console sign-in page', () => {
  it('is branded as the admin console and links back to the app', () => {
    render(<AdminSignInPage />);
    expect(screen.getByRole('heading', { name: 'Admin console: sign in' })).toBeTruthy();
    expect(screen.getByText(/separate sign-in from the IsaFlow app/)).toBeTruthy();
    const back = screen.getByRole('link', { name: /Back to the IsaFlow app/ });
    expect(back.getAttribute('href')).toBe('https://app.isaflow.co.za/accounting');
  });

  it('drops the marketing chrome but keeps the sign-in form', () => {
    const { container } = render(<AdminSignInPage />);
    const text = container.textContent ?? '';
    for (const marketing of ['Start Free Trial', 'Welcome back', 'Start your free trial', 'Pricing', 'marketing brand panel']) {
      expect(text).not.toContain(marketing);
    }
    expect(text).not.toContain('—');
    expect(container.querySelector('input[type="email"]')).toBeTruthy();
    expect(container.querySelector('input[type="password"]')).toBeTruthy();
  });

  it('leaves the app /login page unchanged', () => {
    const { container } = render(<LoginPage />);
    const text = container.textContent ?? '';
    expect(text).toContain('Welcome back');
    expect(text).toContain('Start Free Trial');
    expect(text).toContain('marketing brand panel');
    expect(text).not.toContain('Admin console');
  });
});
