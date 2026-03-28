import { test, expect } from '@playwright/test';

test.describe('AI Forecast API', () => {
  test('POST /api/accounting/ai-forecast does not 404', async ({ request }) => {
    const r = await request.post('/api/accounting/ai-forecast', { data: {} });
    expect(r.status()).not.toBe(404);
  });

  test('returns scenarios with base data', async ({ request }) => {
    const r = await request.post('/api/accounting/ai-forecast', {
      data: { baseRevenue: 100000, baseExpenses: 70000, cashBalance: 200000, months: 3 },
    });
    expect([200, 401]).toContain(r.status());
    if (r.status() === 200) {
      const json = await r.json();
      expect(json.success).toBe(true);
      expect(json.data.scenarios.base.points.length).toBe(3);
      expect(json.data.scenarios.optimistic).toBeDefined();
      expect(json.data.scenarios.pessimistic).toBeDefined();
    }
  });

  test('returns weekly forecast when requested', async ({ request }) => {
    const r = await request.post('/api/accounting/ai-forecast', {
      data: { baseRevenue: 100000, baseExpenses: 70000, cashBalance: 200000, months: 3, weeklyMode: true },
    });
    expect([200, 401]).toContain(r.status());
    if (r.status() === 200) {
      const json = await r.json();
      expect(json.data.weekly).toBeDefined();
      expect(json.data.weekly.weeks.length).toBe(13);
    }
  });
});
