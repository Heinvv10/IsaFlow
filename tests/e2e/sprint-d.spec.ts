/**
 * Sprint D: AI Invoice Pipeline + Receipt-to-Journal E2E Tests
 */
import { test, expect } from '@playwright/test';

test.describe('AI Invoice Pipeline API', () => {
  test('POST /api/accounting/ai-invoice-pipeline responds', async ({ request }) => {
    const res = await request.post('/api/accounting/ai-invoice-pipeline', {
      data: { documentId: '00000000-0000-0000-0000-000000000000' },
    });
    expect([200, 400, 401, 404]).toContain(res.status());
  });
});

test.describe('Receipt-to-Journal API', () => {
  test('POST /api/accounting/receipt-to-journal responds', async ({ request }) => {
    const res = await request.post('/api/accounting/receipt-to-journal', {
      data: { documentId: '00000000-0000-0000-0000-000000000000' },
    });
    expect([200, 400, 401, 404]).toContain(res.status());
  });
});
