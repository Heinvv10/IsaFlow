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

const m = vi.hoisted(() => ({ sql: vi.fn(), safeFetch: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/safeFetch', () => ({ safeFetch: m.safeFetch }));

import { fireWebhook } from '@/modules/accounting/services/core/webhookService';

const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const statements = () => m.sql.mock.calls.map((c) => (c[0] as string[]).join('?'));

beforeEach(() => {
  vi.clearAllMocks();
  m.sql.mockImplementation(async (parts: string[]) =>
    parts.join('').includes('FROM webhook_endpoints')
      ? [{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', company_id: COMPANY, name: 'w', url: 'https://hook.test/x',
          secret: null, events: ['invoice.sent'], is_active: true, created_at: new Date() }]
      : []);
  // Resolves a tick later, so a floating body cannot finish inside the await.
  m.safeFetch.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return { status: 200, ok: true, text: async () => 'ok' };
  });
});

describe('fireWebhook', () => {
  it('has issued its post-fetch writes by the time it resolves', async () => {
    await fireWebhook(COMPANY, 'invoice.sent', { invoiceId: 'i1' });
    expect(statements().some((s) => s.includes('INSERT INTO webhook_deliveries'))).toBe(true);
    expect(statements().some((s) => s.includes('UPDATE webhook_endpoints'))).toBe(true);
  });

  it('binds the tenant into the endpoint update, not the derived id alone', async () => {
    await fireWebhook(COMPANY, 'invoice.sent', { invoiceId: 'i1' });
    // The drained callback runs on the pool's role with no RLS, so the UPDATE
    // must carry the company itself — checked on the bound VALUES, not the text.
    const call = m.sql.mock.calls.find((c) => (c[0] as string[]).join('').includes('UPDATE webhook_endpoints'))!;
    expect(call.slice(1)).toContain(COMPANY);
  });

  it('still never throws to the caller', async () => {
    m.safeFetch.mockRejectedValue(new Error('endpoint down'));
    await expect(fireWebhook(COMPANY, 'invoice.sent', {})).resolves.toBeUndefined();
  });
});
