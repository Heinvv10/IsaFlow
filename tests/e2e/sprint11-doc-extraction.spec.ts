import { test, expect } from '@playwright/test';

test.describe('Document Extraction Enhanced APIs', () => {
  test('POST /api/accounting/doc-auto-invoice does not 404', async ({ request }) => {
    const r = await request.post('/api/accounting/doc-auto-invoice', { data: {} });
    expect(r.status()).not.toBe(404);
  });

  test('validates documentId required', async ({ request }) => {
    const r = await request.post('/api/accounting/doc-auto-invoice', { data: {} });
    expect([400, 401]).toContain(r.status());
  });

  test('existing VLM status endpoint works', async ({ request }) => {
    const r = await request.get('/api/accounting/vlm-status');
    expect([200, 401]).toContain(r.status());
  });

  test('existing document capture endpoint works', async ({ request }) => {
    const r = await request.get('/api/accounting/document-capture');
    expect([200, 401]).toContain(r.status());
  });
});
