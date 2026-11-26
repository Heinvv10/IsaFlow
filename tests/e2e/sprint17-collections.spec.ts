import { test, expect } from '@playwright/test';
import { guardDevTarget } from './helpers/devTarget';

guardDevTarget(test);
test.describe('Smart Reminder API', () => {
  test('POST /api/accounting/smart-reminder does not 404', async ({ request }) => {
    const r = await request.post('/api/accounting/smart-reminder', { data: {} });
    expect(r.status()).not.toBe(404);
  });
  test('validates customerId', async ({ request }) => {
    const r = await request.post('/api/accounting/smart-reminder', { data: {} });
    expect([400, 401]).toContain(r.status());
  });
});
