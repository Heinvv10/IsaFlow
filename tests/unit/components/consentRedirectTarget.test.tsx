/**
 * The consent screen must say where an authorisation would actually go, and
 * must not say it the same way for a hosted app and for one on the reader's own
 * machine. Rendered, because reading the JSX does not prove what a user sees.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// Server-only modules the page imports at module scope.
vi.mock('@/lib/auth/oauth', () => ({ getOauthAppByClientId: vi.fn(), OAUTH_SCOPES: ['read:invoices'] }));
vi.mock('@/modules/accounting/services/core/companyService', () => ({ getUserCompanies: vi.fn() }));
vi.mock('@/lib/auth/gotrue', () => ({ verifyToken: vi.fn() }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import AuthorizePage from '../../../pages/oauth/authorize';

const props = (redirectUri: string) => ({
  ok: true as const,
  app: { name: 'Claude Code', description: null, logoUrl: null, homepageUrl: null, isVerified: false },
  clientId: 'client_test',
  redirectUri,
  scopes: ['read:invoices'],
  state: 'st',
  codeChallenge: 'cc',
  codeChallengeMethod: 'S256' as const,
  companies: [{ companyId: 'c1', companyName: 'Acme (Pty) Ltd', role: 'owner' }],
  selectedCompanyId: 'c1',
});

describe('consent screen — where the authorisation goes', () => {
  it('names the host for a hosted client', () => {
    render(<AuthorizePage {...props('https://claude.ai/api/mcp/auth_callback')} />);
    expect(screen.getByText('claude.ai')).toBeTruthy();
  });

  // The port identifies nobody: the legitimate client and an impostor both get
  // a random loopback port. Showing it would imply a check the reader cannot make.
  it('does not show a host or port for a client on the reader\'s machine', () => {
    const { container } = render(<AuthorizePage {...props('http://localhost:57526/callback')} />);
    expect(screen.getByText('a program running on this computer')).toBeTruthy();
    expect(container.textContent).not.toContain('57526');
    expect(container.textContent).not.toContain('localhost');
  });

  // The registrable domain is at the END of a host, so anything that shortens
  // or clips the string hides the part that identifies the recipient. An
  // attacker can register a ~400-character host within the 512 cap. Adversarial
  // review measured the pre-wrap version clipping the tail off the card with no
  // ellipsis, on desktop AND blowing the column out on mobile.
  it('renders the whole host, including the tail that identifies the domain', () => {
    const host = 'claude.ai.' + 'a.'.repeat(185) + 'evil.example';
    const { container } = render(<AuthorizePage {...props(`https://${host}/cb`)} />);
    const rendered = container.querySelector('span.break-all');
    expect(rendered?.textContent).toBe(host);
    expect(rendered?.textContent?.endsWith('evil.example')).toBe(true);
  });

  // happy-dom cannot measure layout, so this pins the wrapping class itself.
  // Without it the host renders on one unbroken line and the card's
  // overflow-hidden silently eats the tail — verified in a real browser, where
  // break-all wraps a 392-character host across 5 line boxes inside the card.
  it('keeps the host breakable so a long one cannot be clipped', () => {
    const { container } = render(<AuthorizePage {...props('https://claude.ai/cb')} />);
    expect(container.querySelector('span.break-all')).not.toBeNull();
  });

  // Two different clients must not produce the same sentence.
  it('renders the two kinds differently', () => {
    const hosted = render(<AuthorizePage {...props('https://claude.ai/cb')} />).container.textContent;
    const local = render(<AuthorizePage {...props('http://127.0.0.1:1/cb')} />).container.textContent;
    expect(hosted).not.toEqual(local);
  });

  // Registration refuses these, so rather than guess, the line is absent.
  it('says nothing when the target cannot be described', () => {
    const { container } = render(<AuthorizePage {...props('not a url')} />);
    expect(container.textContent).not.toContain('Sends your authorisation to');
  });
});
