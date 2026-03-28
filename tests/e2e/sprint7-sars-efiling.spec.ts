import { test, expect } from '@playwright/test';

test.describe('SARS e-Filing API routes', () => {
  for (const route of ['/api/accounting/sars/compliance-calendar', '/api/accounting/sars/irp6', '/api/accounting/sars/emp501']) {
    test(`GET ${route} does not 404`, async ({ request }) => {
      const response = await request.get(route);
      expect(response.status()).not.toBe(404);
    });
  }
});

test.describe('Compliance Calendar API', () => {
  test('returns deadlines for year', async ({ request }) => {
    const r = await request.get('/api/accounting/sars/compliance-calendar?year=2026');
    expect([200, 401]).toContain(r.status());
    if (r.status() === 200) {
      const json = await r.json();
      expect(json.success).toBe(true);
      expect(json.data.deadlines.length).toBeGreaterThan(0);
    }
  });
});

test.describe('IRP6 API', () => {
  test('POST generates provisional tax estimate', async ({ request }) => {
    const r = await request.post('/api/accounting/sars/irp6', {
      data: { taxYear: 2026, period: 1, taxableIncome: 500000 },
    });
    expect([200, 401]).toContain(r.status());
  });
});
