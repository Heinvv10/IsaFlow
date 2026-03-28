import { test, expect } from '@playwright/test';

test.describe('EFT API routes respond', () => {
  test('POST /api/accounting/eft-generate does not 404', async ({ request }) => {
    const response = await request.post('/api/accounting/eft-generate', { data: {} });
    expect(response.status()).not.toBe(404);
  });

  test('POST /api/accounting/eft-generate validates batchId', async ({ request }) => {
    const response = await request.post('/api/accounting/eft-generate', {
      data: { bank: 'fnb' },
    });
    expect([400, 401]).toContain(response.status());
  });

  test('POST /api/accounting/eft-generate validates bank', async ({ request }) => {
    const response = await request.post('/api/accounting/eft-generate', {
      data: { batchId: 'test-123', bank: 'invalid_bank' },
    });
    expect([400, 401]).toContain(response.status());
  });
});
