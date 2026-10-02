/**
 * D2 round 7 (gb): admin webhook toggle/delete read the status first (a refusal shows the server message, an empty
 * 500 a plain sentence), and the capture upload helper does the same. REAL assertOk / apiErrorMessage over a scripted apiFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoRawError, ok, refuse, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import AdminWebhooksPage from '../../../pages/admin/webhooks';
import { uploadFiles } from '../../../src/components/capture/captureUpload';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const HOOK = { id: 'w1', companyId: 'c1', companyName: 'D2 Co', name: 'hook', url: 'https://d2.example/hook', events: ['invoice.paid'],
  isActive: true, failureCount: 0, lastTriggeredAt: null, lastDeliveryStatus: 'none', lastDeliveryAt: null, createdAt: '2026-01-01T00:00:00Z' };
const LIST = { items: [HOOK], total: 1 };

describe('admin webhooks: toggle', () => {
  const toggle = async () => fireEvent.click(await screen.findByTitle('Disable webhook'));
  it('a refused toggle shows the server message', async () => {
    script((u, m) => (m === 'PATCH' ? refuse() : ok(LIST))); render(<AdminWebhooksPage />); await toggle();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty-500 toggle shows a plain sentence', async () => {
    script((u, m) => (m === 'PATCH' ? empty500() : ok(LIST))); render(<AdminWebhooksPage />); await toggle();
    expect(await screen.findByText('Could not update the webhook - try again')).toBeTruthy(); expectNoRawError();
  });
  it('a good toggle says so', async () => {
    script((u, m) => (m === 'PATCH' ? ok({}) : ok(LIST))); render(<AdminWebhooksPage />); await toggle();
    expect(await screen.findByText('Webhook disabled')).toBeTruthy();
  });
});

describe('admin webhooks: delete', () => {
  const del = async () => {
    fireEvent.click(await screen.findByTitle('Delete webhook'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Webhook' }));
  };
  it('a refused delete shows the server message', async () => {
    script((u, m) => (m === 'DELETE' ? refuse() : ok(LIST))); render(<AdminWebhooksPage />); await del();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty-500 delete shows a plain sentence', async () => {
    script((u, m) => (m === 'DELETE' ? empty500() : ok(LIST))); render(<AdminWebhooksPage />); await del();
    expect(await screen.findByText('Could not delete the webhook - try again')).toBeTruthy(); expectNoRawError();
  });
  it('a good delete says so', async () => {
    script((u, m) => (m === 'DELETE' ? ok({}) : ok(LIST))); render(<AdminWebhooksPage />); await del();
    expect(await screen.findByText('Webhook deleted')).toBeTruthy();
  });
});

describe('capture upload helper', () => {
  const file = () => [new File(['x'], 'a.png', { type: 'image/png' })];
  it('a refused upload carries the server message', async () => {
    script(() => refuse());
    await expect(uploadFiles(file())).rejects.toMatchObject({ message: MSG });
  });
  it('an empty-500 upload is a plain sentence, not a parse error', async () => {
    script(() => empty500());
    await expect(uploadFiles(file())).rejects.toMatchObject({ message: 'Could not upload the documents - try again' });
  });
  it('a 200 resolves the document ids', async () => {
    script(() => ok({ eventIds: ['e1'], documentIds: ['d1'] }));
    await expect(uploadFiles(file())).resolves.toEqual({ eventIds: ['e1'], documentIds: ['d1'] });
  });
});
