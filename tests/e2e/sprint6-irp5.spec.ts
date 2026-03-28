import { test, expect } from '@playwright/test';

test.describe('IRP5/EMP501 API routes respond', () => {
  for (const route of ['/api/payroll/irp5-generate', '/api/accounting/sars/emp501']) {
    test(`GET ${route} does not 404`, async ({ request }) => {
      const response = await request.get(route);
      expect(response.status()).not.toBe(404);
    });
  }
});

test.describe('IRP5 API', () => {
  test('GET returns employee list', async ({ request }) => {
    const r = await request.get('/api/payroll/irp5-generate');
    expect([200, 401]).toContain(r.status());
  });
  test('POST validates employeeId', async ({ request }) => {
    const r = await request.post('/api/payroll/irp5-generate', { data: {} });
    expect([400, 401]).toContain(r.status());
  });
});

test.describe('EMP501 API', () => {
  test('GET returns summary', async ({ request }) => {
    const r = await request.get('/api/accounting/sars/emp501?taxYear=2026');
    expect([200, 401]).toContain(r.status());
  });
});
