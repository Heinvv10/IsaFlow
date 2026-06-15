/**
 * Pentest re-run H3 — admin health-alert webhook SSRF.
 *
 * The admin-supplied health_alert_webhook_url is only format-validated, then POSTed to.
 * sendWebhookAlert now goes through safeFetch (which re-resolves the host and rejects
 * private/reserved/metadata addresses). A blocked URL must NOT throw out of the alert
 * path — the cron should log a warning and carry on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock('@/lib/safeFetch', () => ({
  safeFetch: safeFetchMock,
  SsrfError: class SsrfError extends Error {},
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: vi.fn() }));

import { sendWebhookAlert } from '@/modules/admin/services/healthAlertService';

// Minimal SystemHealthResponse-shaped fixture.
const HEALTH = {
  overall_status: 'critical',
  checked_at: '2026-06-15T00:00:00Z',
  db: { latency_ms: 5 },
  job_queue: { failed: 2 },
  email: { success_rate_percent: 99 },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('healthAlertService H3 — webhook goes through safeFetch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts the alert via safeFetch, not a raw fetch', async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    await sendWebhookAlert(HEALTH, 'https://hooks.example.com/x');
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(safeFetchMock.mock.calls[0][0]).toBe('https://hooks.example.com/x');
    expect(safeFetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
  });

  it('swallows an SSRF rejection (blocked URL must not crash the cron)', async () => {
    safeFetchMock.mockRejectedValue(new Error('blocked address 10.0.0.5: private'));
    await expect(
      sendWebhookAlert(HEALTH, 'https://10.0.0.5/x'),
    ).resolves.toBeUndefined();
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });
});
