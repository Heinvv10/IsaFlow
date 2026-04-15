// tests/unit/sentry/tags.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const setTag = vi.fn();
const setUser = vi.fn();

vi.mock('@sentry/nextjs', () => ({
  setTag: (...args: unknown[]) => setTag(...args),
  setUser: (...args: unknown[]) => setUser(...args),
}));

import { setTenantTags, sanitizeRoute } from '@/lib/sentry/tags';

describe('setTenantTags', () => {
  beforeEach(() => {
    setTag.mockReset();
    setUser.mockReset();
    process.env.SENTRY_ENABLED = 'true';
  });

  it('sets company_id, user_id, request_id, and route tags when all provided', () => {
    setTenantTags({ companyId: 'c-1', userId: 'u-1', requestId: 'r-1', route: '/api/x' });
    expect(setTag).toHaveBeenCalledWith('company_id', 'c-1');
    expect(setTag).toHaveBeenCalledWith('request_id', 'r-1');
    expect(setTag).toHaveBeenCalledWith('route', '/api/x');
    expect(setUser).toHaveBeenCalledWith({ id: 'u-1' });
  });

  it('skips fields that are undefined', () => {
    setTenantTags({ requestId: 'r-2' });
    expect(setTag).toHaveBeenCalledWith('request_id', 'r-2');
    expect(setTag).not.toHaveBeenCalledWith('company_id', expect.anything());
    expect(setUser).not.toHaveBeenCalled();
  });

  it('is a no-op when SENTRY_ENABLED is not true', () => {
    process.env.SENTRY_ENABLED = 'false';
    setTenantTags({ companyId: 'c-1' });
    expect(setTag).not.toHaveBeenCalled();
  });
});

describe('sanitizeRoute', () => {
  it('sanitizeRoute strips query string', () => {
    expect(sanitizeRoute('/api/x')).toBe('/api/x');
    expect(sanitizeRoute('/api/x?foo=bar&baz=1')).toBe('/api/x');
    expect(sanitizeRoute(undefined)).toBeUndefined();
  });
});
