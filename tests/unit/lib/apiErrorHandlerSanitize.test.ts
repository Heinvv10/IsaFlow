/**
 * Request-body log scrubber — Gate B CRIT: /api/oauth/token logged raw
 * client_secret + refresh_token because SENSITIVE_KEYS exact-matched and
 * missed those field names.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@sentry/nextjs', () => ({
  withIsolationScope: vi.fn((cb: () => unknown) => cb()),
  setTag: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  apiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/observability/requestContext', () => ({
  runWithRequestContext: vi.fn((_id: string, fn: () => unknown) => fn()),
  generateRequestId: vi.fn(() => 'req-1'),
}));
vi.mock('@/lib/observability/requestLogger', () => ({ logRequestCompleted: vi.fn() }));
vi.mock('@/lib/sentry/tags', () => ({ setTenantTags: vi.fn(), sanitizeRoute: vi.fn((r: string) => r) }));
vi.mock('@/lib/cors', () => ({ safeCorsOrigin: vi.fn(() => null) }));

import { __sanitizeBodyForTest as sanitizeBody } from '@/lib/api-error-handler';

describe('sanitizeBody — credential redaction', () => {
  it('redacts OAuth token-endpoint credentials that exact-matching previously missed', () => {
    const out = sanitizeBody({
      grant_type: 'refresh_token',
      client_id: 'client_abc',        // NOT secret — keep
      client_secret: 'cls_supersecret',
      refresh_token: 'ort_livetoken',
      code_verifier: 'pkce-verifier',
      access_token: 'oat_access',
    }) as Record<string, unknown>;

    expect(out.client_id).toBe('client_abc');
    expect(out.grant_type).toBe('refresh_token');
    for (const k of ['client_secret', 'refresh_token', 'code_verifier', 'access_token']) {
      expect(out[k]).toBe('[REDACTED]');
    }
  });

  it('still redacts the original sensitive keys and camelCase variants', () => {
    const out = sanitizeBody({
      password: 'p', token: 't', secret: 's', apiKey: 'a',
      clientSecret: 'cls_x', refreshToken: 'ort_x',
    }) as Record<string, unknown>;
    for (const k of ['password', 'token', 'secret', 'apiKey', 'clientSecret', 'refreshToken']) {
      expect(out[k]).toBe('[REDACTED]');
    }
  });

  it('does NOT over-redact benign fields (incl. a bare single-use "code")', () => {
    const out = sanitizeBody({
      code: 'oac_singleuse', country_code: 'ZA', currency_code: 'ZAR', invoice_number: 'INV-1',
    }) as Record<string, unknown>;
    expect(out.code).toBe('oac_singleuse'); // single-use, intentionally not redacted
    expect(out.country_code).toBe('ZA');
    expect(out.currency_code).toBe('ZAR');
    expect(out.invoice_number).toBe('INV-1');
  });
});
