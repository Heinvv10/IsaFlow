// D2 round 6 (g3): the LIVE login page reads the status before the body. An auth outage (5xx, possibly an
// empty body) says "temporarily unavailable" - never "could not sign in" as if the password were wrong,
// never a JSON parse error; a 4xx keeps the server message; the TOTP step behaves the same.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

configure({ asyncUtilTimeout: 4000 });
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/login' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/image', () => ({ default: () => <span /> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ error: null, clearError: vi.fn(), isAuthenticated: false, loading: false }) }));
vi.mock('@/lib/auth/clearTenantClientState', () => ({ clearTenantClientState: vi.fn() }));
vi.mock('@/components/auth/LoginBrandPanel', () => ({ LoginBrandPanel: () => <div /> }));

import LoginPage from '../../../pages/login';

const fetchMock = vi.fn();
const UNAVAILABLE = /Sign-in is temporarily unavailable - please try again shortly/;
const MSG = 'D2 server says: that password is not right';
const envelope = (status: number, message: string) => new Response(JSON.stringify({ success: false, error: { code: 'X', message } }), { status });
const noRaw = () => expect(document.body.textContent ?? '').not.toMatch(/JSON|Unexpected end|HTTP \d|Login failed/);

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function signIn() {
  const { container } = render(<LoginPage />);
  fireEvent.change(container.querySelector('input[name="email"]')!, { target: { value: 'qa@example.test' } });
  fireEvent.change(container.querySelector('input[name="password"]')!, { target: { value: 'pw-123456' } });
  fireEvent.submit(container.querySelector('form')!);
  return container;
}

describe('credentials step', () => {
  it('empty-body 503 says sign-in is unavailable, not a wrong password', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    signIn();
    expect(await screen.findByText(UNAVAILABLE)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/could not sign in/i);
    noRaw();
  });
  it('HTML 502 from a proxy says unavailable', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 }));
    signIn();
    expect(await screen.findByText(UNAVAILABLE)).toBeTruthy();
    noRaw();
  });
  it('401 keeps the server message', async () => {
    fetchMock.mockResolvedValue(envelope(401, MSG));
    signIn();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('empty-body 401 says to check the credentials', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    signIn();
    expect(await screen.findByText(/could not sign in - check your email and password/i)).toBeTruthy();
    noRaw();
  });
  it('a 200 that is not the envelope is "unavailable", not a parse error', async () => {
    fetchMock.mockResolvedValue(new Response('<html>ok</html>', { status: 200 }));
    signIn();
    expect(await screen.findByText(UNAVAILABLE)).toBeTruthy();
    noRaw();
  });
});

describe('TOTP step', () => {
  const to2fa = async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { requires_2fa: true, factor_id: 'f1' } }), { status: 200 }));
    signIn();
    return screen.findByPlaceholderText('000000');
  };
  const submitCode = async (input: HTMLElement) => {
    fireEvent.change(input, { target: { value: '123456' } });
    await waitFor(() => expect((input.closest('form')!.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.submit(input.closest('form')!);
  };
  it('empty-body 503 on the challenge says unavailable', async () => {
    const input = await to2fa();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await submitCode(input);
    expect(await screen.findByText(UNAVAILABLE)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/invalid code/i);
    noRaw();
  });
  it('a dropped connection says the code could not be verified, not "Network error"', async () => {
    const input = await to2fa();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await submitCode(input);
    expect(await screen.findByText('Could not verify the code - check your connection and try again')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Network error');
  });
  it('4xx keeps the server message', async () => {
    const input = await to2fa();
    fetchMock.mockResolvedValueOnce(envelope(400, MSG));
    await submitCode(input);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
});
