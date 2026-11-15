// Admin audit 2026-11-14, item 1.12: the webhook Redeliver button said "Delivery
// queued for retry" whatever happened; nothing was queued or sent. The route now
// sends and says whether the endpoint accepted it; the toast must say that.
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { DeliveryLog } from '@/components/admin/webhooks/DeliveryLog';

useApiJsonOverMock();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const DETAIL = {
  id: 'wh-1', companyId: 'c-1', companyName: 'Acme', name: 'Hook', url: 'https://example.test/h', events: ['invoice.created'],
  isActive: true, failureCount: 1, lastTriggeredAt: null, lastDeliveryStatus: 'failed', lastDeliveryAt: null, createdAt: '2026-11-01',
  deliveries: [{ id: 'd-1', webhookId: 'wh-1', event: 'invoice.created', responseStatus: 503, responseBody: null, success: false,
    deliveredAt: '2026-11-13T10:00:00Z' }],
};

function serve(redeliver: { delivered: boolean; responseStatus: number | null; message: string }) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/redeliver') && init?.method === 'POST') {
      return json({ success: true, data: { delivered: redeliver.delivered, responseStatus: redeliver.responseStatus, deliveryId: 'd-2' },
        message: redeliver.message });
    }
    return json({ success: true, data: DETAIL });
  });
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('webhook Redeliver tells the admin what the endpoint answered', () => {
  it('a refused redelivery says it failed, not that it was queued', async () => {
    serve({ delivered: false, responseStatus: 500, message: 'Redelivery failed: the endpoint gave HTTP 500' });
    render(<DeliveryLog webhookId="wh-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /redeliver last failed/i }));
    expect(await screen.findByText('Redelivery failed: the endpoint gave HTTP 500')).toBeTruthy();
    expect(screen.queryByText(/queued/i)).toBeNull();
  });

  it('an accepted redelivery says it was redelivered', async () => {
    serve({ delivered: true, responseStatus: 200, message: 'Redelivered (HTTP 200)' });
    render(<DeliveryLog webhookId="wh-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /redeliver last failed/i }));
    expect(await screen.findByText('Redelivered (HTTP 200)')).toBeTruthy();
  });
});
