// D2 round 7 (k5): OAuth apps (a good revoke / create whose RELOAD fails must still be reported; one toast slot)
// and capture settings (inbox address load).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve, type Route } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/accounting/capture/WhatsAppVerificationSection', () => ({ WhatsAppVerificationSection: () => null }));
vi.mock('@/components/accounting/capture/CaptureApiKeysSection', () => ({ CaptureApiKeysSection: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import OauthAppsPage from '../../../pages/developer/oauth-apps';
import CaptureSettingsPage from '../../../pages/accounting/capture/settings';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.stubGlobal('confirm', () => true); });
afterEach(() => { cleanup(); });

const APP = { id: 'a-1', name: 'D2 App', description: null, logoUrl: null, homepageUrl: null, redirectUris: ['https://x.test/cb'],
  clientId: 'cid', clientSecretPrefix: 'sec_', isVerified: false, isFirstParty: false, createdAt: '2026-01-01T00:00:00Z' };
const APPS = '/api/developer/oauth-apps';
/** The list answers once, then (after the write) is refused. */
function listThenRefused(write: Route): Route[] {
  let wrote = false;
  return [
    (u, m) => (write(u, m) ? ((wrote = true), write(u, m)) : undefined),
    (u, m) => (m === 'GET' && u.endsWith(APPS) ? (wrote ? refuse() : ok([APP])) : undefined),
  ];
}

describe('oauth apps: revoke', () => {
  const revoke = async () => { render(<OauthAppsPage />); await screen.findByText('D2 App'); fireEvent.click(screen.getByRole('button', { name: /revoke/i })); };
  it('400: the server message and no success toast', async () => {
    serve(on('DELETE', `${APPS}/a-1`, () => refuse()), on('GET', APPS, () => ok([APP])));
    await revoke();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('App revoked')).toBeNull();
  });
  it('empty 500: a plain sentence', async () => {
    serve(on('DELETE', `${APPS}/a-1`, () => empty500()), on('GET', APPS, () => ok([APP])));
    await revoke();
    expect(await screen.findByText('Could not revoke the app - try again')).toBeDefined();
    expectNoJargon();
  });
  it('200 and the reload works: says the app was revoked', async () => {
    let gone = false;
    serve(on('DELETE', `${APPS}/a-1`, () => { gone = true; return ok({}); }), (u, m) => (m === 'GET' && u.endsWith(APPS) ? ok(gone ? [] : [APP]) : undefined));
    await revoke();
    expect(await screen.findByText('App revoked')).toBeDefined();
  });
  it('200 but the reload fails: STILL reports the revoke, and clears the stale list', async () => {
    serve(...listThenRefused((u, m) => (m === 'DELETE' && u.endsWith('/a-1') ? ok({}) : undefined)));
    await revoke();
    expect(await screen.findByText('App revoked, but the list could not be refreshed - reload the page')).toBeDefined();
    expect(screen.queryByText('D2 App')).toBeNull();
  });
});

describe('oauth apps: register', () => {
  const register = async () => {
    render(<OauthAppsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /register app/i }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Hubdoc'), { target: { value: 'New D2 App' } });
    fireEvent.change(screen.getByPlaceholderText(/your-app.com\/oauth\/callback/), { target: { value: 'https://x.test/cb' } });
    fireEvent.click(screen.getByRole('button', { name: /create app/i }));
  };
  const created = { id: 'a-2', name: 'New D2 App', clientId: 'c2', clientSecret: 'D2-SECRET-ONCE', redirectUris: ['https://x.test/cb'] };
  it('400: the server message, form stays open', async () => {
    serve(on('POST', APPS, () => refuse()), on('GET', APPS, () => ok([])));
    await register();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByRole('button', { name: /create app/i })).toBeDefined();
  });
  it('200 but the reload fails: the secret is shown AND the toast says the app was registered', async () => {
    serve(...listThenRefused((u, m) => (m === 'POST' && u.endsWith(APPS) ? ok(created) : undefined)));
    await register();
    expect(await screen.findByText('App registered, but the list could not be refreshed - reload the page')).toBeDefined();
    expect(document.body.textContent).toContain('D2-SECRET-ONCE');
  });
});

describe('capture settings: inbox address load', () => {
  it('400: the server message and no stale address', async () => {
    serve(on('GET', 'inbox-address', () => refuse()), on('GET', 'chase-settings', () => ok({ chaseAutoSendEnabled: false, chaseGraceDays: 3, whatsappChaseEnabled: false })));
    render(<CaptureSettingsPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('empty 500: a plain sentence, no leftover "Failed to load"', async () => {
    serve(on('GET', 'inbox-address', () => empty500()), on('GET', 'chase-settings', () => ok({ chaseAutoSendEnabled: false, chaseGraceDays: 3, whatsappChaseEnabled: false })));
    render(<CaptureSettingsPage />);
    expect(await screen.findByText('Could not load the inbox address - try again')).toBeDefined();
    expectNoJargon();
    expect(document.body.textContent).not.toMatch(/Failed to/);
  });
  it('200: shows the address', async () => {
    serve(on('GET', 'inbox-address', () => ok({ inbox: { id: 'i', address: 'd2@in.test' } })), on('GET', 'chase-settings', () => ok({ chaseAutoSendEnabled: false, chaseGraceDays: 3, whatsappChaseEnabled: false })));
    render(<CaptureSettingsPage />);
    await waitFor(() => expect(document.body.textContent).toContain('d2@in.test'));
  });
});
