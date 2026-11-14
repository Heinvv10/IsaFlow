// Admin Users (WP13, admin audit 4.17): the Status filter offers only states a user can be in. The API knows
// active and suspended (users.is_active); an "Inactive" option always listed nobody.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/', asPath: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));

import { apiFetch } from '@/lib/apiFetch';
import UsersPage from '../../../pages/admin/users/index';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

describe('users status filter', () => {
  it('offers All, Active and Suspended only', () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () =>
      new Response(JSON.stringify({ success: true, data: { items: [], total: 0, page: 1, limit: 25 } }), { status: 200 }));
    render(<UsersPage />);
    const options = within(screen.getByLabelText('Status')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['', 'active', 'suspended']);
  });
});
