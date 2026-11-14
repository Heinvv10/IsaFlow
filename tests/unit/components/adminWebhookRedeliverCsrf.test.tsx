// #1370 review M2: the redeliver route is now behind withCsrf, so the Redeliver
// button must send the CSRF token. This runs the REAL apiFetch (not the scripted
// mock) over a stubbed global fetch, and reads the headers that went out.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { DeliveryLog } from '@/components/admin/webhooks/DeliveryLog';

const CSRF = 'wp11-csrf-cookie-0123456789abcdef0123456789abcdef';
const DETAIL = {
  id: 'wh-1', companyId: 'c-1', companyName: 'Acme', name: 'Hook', url: 'https://example.test/h', events: ['invoice.created'],
  isActive: true, failureCount: 1, lastTriggeredAt: null, lastDeliveryStatus: 'failed', lastDeliveryAt: null, createdAt: '2026-11-01',
  deliveries: [{ id: 'd-1', webhookId: 'wh-1', event: 'invoice.created', responseStatus: 503, responseBody: null, success: false,
    deliveredAt: '2026-11-13T10:00:00Z' }],
};
const sent: Array<{ url: string; method: string; headers: Headers }> = [];

beforeEach(() => {
  sent.length = 0;
  document.cookie = `isaflow_csrf=${CSRF}`;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    sent.push({ url, method: String(init?.method ?? 'GET'), headers: new Headers(init?.headers) });
    const data = url.endsWith('/redeliver') ? { delivered: true, responseStatus: 200, deliveryId: 'd-2' } : DETAIL;
    return new Response(JSON.stringify({ success: true, data, message: 'Redelivered (HTTP 200)' }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.cookie = 'isaflow_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT'; });

describe('webhook Redeliver sends the CSRF token', () => {
  // X-Admin-Request is WP1's (adminFetch, #1366 census); this pins only the CSRF token withCsrf now demands.
  it('the POST carries X-CSRF-Token from the cookie', async () => {
    render(<DeliveryLog webhookId="wh-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /redeliver last failed/i }));
    await waitFor(() => expect(sent.some((s) => s.method === 'POST')).toBe(true));
    const post = sent.find((s) => s.method === 'POST')!;
    expect(post.url).toBe('/api/admin/webhooks/wh-1/redeliver');
    expect(post.headers.get('X-CSRF-Token')).toBe(CSRF);
  });
});
