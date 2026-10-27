/**
 * An invitation is to JOIN an existing company. No route out of an invitation
 * link may land on the self-serve signup form, which creates a new company
 * (2026-10-27: a Velocity Fibre invitee clicking "Create an Account" got the
 * trial signup, and submitting it would have made them their own tenant with
 * the invitation still pending).
 *
 *   /invite/<t>  "Create Account & Join"     -> /accept-invite?token=<t>
 *                "I Already Have an Account" -> /login?invite=<t>&returnTo=/invite/<t>
 *   /register?invite=<t>                     -> /accept-invite?token=<t>  (always)
 *   /login?invite=<t> "Create one"           -> /accept-invite?token=<t>
 *
 * Rendered, not grepped: every behaviour here is a conditional inside a page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

const replace = vi.fn();
const push = vi.fn(async () => true);
let query: Record<string, string> = {};

vi.mock('next/router', () => ({
  useRouter: () => ({ query, isReady: true, replace, push }),
}));
vi.mock('@/components/auth/SignupForm', () => ({
  SignupForm: () => <div data-testid="signup-form" />,
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    <a href={href}>{children}</a>,
}));

import RegisterPage from '../../../pages/register';
import InvitePage from '../../../pages/invite/[token]';
import AcceptInvitePage from '../../../pages/accept-invite';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('/register with an invitation', () => {
  beforeEach(() => { replace.mockClear(); });

  it('always forwards to the acceptance page and never shows the new-company form', async () => {
    query = { invite: 'settings-invite-token' };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { queryByTestId } = render(<RegisterPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/accept-invite?token=settings-invite-token'));
    expect(queryByTestId('signup-form')).toBeNull();
    // No server verdict decides it any more: there is no opt-out to ask for.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores a hand-appended ?signup=1', async () => {
    query = { invite: 'settings-invite-token', signup: '1' };

    const { queryByTestId } = render(<RegisterPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/accept-invite?token=settings-invite-token'));
    expect(queryByTestId('signup-form')).toBeNull();
  });

  it('shows the signup form when there is no invitation at all', async () => {
    query = {};

    const { findByTestId } = render(<RegisterPage />);

    expect(await findByTestId('signup-form')).not.toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('/invite/<token>', () => {
  const posts: { url: string; headers: Headers }[] = [];

  /** GET /api/invite answers the invitation; /api/auth/me answers `me` (null = signed out); POST answers `post`. */
  function stub(me: { id: string; email: string } | null, post?: { status: number; message: string }) {
    posts.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (init?.method === 'POST') {
        posts.push({ url, headers: new Headers(init.headers) });
        if (post) return new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: post.message } }), { status: post.status });
        return new Response(JSON.stringify({ success: true, data: { companyId: 'co-1' } }), { status: 200 });
      }
      if (url.startsWith('/api/invite/')) {
        return new Response(JSON.stringify({ data: {
          email: 'i***@test.local', companyName: 'Probe Co', role: 'viewer', invitedBy: 'Someone',
        } }), { status: 200 });
      }
      if (url === '/api/auth/me' && me) {
        return new Response(JSON.stringify({ data: { user: me } }), { status: 200 });
      }
      return new Response('{}', { status: 401 });
    }));
  }

  it('signed out: "Create Account & Join" goes to the acceptance page, not /register', async () => {
    query = { token: 'settings-invite-token' };
    stub(null);

    const { findByText } = render(<InvitePage />);

    const cta = await findByText(/Create Account & Join/);
    expect(cta.closest('a')!.getAttribute('href')).toBe('/accept-invite?token=settings-invite-token');
    expect(document.body.innerHTML).not.toContain('/register');
  });

  it('signed out: the sign-in route comes back to this invitation', async () => {
    query = { token: 'settings-invite-token' };
    stub(null);

    const { findByText } = render(<InvitePage />);

    const cta = await findByText(/I Already Have an Account/);
    expect(cta.closest('a')!.getAttribute('href'))
      .toBe('/login?invite=settings-invite-token&returnTo=%2Finvite%2Fsettings-invite-token');
  });

  it('signed in as the invited address: Join sends the CSRF header', async () => {
    query = { token: 'settings-invite-token' };
    document.cookie = `isaflow_csrf=${'c'.repeat(32)}`;
    stub({ id: 'u-1', email: 'Invitee@test.local' });

    const { findByText } = render(<InvitePage />);
    fireEvent.click(await findByText('Join Probe Co'));

    await waitFor(() => expect(posts.map((p) => p.url)).toContain('/api/invite/settings-invite-token'));
    expect(posts[0]!.headers.get('X-CSRF-Token')).toBe('c'.repeat(32));
    // The page redirects 1.5 s after accepting; let it fire here, not inside a later test.
    await waitFor(() => expect(push).toHaveBeenCalledWith('/accounting'), { timeout: 3000 });
    push.mockClear();
  });

  it('signed in as someone else: no Join button, an explanation and a sign-out instead', async () => {
    query = { token: 'settings-invite-token' };
    stub({ id: 'u-2', email: 'someone@else.example' });

    const { findByText, queryByText } = render(<InvitePage />);

    expect(await findByText('Sign Out and Continue')).not.toBeNull();
    expect(queryByText('Join Probe Co')).toBeNull();
    expect(document.body.textContent).toContain('someone@else.example');
  });

  it('a same-mask address the server refuses as another person: the sign-out view, not an error', async () => {
    query = { token: 'settings-invite-token' };
    // i***@test.local masks both; only the server knows it is not the invitee.
    stub({ id: 'u-3', email: 'ian@test.local' }, { status: 403, message: 'This invitation was sent to a different email address' });

    const { findByText } = render(<InvitePage />);
    fireEvent.click(await findByText('Join Probe Co'));

    expect(await findByText('Sign Out and Continue')).not.toBeNull();
  });

  it('any other 403 (a CSRF refusal) stays an error, with the server message', async () => {
    query = { token: 'settings-invite-token' };
    stub({ id: 'u-1', email: 'invitee@test.local' }, { status: 403, message: 'CSRF token mismatch' });

    const { findByText, queryByText } = render(<InvitePage />);
    fireEvent.click(await findByText('Join Probe Co'));

    expect(await findByText('CSRF token mismatch')).not.toBeNull();
    expect(queryByText('Sign Out and Continue')).toBeNull();
  });
});

