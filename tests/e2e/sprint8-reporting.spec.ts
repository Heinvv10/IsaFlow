import { test, expect } from '@playwright/test';

test.describe('Reporting Engine API routes', () => {
  for (const route of ['/api/accounting/reports-ratios', '/api/accounting/reports-management-pack']) {
    test(`GET ${route} does not 404`, async ({ request }) => {
      const response = await request.get(route);
      expect(response.status()).not.toBe(404);
    });
  }
});

test.describe('Financial Ratios API', () => {
  test('returns ratio data', async ({ request }) => {
    const r = await request.get('/api/accounting/reports-ratios');
    expect([200, 401]).toContain(r.status());
    if (r.status() === 200) {
      const json = await r.json();
      expect(json.success).toBe(true);
      expect(json.data.ratios).toBeDefined();
    }
  });
});

test.describe('Management Pack API', () => {
  test('returns pack data', async ({ request }) => {
    const r = await request.get('/api/accounting/reports-management-pack?period=2026-03');
    expect([200, 401]).toContain(r.status());
    if (r.status() === 200) {
      const json = await r.json();
      expect(json.success).toBe(true);
      expect(json.data.sections).toBeDefined();
    }
  });
});
