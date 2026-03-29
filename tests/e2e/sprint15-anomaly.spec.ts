import { test, expect } from '@playwright/test';

test.describe('Anomaly Detection API', () => {
  test('POST /api/accounting/anomaly-scan does not 404', async ({ request }) => {
    const r = await request.post('/api/accounting/anomaly-scan', { data: {} });
    expect(r.status()).not.toBe(404);
  });

  test('returns scan results', async ({ request }) => {
    const r = await request.post('/api/accounting/anomaly-scan', { data: { period: '2026-01-01' } });
    expect([200, 401]).toContain(r.status());
    if (r.status() === 200) {
      const json = await r.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty('benfords');
      expect(json.data).toHaveProperty('alerts');
      expect(json.data).toHaveProperty('scannedTransactions');
    }
  });
});
