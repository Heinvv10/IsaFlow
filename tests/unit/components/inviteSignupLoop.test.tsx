/**
 * Round-2 M1: the WRONG_INVITE_FLOW forward closed a click-loop.
 *
 *   /invite/<t> --"Create an Account"--> /register?invite=<t>
 *        ^                                     |
 *        +--- replace on 409 <-- /accept-invite?token=<t>
 *
 * A userInvitationService invitation is accepted at POST /api/invite/<token>,
 * which is withUserAuth — so a brand-new invitee needs an account first, and
 * that CTA is the only route to one. /register unconditionally bounced any
 * ?invite= to /accept-invite, which answers 409 for these tokens and bounces
 * back: the signup form was unreachable.
 *
 * `?signup=1` is set ONLY by /accept-invite's 409 branch, so an invitation that
 * the accept-invite flow CAN complete keeps its old routing.
 *
 * Rendered, not grepped: both behaviours are conditionals inside the page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, waitFor } from '@testing-library/react';

const replace = vi.fn();
let query: Record<string, string> = {};

vi.mock('next/router', () => ({
  useRouter: () => ({ query, isReady: true, replace }),
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

describe('/register invitation routing', () => {
  beforeEach(() => { replace.mockClear(); });

  it('still forwards a plain ?invite= link to the acceptance page', () => {
    query = { invite: 'accept-flow-token' };

    const { queryByTestId } = render(<RegisterPage />);

    expect(replace).toHaveBeenCalledWith('/accept-invite?token=accept-flow-token');
    expect(queryByTestId('signup-form')).toBeNull();
  });

  it('shows the signup form instead of bouncing when accept-invite said 409', () => {
    query = { invite: 'invite-flow-token', signup: '1' };

    const { queryByTestId } = render(<RegisterPage />);

    expect(replace).not.toHaveBeenCalled();
    expect(queryByTestId('signup-form')).not.toBeNull();
  });
});

describe('/accept-invite WRONG_INVITE_FLOW forward', () => {
  beforeEach(() => { replace.mockClear(); });

  it('carries the verdict to /invite/<token> as ?signup=1', async () => {
    query = { token: 'invite-flow-token' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ success: false, error: { code: 'WRONG_INVITE_FLOW', message: 'wrong flow' } }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )));

    render(<AcceptInvitePage />);

    // Without the flag the forwarded page's signup CTA bounces straight back
    // here, and the invitee never reaches a form that can create their account.
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/invite/invite-flow-token?signup=1'));
    vi.unstubAllGlobals();
  });
});

describe('/invite/<token> signup CTA', () => {
  function stubLoad() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.startsWith('/api/invite/')) {
        return new Response(JSON.stringify({ data: {
          email: 'i***@test.local', companyName: 'Probe Co', role: 'viewer', invitedBy: 'Someone',
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 401 }); // signed out
    }));
  }

  it('propagates the flag so the CTA does not bounce back to /accept-invite', async () => {
    query = { token: 'invite-flow-token', signup: '1' };
    stubLoad();

    const { findByText } = render(<InvitePage />);

    const cta = await findByText('Create an Account');
    expect(cta.closest('a')!.getAttribute('href'))
      .toBe('/register?invite=invite-flow-token&signup=1');
    vi.unstubAllGlobals();
  });

  it('leaves an invitation opened straight from an email on the old routing', async () => {
    query = { token: 'accept-flow-token' };
    stubLoad();

    const { findByText } = render(<InvitePage />);

    const cta = await findByText('Create an Account');
    expect(cta.closest('a')!.getAttribute('href')).toBe('/register?invite=accept-flow-token');
    vi.unstubAllGlobals();
  });
});
