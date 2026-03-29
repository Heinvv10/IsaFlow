import { test, expect } from '@playwright/test';
test.describe('Month-End Close API', () => {
  test('GET does not 404', async ({ request }) => { expect((await request.get('/api/accounting/month-end-close')).status()).not.toBe(404); });
  test('returns checklist', async ({ request }) => {
    const r = await request.get('/api/accounting/month-end-close');
    expect([200, 401]).toContain(r.status());
    if (r.status() === 200) { const j = await r.json(); expect(j.data.checklist.length).toBeGreaterThan(0); }
  });
});
