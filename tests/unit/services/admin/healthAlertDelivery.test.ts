/**
 * checkAndAlert (admin audit OP-1, review M1 + L-b): it sends only after winning the claim
 * (healthAlertState.claimAlert), and when every enabled channel fails it releases the claim
 * so the next pass retries, then throws. One channel delivering is enough: the claim stands.
 * The claim itself (advisory lock, real rows) is pinned in
 * tests/integration/admin-health-alert-claim.int.test.ts. No email or webhook leaves this test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  order: [] as string[],
}));
const CLAIM = vi.hoisted(() => ({ status: 'critical', claimedAt: '2026-11-15T10:00:00.000Z', previous: { status: null, sentAt: null } }));
const state = vi.hoisted(() => ({
  claimAlert: vi.fn(async () => { fx.order.push('claim'); return CLAIM as unknown; }),
  releaseClaim: vi.fn(async () => true),
  markHealthy: vi.fn(async () => undefined),
  settingText: (raw: unknown) => (raw == null ? null : String(raw)),
}));
const sendEmail = vi.hoisted(() => vi.fn(async () => { fx.order.push('email'); return { success: true } as { success: boolean; error?: string }; }));
const safeFetch = vi.hoisted(() => vi.fn(async () => { fx.order.push('webhook'); return { ok: true, status: 200 }; }));

vi.mock('@/modules/admin/services/healthAlertState', () => state);
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail }));
vi.mock('@/lib/safeFetch', () => ({ safeFetch }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    fx.order.push(`read:${String(values[0])}`);
    const v = fx.settings[String(values[0])];
    return v === undefined ? [] : [{ value: v }];
  },
}));

import { checkAndAlert } from '@/modules/admin/services/healthAlertService';

const HEALTH = {
  overall_status: 'critical', checked_at: '2026-11-15T10:00:00.000Z',
  db: { status: 'error', latency_ms: 5, size_mb: 1 }, job_queue: { pending: 0, running: 0, failed: 0, oldest_pending_age_minutes: null },
  email: { sent_24h: 0, failed_24h: 0, bounced_24h: 0, success_rate_percent: null },
  users_signed_in_24h: 0, trials: { expiring_in_7d: 0 }, recent_errors: [], scheduled_check: { last_run_at: null },
} as const;
const run = () => checkAndAlert(HEALTH as never);

beforeEach(() => {
  vi.clearAllMocks();
  fx.settings = { health_alert_email: 'ops@example.test' };
  fx.order = [];
  delete process.env.ADMIN_ALERT_WEBHOOK_URL;
});

describe('checkAndAlert claims before it sends', () => {
  it('resolves recipients, claims, then sends', async () => {
    await run();
    expect(fx.order).toEqual(['read:health_alert_email', 'read:health_alert_webhook_url', 'claim', 'email']);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@example.test' }));
    expect(state.releaseClaim).not.toHaveBeenCalled();
  });

  it('sends nothing when the claim is lost (already alerted)', async () => {
    state.claimAlert.mockResolvedValueOnce(null);
    await run();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('healthy: resets the state and neither claims nor sends', async () => {
    await checkAndAlert({ ...HEALTH, overall_status: 'healthy' } as never);
    expect(state.markHealthy).toHaveBeenCalledTimes(1);
    expect(state.claimAlert).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('every enabled channel failing releases the claim (L-b)', () => {
  it('email refused, no webhook: releases and throws', async () => {
    sendEmail.mockResolvedValueOnce({ success: false, error: 'SMTP 550' });
    await expect(run()).rejects.toThrow('reached no channel');
    expect(state.releaseClaim).toHaveBeenCalledWith(CLAIM);
  });

  it('email throws and the webhook answers 500: releases and throws', async () => {
    fx.settings.health_alert_webhook_url = 'https://hooks.example.test/x';
    sendEmail.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    safeFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(run()).rejects.toThrow('reached no channel');
    expect(state.releaseClaim).toHaveBeenCalledTimes(1);
  });

  it('email refused but the webhook delivered: the claim stands', async () => {
    fx.settings.health_alert_webhook_url = 'https://hooks.example.test/x';
    sendEmail.mockResolvedValueOnce({ success: false, error: 'SMTP 550' });
    await expect(run()).resolves.toBeUndefined();
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(state.releaseClaim).not.toHaveBeenCalled();
  });

  it('email sent but the webhook refused: the claim stands', async () => {
    fx.settings.health_alert_webhook_url = 'https://hooks.example.test/x';
    safeFetch.mockRejectedValueOnce(new Error('blocked address 10.0.0.5'));
    await expect(run()).resolves.toBeUndefined();
    expect(state.releaseClaim).not.toHaveBeenCalled();
  });
});
