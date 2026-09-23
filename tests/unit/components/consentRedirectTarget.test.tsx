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
