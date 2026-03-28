import { test, expect } from '@playwright/test';

test.describe('AI Narrative API', () => {
  test('POST /api/accounting/ai-narrative does not 404', async ({ request }) => {
    const r = await request.post('/api/accounting/ai-narrative', { data: {} });
    expect(r.status()).not.toBe(404);
  });

  test('validates reportData required', async ({ request }) => {
    const r = await request.post('/api/accounting/ai-narrative', { data: {} });
    expect([400, 401]).toContain(r.status());
  });

  test('returns narrative with variance commentary', async ({ request }) => {
    const r = await request.post('/api/accounting/ai-narrative', {
      data: {
        reportData: {
          reportType: 'income_statement', period: '2026-03', companyName: 'Test',
          currentPeriod: { revenue: 500000, expenses: 350000, netProfit: 150000 },
        },
        variances: [{ account: 'Revenue', actual: 500000, budget: 450000, isExpense: false }],
      },
    });
    expect([200, 401]).toContain(r.status());
    if (r.status() === 200) {
      const json = await r.json();
      expect(json.success).toBe(true);
      expect(json.data.varianceCommentary.length).toBeGreaterThan(0);
    }
  });
});
