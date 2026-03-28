import { test, expect } from '@playwright/test';

test.describe('NL Query API', () => {
  test('POST /api/accounting/nl-query does not 404', async ({ request }) => {
    const r = await request.post('/api/accounting/nl-query', { data: {} });
    expect(r.status()).not.toBe(404);
  });

  test('validates question required', async ({ request }) => {
    const r = await request.post('/api/accounting/nl-query', { data: { question: '' } });
    expect([400, 401]).toContain(r.status());
  });

  test('accepts valid question', async ({ request }) => {
    const r = await request.post('/api/accounting/nl-query', {
      data: { question: 'What is the total revenue?' },
    });
    expect([200, 401]).toContain(r.status());
    if (r.status() === 200) {
      const json = await r.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty('intent');
    }
  });
});
