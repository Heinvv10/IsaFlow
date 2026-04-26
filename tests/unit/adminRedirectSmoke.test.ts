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
});
