/**
 * Regression specs for the P3.3 web-analytics eternal-spinner fix
 * (pages/admin/web-analytics.tsx): when the website list loads EMPTY or the
 * load FAILS, `websiteId` never gets set, so loadSummary's `if (!websiteId)
 * return` guard never runs — pre-fix, `loading` (initialised true) was never
 * cleared and the page spun forever.
 *
 * Admin pages are only served on the admin host (middleware redirects
 * /admin/* elsewhere on app hosts), so the spec maps admin.isaflow.co.za to
 * the local server via Chromium host-resolver rules and satisfies the edge
 * cookie-presence gate with a dummy sb-access-token; real auth is mocked at
 * /api/auth/me (AdminLayout's client-side super_admin check).
 *
 * Fully route-mocked — no login or seeded data needed:
 *   BASE_URL=http://127.0.0.1:3200 bunx playwright test tests/e2e/web-analytics-empty-spinner.spec.ts --config playwright-standalone.config.ts
 */
import { test, expect, type Page } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--host-resolver-rules=MAP admin.isaflow.co.za 127.0.0.1',
      '--unsafely-treat-insecure-origin-as-secure=http://admin.isaflow.co.za:3457',
      '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,LocalNetworkAccessChecks',
    ],
  },
});

function adminUrl(baseURL: string, path: string): string {
  const port = new URL(baseURL).port || '80';
  return `http://admin.isaflow.co.za:${port}${path}`;
}

async function mockAdminSession(page: Page): Promise<void> {
  // The app sends CSP `upgrade-insecure-requests` on every response; on a
  // non-localhost http host Chromium then upgrades all _next chunks to
  // https, which the plain-http dev server can't speak. Strip the header
  // from the DOCUMENT so the page can hydrate in the drill environment.
  await page.route('**/web-analytics', async (route) => {
    const url = new URL(route.request().url());
    const port = url.port;
    url.hostname = '127.0.0.1';
    const resp = await route.fetch({
      url: url.toString(),
      headers: { ...route.request().headers(), host: `admin.isaflow.co.za:${port}` },
    });
    const headers = { ...resp.headers() };
    delete headers['content-security-policy'];
    await route.fulfill({ response: resp, headers });
  });
  // Edge middleware only checks cookie PRESENCE for admin page navigation;
  // role enforcement is client-side (AdminLayout) + per-API (withAdmin).
  await page.context().addCookies([
    {
      name: 'sb-access-token',
      value: 'e2e-dummy-token',
      domain: 'admin.isaflow.co.za',
      path: '/',
    },
  ]);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          user: {
            id: '00000000-0000-0000-0000-00000000e2e0',
            email: 'drill@example.com',
            role: 'super_admin',
            first_name: 'Drill',
            last_name: 'Admin',
          },
        },
      }),
    }),
  );
}

test('zero websites clears the loading spinner instead of spinning forever', async ({
  page,
  baseURL,
}) => {
  await mockAdminSession(page);
  await page.route('**/api/admin/analytics/web/websites', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { websites: [] } }),
    }),
  );

  await page.goto(adminUrl(baseURL!, '/web-analytics'));

  // Pre-fix: the loader animation never went away. Post-fix the page settles
  // (loading cleared) even though there is nothing to select.
  await expect(page.locator('.animate-spin')).toHaveCount(0, { timeout: 10_000 });
});

test('failed website load surfaces an error instead of spinning forever', async ({
  page,
  baseURL,
}) => {
  await mockAdminSession(page);
  await page.route('**/api/admin/analytics/web/websites', (route) =>
    route.abort('connectionfailed'),
  );

  await page.goto(adminUrl(baseURL!, '/web-analytics'));

  await expect(page.getByText(/failed to load websites/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.animate-spin')).toHaveCount(0);
});
