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
let query: Record<string, string> = {};

vi.mock('next/router', () => ({
  useRouter: () => ({ query, isReady: true, replace, push: vi.fn() }),
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

  /** GET /api/invite answers the invitation; /api/auth/me answers `me` (null = signed out). */
  function stub(me: { id: string; email: string } | null) {
    posts.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (init?.method === 'POST') {
        posts.push({ url, headers: new Headers(init.headers) });
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
  });

  it('signed in as someone else: no Join button, an explanation and a sign-out instead', async () => {
    query = { token: 'settings-invite-token' };
    stub({ id: 'u-2', email: 'someone@else.example' });

    const { findByText, queryByText } = render(<InvitePage />);

    expect(await findByText('Sign Out and Continue')).not.toBeNull();
    expect(queryByText('Join Probe Co')).toBeNull();
    expect(document.body.textContent).toContain('someone@else.example');
  });
});
