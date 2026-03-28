import { test, expect } from '@playwright/test';

test.describe('AI Categorization API', () => {
  test('POST /api/accounting/ai-categorize does not 404', async ({ request }) => {
    const response = await request.post('/api/accounting/ai-categorize', { data: {} });
    expect(response.status()).not.toBe(404);
  });

  test('validates description is required', async ({ request }) => {
    const r = await request.post('/api/accounting/ai-categorize', {
      data: { amount: -500 },
    });
    expect([400, 401]).toContain(r.status());
  });

  test('accepts valid categorization request', async ({ request }) => {
    const r = await request.post('/api/accounting/ai-categorize', {
      data: {
        description: 'WOOLWORTHS SANDTON',
        amount: -1250,
        date: '2026-03-15',
      },
    });
    expect([200, 401]).toContain(r.status());
    if (r.status() === 200) {
      const json = await r.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty('strategyUsed');
      expect(json.data).toHaveProperty('confidenceLevel');
    }
  });
});
