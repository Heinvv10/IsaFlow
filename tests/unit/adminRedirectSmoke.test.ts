import { describe, expect, it } from 'vitest';
import { getAdminRedirectBase } from '../../middleware';

describe('production admin redirect smoke', () => {
  const localAdminUrls = [
    'http://localhost:3200',
    'http://127.0.0.1:3200',
    'http://[::1]:3200',
  ];

  it.each(localAdminUrls)(
    'falls back to the canonical admin host when NEXT_PUBLIC_ADMIN_URL is %s',
    configuredAdminUrl => {
      const redirectUrl = new URL(
        '/companies',
        getAdminRedirectBase(configuredAdminUrl, 'production'),
      );

      expect(redirectUrl.origin).toBe('https://admin.isaflow.co.za');
      expect(['localhost', '127.0.0.1', '::1']).not.toContain(redirectUrl.hostname);
    },
  );

  it('uses the canonical admin host when production config is malformed', () => {
    expect(getAdminRedirectBase('not-a-url', 'production')).toBe('https://admin.isaflow.co.za');
  });

  it('passes through a correctly configured production URL unchanged', () => {
    expect(getAdminRedirectBase('https://admin.isaflow.co.za', 'production')).toBe('https://admin.isaflow.co.za');
  });

  it('falls back to canonical when production URL has wrong hostname', () => {
    expect(getAdminRedirectBase('https://admin.isaflow.com.za', 'production')).toBe('https://admin.isaflow.co.za');
  });

  it('returns the configured URL unchanged in non-production environments', () => {
    expect(getAdminRedirectBase('http://localhost:3200', 'development')).toBe('http://localhost:3200');
    expect(getAdminRedirectBase('http://localhost:3200', 'test')).toBe('http://localhost:3200');
  });
});
