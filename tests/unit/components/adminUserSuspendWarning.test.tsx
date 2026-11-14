/**
 * Admin audit 2026-11-14 item 3.2 (WP9), the user page: a suspension whose browser sessions GoTrue could not
 * revoke answers 200 with a message (pages/api/admin/users/[id]/suspend.ts). The page must show that message,
 * where it stays until the next action, not the plain "User suspended" toast. Real assertOk runs over a
 * scripted apiFetch.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'u-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import UserDetailPage from '../../../pages/admin/users/[id]';

void mockedApiFetchModule;
useApiJsonOverMock();

const D = '2026-01-01T00:00:00Z';
const USER = { id: 'u-1', first_name: 'Yvonne', last_name: 'Zuma', email: 'yz@example.com', phone: null, role: 'admin',
  status: 'active', last_login: null, login_count: 0, created_at: D, account_type: 'direct', bureaus: [], companies: [] };
const WARNING = 'User suspended and API tokens revoked, but existing browser sessions could not be revoked — '
  + 'they will expire on their own. Retry Force Logout once GoTrue is reachable.';

function serve(suspendAnswer: Record<string, unknown>) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const path = String(url).split('?')[0];
    const body = path === '/api/admin/users/u-1/suspend' ? suspendAnswer
      : { success: true, data: path === '/api/admin/users/u-1' ? USER : {} };
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

async function suspend() {
  render(<UserDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /^suspend$/i }));
  fireEvent.click(await screen.findByRole('button', { name: /click to confirm/i }));
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).endsWith('/suspend'))).toBe(true));
}

afterEach(() => { cleanup(); });

describe('user page: suspension outcome', () => {
  it('sessions not revoked: the server message is shown, not the plain toast', async () => {
    serve({ success: true, data: { suspended: true, sessions_revoked: false }, message: WARNING });
    await suspend();
    expect(await screen.findByText(/browser sessions could not be revoked/i)).toBeTruthy();
    expect(screen.queryByText('User suspended')).toBeNull();
  });

  it('a clean suspension: the plain toast, no warning', async () => {
    serve({ success: true, data: { suspended: true, sessions_revoked: true } });
    await suspend();
    expect(await screen.findByText('User suspended')).toBeTruthy();
    expect(screen.queryByText(/browser sessions could not be revoked/i)).toBeNull();
  });
});
