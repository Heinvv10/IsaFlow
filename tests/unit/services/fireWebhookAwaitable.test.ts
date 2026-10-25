/**
 * R-075 r2 — fireWebhook must be awaitable, not self-detaching.
 *
 * Its delivery-log INSERT and endpoint UPDATE run AFTER an outbound fetch. While
 * the body sat inside a floating `void (async () => …)()` IIFE, a caller under a
 * request transaction could not hold those writes inside the request no matter
 * what it did — they always landed after the caller returned, which is exactly
 * R-075's shape. It was safe only because its single caller had been converted
 * to runAfterCommit; a second caller would have reopened the defect silently.
 *
 * Restore the IIFE and this goes red: `await fireWebhook(...)` resolves before
 * the INSERT is issued.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(), safeFetch: vi.fn(),
  route: [] as Array<{ label: string; text: string; values: unknown[] }>,
  routeFails: false,
  order: [] as string[],
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/safeFetch', () => ({ safeFetch: m.safeFetch }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({ migrationAdminTx: vi.fn() }));
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (label: string, text: string, values: unknown[]) => {
    m.route.push({ label, text: text.replace(/\s+/g, ' ').trim(), values });
    m.order.push(`route:${values[0]}`);
    if (m.routeFails) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    return [];
  }),
}));

import { log } from '@/lib/logger';
import { fireWebhook } from '@/modules/accounting/services/core/webhookService';

const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENDPOINT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SECOND = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const statements = () => m.sql.mock.calls.map((c) => (c[0] as string[]).join('?'));
const endpoint = (id: string) => ({ id, company_id: COMPANY, name: 'w', url: `https://hook.test/${id}`,
  secret: null, events: ['invoice.sent'], is_active: true, created_at: new Date() });

beforeEach(() => {
  vi.clearAllMocks();
  m.route.length = 0;
  m.order.length = 0;
  m.routeFails = false;
  m.sql.mockImplementation(async (parts: string[]) => {
    const text = parts.join('');
    if (text.includes('FROM webhook_endpoints')) return [endpoint(ENDPOINT)];
    return [];
  });
  // Resolves a tick later, so a floating body cannot finish inside the await.
  m.safeFetch.mockImplementation(async (url: string) => {
    m.order.push(`fetch:${url}`);
    await new Promise((r) => setTimeout(r, 5));
    return { status: 200, ok: true, text: async () => 'ok' };
  });
});

describe('fireWebhook', () => {
  it('has issued its post-fetch writes by the time it resolves', async () => {
    await fireWebhook(COMPANY, 'invoice.sent', { invoiceId: 'i1' });
    expect(statements().some((s) => s.includes('INSERT INTO webhook_deliveries'))).toBe(true);
    expect(m.route.some((w) => w.text.startsWith('UPDATE webhook_endpoints'))).toBe(true);
  });

  it('binds the tenant into the endpoint stamp, not the derived id alone', async () => {
    await fireWebhook(COMPANY, 'invoice.sent', { invoiceId: 'i1' });
    // migration_admin bypasses RLS, so the UPDATE must carry the company itself: in its text and its bound values.
    const w = m.route.find((x) => x.text.startsWith('UPDATE webhook_endpoints'))!;
    expect(w.text).toMatch(/WHERE id = \$1::UUID AND company_id = \$2::UUID$/);
    expect(w.values.slice(0, 2)).toEqual([ENDPOINT, COMPANY]);
  });

  it('still never throws to the caller', async () => {
    m.safeFetch.mockRejectedValue(new Error('endpoint down'));
    await expect(fireWebhook(COMPANY, 'invoice.sent', {})).resolves.toBeUndefined();
  });

  // S-07e part B, review round 5: no app role may write webhook_endpoints at all (migration 946), so the
  // delivery stamps (last_triggered_at, failure_count) and the auto-disable run on migration_admin.
  describe('the delivery stamp and the auto-disable', () => {
    const appUpdates = () => statements().filter((t) => t.includes('UPDATE webhook_endpoints'));

    it('a success stamps last_triggered_at and resets failure_count on migration_admin; nothing on the app pool', async () => {
      await fireWebhook(COMPANY, 'invoice.sent', {});
      expect(m.route).toHaveLength(1);
      expect(m.route[0]!.text).toContain('SET last_triggered_at = NOW(), failure_count = 0');
      expect(m.route[0]!.text).not.toContain('is_active');
      expect(appUpdates()).toEqual([]);
    });

    it('a failure counts up and switches the endpoint off at 10, in one migration_admin statement; nothing on the app pool', async () => {
      m.safeFetch.mockRejectedValue(new Error('endpoint down'));
      await fireWebhook(COMPANY, 'invoice.sent', {});
      expect(m.route).toHaveLength(1);
      const w = m.route[0]!;
      expect(w.text).toContain('SET failure_count = failure_count + 1');
      expect(w.text).toContain('is_active = CASE WHEN failure_count + 1 >= $3 THEN false ELSE is_active END');
      expect(w.values).toEqual([ENDPOINT, COMPANY, 10]);
      expect(appUpdates()).toEqual([]);
    });

    it('a stamp that is refused (55P03 after its 2 s) is logged, not thrown, and the next endpoint is still delivered', async () => {
      m.routeFails = true;
      m.sql.mockImplementation(async (parts: string[]) => (parts.join('').includes('FROM webhook_endpoints')
        ? [endpoint(ENDPOINT), endpoint(SECOND)] : []));
      await expect(fireWebhook(COMPANY, 'invoice.sent', {})).resolves.toBeUndefined();
      expect(m.order).toEqual([`fetch:https://hook.test/${ENDPOINT}`, `route:${ENDPOINT}`, `fetch:https://hook.test/${SECOND}`, `route:${SECOND}`]);
      expect(vi.mocked(log.error).mock.calls.filter((c) => c[0] === 'Webhook delivery stamp failed')).toHaveLength(2);
    });
  });
});
