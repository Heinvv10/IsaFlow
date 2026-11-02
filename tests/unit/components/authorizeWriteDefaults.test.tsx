/** The OAuth page never carries write consent into a fresh company choice. */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/oauth', () => ({
  getOauthAppByClientId: vi.fn(),
  OAUTH_SCOPES: ['read:reports', 'write:invoices', 'write:journals', 'write:post'],
}));
vi.mock('@/modules/accounting/services/core/companyService', () => ({ getUserCompanies: vi.fn() }));
vi.mock('@/lib/auth/gotrue', () => ({ verifyToken: vi.fn() }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import AuthorizePage from '../../../pages/oauth/authorize';

const WRITES = ['write:invoices', 'write:journals', 'write:post'];

describe('/oauth/authorize write defaults', () => {
  it('starts every requested write unticked and resets them on company switch', () => {
    render(<AuthorizePage
      ok
      app={{ name: 'Claude Code', description: null, logoUrl: null, homepageUrl: null, isVerified: true }}
      clientId="client_test"
      redirectUri="https://claude.ai/api/mcp/auth_callback"
      scopes={['read:reports', ...WRITES]}
      state="state"
      codeChallenge="challenge"
      codeChallengeMethod="S256"
      resource={null}
      issuer="https://app.isaflow.co.za"
      companies={[
        { id: 'company-1', name: 'First Company' },
        { id: 'company-2', name: 'Second Company' },
      ]}
      selectedCompanyId="company-1"
    />);

    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes).toHaveLength(WRITES.length);
    expect(checkboxes.every((checkbox) => !checkbox.checked)).toBe(true);

    fireEvent.click(checkboxes[0]!);
    expect(checkboxes[0]!.checked).toBe(true);

    fireEvent.change(screen.getByLabelText('Company this access applies to'), {
      target: { value: 'company-2' },
    });
    expect(checkboxes.every((checkbox) => !checkbox.checked)).toBe(true);
  });
});