describe('/accept-invite for an account with two-factor sign-in', () => {
  beforeEach(() => { push.mockClear(); });

  it('MFA_REQUIRED sends the invitee to the real sign-in, which returns to the invitation', async () => {
    query = { token: 'tok-2fa' };
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'POST'
      ? new Response(JSON.stringify({ success: false, error: { code: 'MFA_REQUIRED', message: 'two-factor' } }), { status: 401 })
      : new Response(JSON.stringify({ success: true, data: { email: 'i***@test.local', role: 'viewer', company_name: 'Probe Co' } }), { status: 200 }))));

    const { findByText, container } = render(<AcceptInvitePage />);
    await findByText(/Join Probe Co/);
    fireEvent.change(container.querySelector('input[type="password"]')!, { target: { value: 'existing-password-1' } });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/login?invite=tok-2fa'));
    expect(push).not.toHaveBeenCalledWith('/accounting/dashboard');
  });
});

describe('/accept-invite on success', () => {
  beforeEach(() => { push.mockClear(); });

  // Browser proof 2026-10-27: it pushed /accounting/dashboard, which is a 404.
  it('lands the new member on the inviting company\'s dashboard', async () => {
    query = { token: 'tok-ok' };
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'POST'
      ? new Response(JSON.stringify({ success: true, data: { userId: 'u-1', companyId: 'co-1' } }), { status: 200 })
      : new Response(JSON.stringify({ success: true, data: { email: 'i***@test.local', role: 'viewer', company_name: 'Probe Co' } }), { status: 200 }))));

    const { findByText, container } = render(<AcceptInvitePage />);
    await findByText(/Join Probe Co/);
    fireEvent.change(container.querySelector('input[type="password"]')!, { target: { value: 'a-new-password-1' } });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/accounting'));
    expect(push).not.toHaveBeenCalledWith('/accounting/dashboard');
  });
});
