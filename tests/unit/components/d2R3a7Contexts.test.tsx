/**
 * D2 round 3 (a7): AuthProvider on the REAL apiFetch over a stubbed fetch. A 5xx on the session re-check is not
 * "signed out"; a failed sign-in shows the server message or a plain sentence (never a JSON parse error).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { AuthProvider, useAuth } from '@/contexts/AuthContext';

const MSG = 'D2 server says no: wrong password';
const json = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const USER = { id: 'u1', email: 'd2@example.com', role: 'owner' };
const stubFetch = (fn: (url: string, init?: RequestInit) => Response) => vi.stubGlobal('fetch', vi.fn(async (u: unknown, i?: RequestInit) => fn(String(u), i)));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

function AuthProbe() {
  const { user, login } = useAuth();
  return (
    <div>
      <span data-testid="who">{user?.email ?? 'nobody'}</span>
      <button onClick={() => { void login('a@b.c', 'pw').catch((e: Error) => { document.body.setAttribute('data-login-error', e.message); }); }}>sign in</button>
    </div>
  );
}

describe('AuthProvider', () => {
  const mount = async (me: () => Response) => {
    let phase = 0;
    stubFetch(u => (u === '/api/auth/me' ? (phase++ === 0 ? json(200, { success: true, data: { user: USER } }) : me()) : json(200, {})));
    render(<AuthProvider><AuthProbe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('d2@example.com'));
    await act(async () => { window.dispatchEvent(new Event('focus')); await new Promise(r => setTimeout(r, 30)); });
  };
  it('a 500 on the focus re-check keeps the signed-in user (not signed out)', async () => {
    await mount(() => json(500, ''));
    expect(screen.getByTestId('who').textContent).toBe('d2@example.com');
  });
  it('a dropped connection on the re-check keeps the signed-in user', async () => {
    let phase = 0;
    stubFetch(u => { if (u === '/api/auth/me' && phase++ > 0) throw new TypeError('Failed to fetch'); return json(200, { data: { user: USER } }); });
    render(<AuthProvider><AuthProbe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('d2@example.com'));
    await act(async () => { window.dispatchEvent(new Event('focus')); await new Promise(r => setTimeout(r, 30)); });
    expect(screen.getByTestId('who').textContent).toBe('d2@example.com');
  });
  it('a 401 on the re-check signs the user out', async () => {
    await mount(() => json(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'no' } }));
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('nobody'));
  });
  const signIn = async (res: () => Response) => {
    stubFetch(u => (u.includes('/api/auth/login') ? res() : json(401, '')));
    render(<AuthProvider><AuthProbe /></AuthProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'sign in' }));
    await waitFor(() => expect(document.body.getAttribute('data-login-error')).not.toBeNull());
    const msg = document.body.getAttribute('data-login-error'); document.body.removeAttribute('data-login-error'); return msg;
  };
  it('login 400: the server message', async () => {
    expect(await signIn(() => json(400, { success: false, error: { code: 'X', message: MSG } }))).toBe(MSG);
  });
  it('login empty-body 500: a plain sentence, not "Unexpected end of JSON input"', async () => {
    expect(await signIn(() => json(500, ''))).toBe('Could not sign in - try again');
  });
  it('login dropped connection: a plain sentence, not "Failed to fetch"', async () => {
    expect(await signIn(() => { throw new TypeError('Failed to fetch'); })).toBe('Could not sign in - try again');
  });
});

