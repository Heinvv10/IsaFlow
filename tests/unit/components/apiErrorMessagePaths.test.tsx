/**
 * W1-02: the failure paths of the pages moved onto apiJson show the server's
 * own message (apiErrorMessage), not a generic string, and are logged.
 * Real apiFetch/apiJson run; only the network (global fetch) is stubbed.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CaptureSettingsPage from '@/../pages/accounting/capture/settings';
import ValidatePage from '@/../pages/accounting/migration/validate';

const logError = vi.fn();
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: (...a: unknown[]) => logError(...a), info: vi.fn() } }));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true }),
}));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/accounting/capture/WhatsAppVerificationSection', () => ({ WhatsAppVerificationSection: () => null }));
vi.mock('@/components/accounting/capture/CaptureApiKeysSection', () => ({ CaptureApiKeysSection: () => null }));

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fail = (message: string) => new Response(JSON.stringify({ success: false, message }), { status: 500 });
const chase = { chaseAutoSendEnabled: false, chaseGraceDays: 3, whatsappChaseEnabled: false };

beforeEach(() => { logError.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('capture settings: a failed address load shows the server message', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
    String(url).includes('inbox-address') ? fail('Inbox service down') : ok(chase)));
  render(<CaptureSettingsPage />);
  expect(await screen.findByText(/Inbox service down/)).toBeInTheDocument();
});

it('capture settings: a failed regenerate shows the server message', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).includes('inbox-address')) return ok(chase);
    return init?.method === 'POST'
      ? fail('Regeneration refused')
      : ok({ inbox: { id: 'i1', address: 'cap-1@inbox.isaflow.co.za', isActive: true } });
  }));
  render(<CaptureSettingsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Regenerate address/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Yes, regenerate/ }));
  expect(await screen.findByText(/Regeneration refused/)).toBeInTheDocument();
});

it('migration validate: a failed session load shows the server message and is logged', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => fail('Migration service unavailable')));
  render(<ValidatePage />);
  expect(await screen.findByText(/Migration service unavailable/)).toBeInTheDocument();
  expect(logError).toHaveBeenCalled();
});
