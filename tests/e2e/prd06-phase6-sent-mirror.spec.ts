import { test, expect } from '@playwright/test';

/**
 * PRD-06 Phase 6 — Sent-folder mirror
 *
 * Exit criteria (docs/prd/PRD-06-ar-evidence-capture.md §7.2 Phase 6):
 *   connect Gmail sent folder; an invoice emailed outside the app links
 *   back to the snapshot automatically.
 *
 * Prod-safe: never creates a real IMAP connection, never scans, never
 * stores credentials. Exercises the public API surface + the auth/cron
 * guard shape.
 */

test.describe('PRD-06 Phase 6 — sent-folder mirror', () => {
  test('connections endpoint returns list shape', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const res = await request.get('/api/accounting/ar/sent-mirror/connections');
    test.skip(res.status() === 401, 'requires logged-in session');
    expect(res.status(), 'connections list status').toBe(200);

    const json = await res.json();
    const items = (json?.data?.items as Array<Record<string, unknown>> | undefined) ?? [];
    expect(Array.isArray(items), 'items is array').toBe(true);

    for (const c of items) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('accountEmail');
      expect(c).toHaveProperty('sentFolder');
      expect(c).toHaveProperty('status');
      expect(['active', 'disconnected', 'error']).toContain(c.status);
      expect(c).toHaveProperty('messagesCapturedTotal');
      expect(c).toHaveProperty('messagesLinkedTotal');
    }
  });

  test('POST rejects missing credentials with 400', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const res = await request.post('/api/accounting/ar/sent-mirror/connections', {
      data: { displayName: 'Bad' },
    });
    test.skip(res.status() === 401, 'requires logged-in session');
    expect(res.status(), 'incomplete body → 400').toBe(400);
  });

  test('cron endpoint rejects unauthorised', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const res = await request.post('/api/cron/sent-mirror-scan', {
      headers: { 'x-cron-secret': 'definitely-wrong-value' },
    });
    expect([401, 500]).toContain(res.status()); // 500 if CRON_SECRET unset, 401 if mismatched
  });

  test('cron endpoint rejects GET', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const res = await request.get('/api/cron/sent-mirror-scan');
    expect(res.status(), 'GET not allowed').toBe(405);
  });
});
